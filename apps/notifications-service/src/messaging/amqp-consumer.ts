import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EVENTS_EXCHANGE, EVENT_TYPES } from '@pp/contracts';
import { connect, type ChannelModel, type Channel, type ConsumeMessage } from 'amqplib';
import { parseEnvelope } from './event-envelope';
import { EventIngestService } from './event-ingest.service';

const QUEUE = 'notifications.events';
const DLX = 'pp.events.dlx';
const DLQ = `${QUEUE}.dlq`;
const PREFETCH = 20;
const RECONNECT_DELAY_MS = 2000;
const REQUEUE_DELAY_MS = 1000;

/**
 * Потребитель событий платформы.
 *  - Невалидное («ядовитое») сообщение отклоняется без requeue и попадает в DLQ.
 *  - Временный сбой обработки (например, недоступна БД) — nack с requeue после паузы.
 *  - Дубликаты безопасны: дедупликация в `EventIngestService`.
 *  - Обрыв соединения — переподключение с повторной декларацией топологии.
 */
export class AmqpConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AmqpConsumer.name);
  private connection?: ChannelModel;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly ingest: EventIngestService,
  ) {}

  onApplicationBootstrap(): void {
    void this.connectLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    await this.connection?.close().catch(() => undefined);
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const connection = await connect(this.url);
      this.connection = connection;
      connection.on('error', (error: unknown) => this.logger.warn(`AMQP: ${String(error)}`));
      connection.on('close', () => this.scheduleReconnect());
      await this.setup(await connection.createChannel());
      this.logger.log(`Подписан на очередь ${QUEUE}`);
    } catch (error) {
      this.logger.warn(`Не удалось подключиться к RabbitMQ: ${String(error)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectLoop();
    }, RECONNECT_DELAY_MS);
  }

  private async setup(channel: Channel): Promise<void> {
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DLX, 'fanout', { durable: true });
    await channel.assertQueue(DLQ, { durable: true });
    await channel.bindQueue(DLQ, DLX, '');
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DLX });
    for (const type of EVENT_TYPES) await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, type);
    await channel.prefetch(PREFETCH);
    await channel.consume(QUEUE, (message) => {
      if (message) void this.handle(channel, message);
    });
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    const event = parseEnvelope(message.content);
    if (!event) {
      this.logger.error(`Невалидное сообщение отправлено в DLQ: ${message.properties.messageId}`);
      channel.reject(message, false);
      return;
    }
    try {
      await this.ingest.ingest(event);
      channel.ack(message);
    } catch (error) {
      this.logger.warn(`Сбой обработки ${event.id}, вернём в очередь: ${String(error)}`);
      setTimeout(() => {
        try {
          channel.nack(message, false, true);
        } catch {
          /* канал закрыт — брокер сам вернёт сообщение в очередь */
        }
      }, REQUEUE_DELAY_MS);
    }
  }
}
