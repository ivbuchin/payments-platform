import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EventEnvelope } from '@pp/contracts';
import { DataSource } from 'typeorm';
import { EventPublisher } from './event-publisher';
import { OutboxEvent } from './outbox-event.entity';

export interface OutboxRelayOptions {
  batchSize: number;
  pollIntervalMs: number;
}

export const OUTBOX_RELAY_OPTIONS = Symbol('OUTBOX_RELAY_OPTIONS');

/**
 * Читает неопубликованные события и отправляет их в брокер.
 * `FOR UPDATE SKIP LOCKED` позволяет запускать несколько экземпляров сервиса без дублей и ожидания.
 * Гарантия — at-least-once: потребители обязаны дедуплицировать по `event.id`.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private inFlight: Promise<number> = Promise.resolve(0);

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight.catch(() => undefined);
    await this.publisher.close();
  }

  /** Публикует одну пачку; возвращает число опубликованных событий. Открыт для тестов. */
  flushOnce(): Promise<number> {
    this.inFlight = this.dataSource.transaction(async (manager) => {
      const batch = await manager
        .createQueryBuilder(OutboxEvent, 'e')
        .where('e.published_at IS NULL')
        .orderBy('e.occurred_at', 'ASC')
        .limit(this.options.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      const published: string[] = [];
      for (const row of batch) {
        try {
          await this.publisher.publish({
            id: row.id,
            type: row.type,
            occurredAt: row.occurredAt.toISOString(),
            payload: row.payload,
          } satisfies EventEnvelope<string, unknown>);
          published.push(row.id);
        } catch (error) {
          // Порядок важен: останавливаемся на первой ошибке и отметим только уже доставленное.
          this.logger.warn(`Публикация ${row.id} не удалась: ${String(error)}`);
          break;
        }
      }
      if (published.length > 0) {
        await manager
          .createQueryBuilder()
          .update(OutboxEvent)
          .set({ publishedAt: () => 'now()' })
          .whereInIds(published)
          .execute();
      }
      return published.length;
    });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.flushOnce()
        .then((count) => this.schedule(count > 0 ? 0 : this.options.pollIntervalMs))
        .catch((error: unknown) => {
          this.logger.error(`Сбой релея: ${String(error)}`);
          this.schedule(this.options.pollIntervalMs);
        });
    }, delayMs);
  }
}
