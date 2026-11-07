import { Logger } from '@nestjs/common';
import { EVENTS_EXCHANGE, type EventEnvelope } from '@pp/contracts';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { EventPublisher } from './event-publisher';

/** Публикация в topic-exchange с подтверждениями; соединение восстанавливается лениво. */
export class AmqpPublisher extends EventPublisher {
  private readonly logger = new Logger(AmqpPublisher.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting?: Promise<ConfirmChannel>;
  /** `messageId` сообщений, которые брокер вернул как немаршрутизируемые (basic.return). */
  private readonly returned = new Set<string>();

  constructor(private readonly url: string) {
    super();
  }

  async publish(event: EventEnvelope<string, unknown>): Promise<void> {
    const channel = await this.getChannel();
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        event.type,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, mandatory: true, messageId: event.id, contentType: 'application/json' },
        (error) => {
          if (error) return reject(error);
          // basic.return приходит раньше basic.ack: ack получает и сообщение, не попавшее в очередь.
          if (this.returned.delete(event.id)) {
            return reject(new Error(`событие ${event.type} не маршрутизировано ни в одну очередь`));
          }
          resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.reset();
    await connection?.close().catch(() => undefined);
  }

  private getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<ConfirmChannel> {
    const connection = await connect(this.url);
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    const onFailure = (error: unknown) => {
      this.logger.warn(`AMQP-соединение потеряно: ${String(error)}`);
      this.reset();
    };
    channel.on('return', (message: { properties: { messageId?: string } }) => {
      if (message.properties.messageId) this.returned.add(message.properties.messageId);
    });
    channel.on('error', onFailure);
    channel.on('close', () => this.reset());
    connection.on('error', onFailure);
    connection.on('close', () => this.reset());
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  private reset(): void {
    this.connection = undefined;
    this.channel = undefined;
    this.returned.clear();
  }
}
