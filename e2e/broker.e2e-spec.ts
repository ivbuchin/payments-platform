import { EVENTS_EXCHANGE, type EventEnvelope } from '../libs/contracts/src';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { AmqpConsumer } from '../apps/notifications-service/src/messaging/amqp-consumer';
import type { EventIngestService } from '../apps/notifications-service/src/messaging/event-ingest.service';
import { AmqpPublisher } from '../libs/outbox/src/amqp-publisher';

/**
 * Поведение на стыке с брокером: потеря «подтверждённых» событий и молчаливая смерть подписки —
 * именно то, что ломает at-least-once незаметно.
 */

let mq: StartedRabbitMQContainer;
let publisher: AmqpPublisher;

const event = (): EventEnvelope<string, unknown> => ({
  id: randomUUID(),
  type: 'payment.status_changed',
  occurredAt: new Date().toISOString(),
  payload: { paymentId: randomUUID(), status: 'captured' },
});

async function eventually<T>(probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  mq = await new RabbitMQContainer('rabbitmq:4-management-alpine').start();
  publisher = new AmqpPublisher(mq.getAmqpUrl());
});
afterAll(async () => {
  await publisher.close();
  await mq.stop();
});

describe('AmqpPublisher', () => {
  it('отвергает событие, которое не попало ни в одну очередь, и принимает после появления очереди', async () => {
    const lost = event();
    await expect(publisher.publish(lost)).rejects.toThrow(/не маршрутизировано/);

    const connection = await connect(mq.getAmqpUrl());
    const channel = await connection.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue('probe', { durable: true });
    await channel.bindQueue('probe', EVENTS_EXCHANGE, 'payment.status_changed');

    const routed = event();
    await expect(publisher.publish(routed)).resolves.toBeUndefined();
    const message = await channel.get('probe', { noAck: true });
    expect(message && JSON.parse(message.content.toString()).id).toBe(routed.id);
    await channel.deleteQueue('probe'); // иначе очередь перехватывает события следующих тестов
    await connection.close();
  });
});

describe('AmqpConsumer', () => {
  it('переживает удаление очереди и не теряет последующие события', async () => {
    const seen: string[] = [];
    const ingest = {
      ingest: async (e: EventEnvelope<string, unknown>) => {
        seen.push(e.id);
        return 1;
      },
    } as unknown as EventIngestService;
    const consumer = new AmqpConsumer(mq.getAmqpUrl(), ingest);
    consumer.onApplicationBootstrap();
    try {
      const first = event();
      await publishWhenRouted(first);
      await eventually(() => (seen.includes(first.id) ? true : undefined));

      // Брокер отменяет подписку: очередь удалена вручную.
      const connection = await connect(mq.getAmqpUrl());
      const channel = await connection.createChannel();
      await channel.deleteQueue('notifications.events');
      await connection.close();

      const second = event();
      await publishWhenRouted(second);
      await eventually(() => (seen.includes(second.id) ? true : undefined));
    } finally {
      await consumer.onApplicationShutdown();
    }
  });

  it('повторяет обработку после временного сбоя и в итоге доставляет событие', async () => {
    let failures = 2;
    const calls: string[] = [];
    const ingest = {
      ingest: async (e: EventEnvelope<string, unknown>) => {
        calls.push(e.id);
        if (failures-- > 0) throw new Error('БД недоступна');
        return 1;
      },
    } as unknown as EventIngestService;
    const consumer = new AmqpConsumer(mq.getAmqpUrl(), ingest);
    consumer.onApplicationBootstrap();
    try {
      const ev = event();
      await publishWhenRouted(ev);
      await eventually(() => (calls.filter((id) => id === ev.id).length >= 3 ? true : undefined));
      expect(failures).toBe(-1);
    } finally {
      await consumer.onApplicationShutdown();
    }
  });
});

/** Пока потребитель не объявил очередь, mandatory-публикация отклоняется — ждём маршрута. */
async function publishWhenRouted(ev: EventEnvelope<string, unknown>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await publisher.publish(ev);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
