import type { EventEnvelope } from '@pp/contracts';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { verifySignatureHeader } from '../src/delivery/signing';
import { Receiver } from './receiver';
import { MAX_ATTEMPTS, startTestApp, type TestApp } from './test-app';

let t: TestApp;
const receiver = new Receiver();
const http = () => request(t.url);

const event = (type = 'payment.status_changed'): EventEnvelope<string, unknown> => ({
  id: randomUUID(),
  type,
  occurredAt: new Date().toISOString(),
  payload: { paymentId: randomUUID(), status: 'captured' },
});

async function subscribe(eventTypes: string[], url = receiver.url) {
  const res = await http().post('/webhooks').send({ url, eventTypes }).expect(201);
  return res.body as { id: string; secret: string };
}

const deliveriesOf = (eventId: string) =>
  t.dataSource.query(
    `SELECT status, attempts, last_status_code AS "lastStatusCode" FROM webhook_deliveries
     WHERE event_id = $1 ORDER BY created_at`,
    [eventId],
  ) as Promise<{ status: string; attempts: number; lastStatusCode: number | null }[]>;

/** Прогоняет воркер, пока есть работа; паузы нужны, чтобы дождаться созревания backoff. */
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await t.worker.runOnce();
    await new Promise((r) => setTimeout(r, 30));
  }
}

beforeAll(async () => {
  await receiver.start();
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
  await receiver.stop();
});
beforeEach(async () => {
  receiver.reset();
  await t.dataSource.query(`TRUNCATE webhook_deliveries, inbox_events, webhook_endpoints CASCADE`);
});

describe('подписки', () => {
  it('возвращает секрет только при создании', async () => {
    const created = await subscribe(['*']);
    expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const list = (await http().get('/webhooks').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('secret');
  });

  it('валидирует вход', async () => {
    await http()
      .post('/webhooks')
      .send({ url: 'not a url', eventTypes: ['*'] })
      .expect(400);
    await http().post('/webhooks').send({ url: receiver.url, eventTypes: [] }).expect(400);
    await http()
      .post('/webhooks')
      .send({ url: receiver.url, eventTypes: ['wallet.nope'] })
      .expect(400);
    await http().delete(`/webhooks/${randomUUID()}`).expect(404);
  });
});

describe('доставка', () => {
  it('доставляет событие с валидной подписью и заголовками', async () => {
    const { secret } = await subscribe(['payment.status_changed']);
    const ev = event();

    expect(await t.ingest.ingest(ev)).toBe(1);
    await drain(1);

    expect(receiver.requests).toHaveLength(1);
    const [req] = receiver.requests;
    expect(JSON.parse(req!.body)).toEqual(ev);
    expect(req!.headers['x-pp-event-id']).toBe(ev.id);
    expect(req!.headers['x-pp-event-type']).toBe(ev.type);
    expect(
      verifySignatureHeader(
        secret,
        String(req!.headers['x-pp-signature']),
        req!.body,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(true);
    expect(await deliveriesOf(ev.id)).toEqual([
      { status: 'delivered', attempts: 1, lastStatusCode: 200 },
    ]);
  });

  it('дубликат события из брокера не создаёт вторую доставку', async () => {
    await subscribe(['*']);
    const ev = event();

    expect(await t.ingest.ingest(ev)).toBe(1);
    expect(await t.ingest.ingest(ev)).toBe(0);
    await drain(2);

    expect(receiver.requests).toHaveLength(1);
  });

  it('параллельный приём одного события тоже даёт одну доставку', async () => {
    await subscribe(['*']);
    const ev = event();

    const counts = await Promise.all(Array.from({ length: 6 }, () => t.ingest.ingest(ev)));

    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('фильтрует по типам событий и поддерживает *', async () => {
    await subscribe(['wallet.hold.created']);
    await subscribe(['*']);

    expect(await t.ingest.ingest(event('payment.status_changed'))).toBe(1);
    expect(await t.ingest.ingest(event('wallet.hold.created'))).toBe(2);
  });

  it('повторяет доставку при ошибках получателя и в итоге доставляет', async () => {
    await subscribe(['*']);
    const ev = event();
    receiver.statuses = [500, 503];

    await t.ingest.ingest(ev);
    await drain();

    expect(receiver.requests).toHaveLength(3);
    expect(receiver.requests.map((r) => r.headers['x-pp-delivery-attempt'])).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(await deliveriesOf(ev.id)).toEqual([
      { status: 'delivered', attempts: 3, lastStatusCode: 200 },
    ]);
  });

  it('после исчерпания попыток помечает dead, а ручной retry доставляет', async () => {
    await subscribe(['*']);
    const ev = event();
    receiver.statuses = Array(MAX_ATTEMPTS).fill(500);

    await t.ingest.ingest(ev);
    await drain();

    expect(receiver.requests).toHaveLength(MAX_ATTEMPTS);
    const [dead] = await deliveriesOf(ev.id);
    expect(dead).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, lastStatusCode: 500 });

    const list = (await http().get('/deliveries?status=dead').expect(200)).body;
    expect(list).toHaveLength(1);

    await http().post(`/deliveries/${list[0].id}/retry`).expect(200);
    await drain(2);

    expect(await deliveriesOf(ev.id)).toEqual([
      { status: 'delivered', attempts: 1, lastStatusCode: 200 },
    ]);
  });

  it('retry разрешён только для dead', async () => {
    await subscribe(['*']);
    const ev = event();
    await t.ingest.ingest(ev);
    await drain(1);

    const [{ id }] = await t.dataSource.query(
      `SELECT id FROM webhook_deliveries WHERE event_id = $1`,
      [ev.id],
    );
    const res = await http().post(`/deliveries/${id}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DELIVERY_STATE_CONFLICT');
  });

  it('недоступный получатель не блокирует доставку остальным', async () => {
    await subscribe(['*'], 'http://127.0.0.1:1/unreachable');
    await subscribe(['*']);
    const ev = event();

    await t.ingest.ingest(ev);
    await drain(1);

    expect(receiver.requests).toHaveLength(1);
    const rows = await deliveriesOf(ev.id);
    expect(rows.map((r) => r.status).sort()).toEqual(['delivered', 'pending']);
  });

  it('не следует редиректам (защита от SSRF)', async () => {
    await subscribe(['*']);
    const ev = event();
    receiver.statuses = [302];

    await t.ingest.ingest(ev);
    await drain(1);

    expect(await deliveriesOf(ev.id)).toEqual([
      { status: 'pending', attempts: 1, lastStatusCode: 302 },
    ]);
  });

  it('удаление подписки убирает её недоставленные события', async () => {
    const { id } = await subscribe(['*']);
    await t.ingest.ingest(event());
    await http().delete(`/webhooks/${id}`).expect(204);

    await drain(1);
    expect(receiver.requests).toHaveLength(0);
  });
});

describe('health', () => {
  it('отвечает ok', async () => {
    expect((await http().get('/health').expect(200)).body).toEqual({ status: 'ok' });
  });
});
