import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EventEnvelope } from '@pp/contracts';
import { DataSource } from 'typeorm';
import { EventPublisher } from './event-publisher';

export interface OutboxRelayOptions {
  batchSize: number;
  pollIntervalMs: number;
  /**
   * Срок аренды захваченных событий. Пачка, не уложившаяся в аренду, возвращается недопубликованной:
   * релей не публикует событие, если не успеет получить подтверждение до истечения аренды.
   */
  leaseMs: number;
  /** Предел ожидания подтверждения брокера для одного события. */
  publishTimeoutMs: number;
}

export const DEFAULT_RELAY_OPTIONS: OutboxRelayOptions = {
  batchSize: 100,
  pollIntervalMs: 500,
  leaseMs: 60_000,
  publishTimeoutMs: 5_000,
};

interface ClaimedRow {
  id: string;
  type: string;
  payload: object;
  occurred_at: Date;
  /** Значение `locked_until`, выставленное этим захватом; служит меткой владельца аренды. */
  lease: string;
}

/**
 * Читает неопубликованные события и отправляет их в брокер.
 *
 * Пачка захватывается короткой транзакцией (`FOR UPDATE SKIP LOCKED` + аренда `locked_until`),
 * а публикация идёт уже без открытой транзакции: зависший брокер не удерживает ни соединение
 * с БД, ни блокировки строк. Если релей упал посреди пачки, аренда истекает и события берёт другой.
 * Несколько экземпляров сервиса работают без дублей и ожидания.
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
  ) {
    if (options.leaseMs <= options.publishTimeoutMs) {
      throw new RangeError('leaseMs должен быть больше publishTimeoutMs');
    }
  }

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
    this.inFlight = this.flush();
    return this.inFlight;
  }

  private async flush(): Promise<number> {
    // Дедлайн — длительность, отсчитанная от начала захвата, поэтому рассинхрон часов приложения и БД
    // на него не влияет; запас даёт то, что отсчёт начинается до записи `locked_until`.
    const leaseDeadline = Date.now() + this.options.leaseMs;
    const batch = await this.claim();
    const published: string[] = [];
    for (const row of batch) {
      // После истечения аренды событие может взять другой релей — публиковать его уже нельзя.
      if (Date.now() + this.options.publishTimeoutMs >= leaseDeadline) break;
      try {
        await this.publishWithTimeout({
          id: row.id,
          type: row.type,
          occurredAt: row.occurred_at.toISOString(),
          payload: row.payload,
        });
        published.push(row.id);
      } catch (error) {
        // Порядок важен: останавливаемся на первой ошибке, остальные вернутся в очередь.
        this.logger.warn(`Публикация ${row.id} не удалась: ${String(error)}`);
        break;
      }
    }
    await this.finish(batch.slice(0, published.length), batch.slice(published.length));
    return published.length;
  }

  /**
   * Захват обёрнут в CTE: для голого `UPDATE … RETURNING` драйвер TypeORM возвращает пару
   * `[строки, счётчик]`, а для `WITH … SELECT` — обычный массив. Порядок `RETURNING`
   * не гарантирован, поэтому сортируем явно.
   */
  private async claim(): Promise<ClaimedRow[]> {
    const rows: ClaimedRow[] = await this.dataSource.query(
      `WITH claimed AS (
         UPDATE outbox_events
            SET locked_until = now() + ($2::int * interval '1 millisecond')
          WHERE id IN (
            SELECT id FROM outbox_events
             WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
             ORDER BY occurred_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, occurred_at, locked_until::text AS lease)
       SELECT * FROM claimed ORDER BY occurred_at, id`,
      [this.options.batchSize, this.options.leaseMs],
    );
    return rows;
  }

  /**
   * Отмечает опубликованное и досрочно возвращает неотправленное (снимает аренду).
   * Условие по `locked_until` защищает от чужой аренды: если наша истекла и событие уже взял другой
   * релей, мы не снимаем его аренду и не затираем его состояние.
   */
  private async finish(published: ClaimedRow[], unpublished: ClaimedRow[]): Promise<void> {
    if (published[0]) {
      await this.dataSource.query(
        `UPDATE outbox_events SET published_at = now(), locked_until = NULL
          WHERE id = ANY($1::uuid[]) AND locked_until = $2::timestamptz`,
        [published.map((row) => row.id), published[0].lease],
      );
    }
    if (unpublished[0]) {
      await this.dataSource.query(
        `UPDATE outbox_events SET locked_until = NULL
          WHERE id = ANY($1::uuid[]) AND locked_until = $2::timestamptz`,
        [unpublished.map((row) => row.id), unpublished[0].lease],
      );
    }
  }

  private async publishWithTimeout(event: EventEnvelope<string, unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`нет подтверждения брокера за ${this.options.publishTimeoutMs} мс`)),
        this.options.publishTimeoutMs,
      );
    });
    try {
      await Promise.race([this.publisher.publish(event), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
