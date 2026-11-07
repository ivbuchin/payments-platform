import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { computeBackoffMs } from './backoff';
import type { WebhookDelivery } from './delivery.entity';
import { buildSignatureHeader } from './signing';

export interface DeliveryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  batchSize: number;
  /** На сколько «арендуется» доставка при захвате: если воркер упал, её подхватит другой. */
  leaseMs: number;
  pollIntervalMs: number;
  /** Запускать ли фоновый цикл. В тестах выключен — они вызывают `runOnce` сами. */
  autoStart: boolean;
}

export const DELIVERY_OPTIONS = Symbol('DELIVERY_OPTIONS');

interface ClaimedRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: WebhookDelivery['payload'];
  attempts: number;
}

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

interface Outcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

/**
 * Доставка вебхуков. Захват пачки — `UPDATE … FOR UPDATE SKIP LOCKED` с арендой (lease):
 * несколько экземпляров сервиса не мешают друг другу, а HTTP-вызовы идут вне транзакции БД.
 * Гарантия — at-least-once; получатель дедуплицирует по заголовку `X-PP-Event-Id`.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private inFlight: Promise<number> = Promise.resolve(0);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(DELIVERY_OPTIONS) private readonly options: DeliveryOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.autoStart) this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight.catch(() => undefined);
  }

  /** Обрабатывает одну пачку созревших доставок; возвращает её размер. */
  runOnce(): Promise<number> {
    this.inFlight = this.process();
    return this.inFlight;
  }

  private async process(): Promise<number> {
    const claimed = await this.claim();
    if (claimed.length === 0) return 0;

    const endpoints = await this.loadEndpoints(claimed.map((row) => row.endpoint_id));
    await Promise.all(
      claimed.map(async (row) => {
        const endpoint = endpoints.get(row.endpoint_id);
        if (!endpoint) return; // подписку удалили — каскад уже убрал доставку
        await this.record(row, await this.send(endpoint, row));
      }),
    );
    return claimed.length;
  }

  /**
   * Захват обёрнут в CTE: для голого `UPDATE … RETURNING` драйвер TypeORM возвращает пару
   * `[строки, счётчик]`, а для `WITH … SELECT` — обычный массив строк.
   */
  private claim(): Promise<ClaimedRow[]> {
    return this.dataSource.query(
      `WITH claimed AS (
         UPDATE webhook_deliveries
            SET next_attempt_at = now() + ($2::int * interval '1 millisecond')
          WHERE id IN (
            SELECT id FROM webhook_deliveries
             WHERE status = 'pending' AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
        RETURNING id, endpoint_id, event_id, event_type, payload, attempts)
       SELECT * FROM claimed`,
      [this.options.batchSize, this.options.leaseMs],
    );
  }

  private async loadEndpoints(ids: string[]): Promise<Map<string, EndpointRow>> {
    const rows: EndpointRow[] = await this.dataSource.query(
      `SELECT id, url, secret FROM webhook_endpoints WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async send(endpoint: EndpointRow, row: ClaimedRow): Promise<Outcome> {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pp-notifications/0.1',
          'x-pp-event-id': row.event_id,
          'x-pp-event-type': row.event_type,
          'x-pp-delivery-attempt': String(row.attempts + 1),
          'x-pp-signature': buildSignatureHeader(endpoint.secret, timestamp, body),
        },
        body,
        // Редиректы не выполняем: иначе публичный URL мог бы перенаправить нас во внутреннюю сеть.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      await response.body?.cancel();
      return response.status >= 200 && response.status < 300
        ? { ok: true, statusCode: response.status, error: null }
        : { ok: false, statusCode: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, statusCode: null, error: String(error).slice(0, 500) };
    }
  }

  private async record(row: ClaimedRow, outcome: Outcome): Promise<void> {
    const attempts = row.attempts + 1;
    if (outcome.ok) {
      await this.dataSource.query(
        `UPDATE webhook_deliveries
            SET status = 'delivered', attempts = $2, delivered_at = now(),
                last_status_code = $3, last_error = NULL
          WHERE id = $1`,
        [row.id, attempts, outcome.statusCode],
      );
      return;
    }

    const dead = attempts >= this.options.maxAttempts;
    const delayMs = computeBackoffMs(attempts, {
      baseMs: this.options.baseDelayMs,
      maxMs: this.options.maxDelayMs,
    });
    if (dead)
      this.logger.warn(`Доставка ${row.id} исчерпала ${attempts} попыток: ${outcome.error}`);
    await this.dataSource.query(
      `UPDATE webhook_deliveries
          SET status = $2, attempts = $3,
              next_attempt_at = now() + ($4::int * interval '1 millisecond'),
              last_status_code = $5, last_error = $6
        WHERE id = $1`,
      [row.id, dead ? 'dead' : 'pending', attempts, delayMs, outcome.statusCode, outcome.error],
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.runOnce()
        .then((count) => this.schedule(count > 0 ? 0 : this.options.pollIntervalMs))
        .catch((error: unknown) => {
          this.logger.error(`Сбой воркера доставки: ${String(error)}`);
          this.schedule(this.options.pollIntervalMs);
        });
    }, delayMs);
  }
}
