import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EVENTS_EXCHANGE, EVENT_TYPES } from '@pp/contracts';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { parseEnvelope } from './event-envelope';
import { EventIngestService } from './event-ingest.service';

const QUEUE = 'notifications.events';
const DLX = 'pp.events.dlx';
const DLQ = `${QUEUE}.dlq`;
const PREFETCH = 20;
const RECONNECT_DELAY_MS = 2000;
const RETRY_BASE_DELAY_MS = 1000;
/** После стольких неудачных обработок сообщение уходит в DLQ, а не крутится вечно. */
const MAX_ATTEMPTS = 5;
const ATTEMPTS_HEADER = 'x-attempts';

/**
 * Потребитель событий платформы.
 *  - Невалидное («ядовитое») сообщение отклоняется без requeue и попадает в DLQ.
 *  - Временный сбой обработки (например, недоступна БД) — повтор с экспоненциальной паузой;
 *    после `MAX_ATTEMPTS` попыток сообщение уходит в DLQ.
 *  - Отмена подписки брокером (удалена очередь) и закрытие канала приводят к переподключению.
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
      const channel = await connection.createConfirmChannel();
      channel.on('error', (error: unknown) => this.logger.warn(`AMQP-канал: ${String(error)}`));
      // Канал может закрыться при живом соединении (например, ошибка топологии) — пересоздаём всё.
      channel.on('close', () => this.restart(connection));
      await this.setup(channel);
      this.logger.log(`Подписан на очередь ${QUEUE}`);
    } catch (error) {
      this.logger.warn(`Не удалось подключиться к RabbitMQ: ${String(error)}`);
      this.scheduleReconnect();
    }
  }

  private restart(connection: ChannelModel): void {
    void connection.close().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectLoop();
    }, RECONNECT_DELAY_MS);
  }

  private async setup(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DLX, 'fanout', { durable: true });
    await channel.assertQueue(DLQ, { durable: true });
    await channel.bindQueue(DLQ, DLX, '');
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DLX });
    for (const type of EVENT_TYPES) await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, type);
    await channel.prefetch(PREFETCH);
    await channel.consume(QUEUE, (message) => {
      if (message) {
        void this.handle(channel, message);
        return;
      }
      // `null` — брокер отменил подписку (очередь удалена и т. п.): без переподключения
      // консьюмер молча перестал бы получать события.
      this.logger.error(`Подписка на ${QUEUE} отменена брокером, переподключаемся`);
      if (this.connection) this.restart(this.connection);
    });
  }

  private async handle(channel: ConfirmChannel, message: ConsumeMessage): Promise<void> {
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
      const attempts = this.attemptsOf(message) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.logger.error(`Событие ${event.id}: ${attempts} неудачных попыток, отправлено в DLQ`);
        this.safely(() => channel.reject(message, false));
        return;
      }
      this.logger.warn(`Сбой обработки ${event.id} (попытка ${attempts}): ${String(error)}`);
      setTimeout(
        () => this.safely(() => this.retry(channel, message, attempts)),
        this.delay(attempts),
      );
    }
  }

  /**
   * Повтор — это новая публикация копии с увеличенным счётчиком; оригинал подтверждается только
   * после confirm брокера. Не принял копию — оригинал возвращается в очередь, сообщение не теряется.
   * При падении между шагами появится дубликат, который гасит дедупликация в `EventIngestService`.
   */
  private retry(channel: ConfirmChannel, message: ConsumeMessage, attempts: number): void {
    channel.sendToQueue(
      QUEUE,
      message.content,
      {
        persistent: true,
        messageId: message.properties.messageId,
        contentType: message.properties.contentType,
        headers: { ...message.properties.headers, [ATTEMPTS_HEADER]: attempts },
      },
      (error) => {
        if (error) {
          this.logger.warn(
            `Брокер не принял повтор ${message.properties.messageId}: ${String(error)}`,
          );
          this.safely(() => channel.nack(message, false, true));
        } else {
          this.safely(() => channel.ack(message));
        }
      },
    );
  }

  private attemptsOf(message: ConsumeMessage): number {
    const value: unknown = message.properties.headers?.[ATTEMPTS_HEADER];
    return typeof value === 'number' ? value : 0;
  }

  private delay(attempts: number): number {
    return RETRY_BASE_DELAY_MS * 2 ** (attempts - 1);
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      /* канал закрыт — брокер сам вернёт неподтверждённое сообщение в очередь */
    }
  }
}
