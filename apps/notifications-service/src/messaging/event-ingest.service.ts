import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@pp/contracts';
import { DataSource } from 'typeorm';

/**
 * Приём события из брокера (inbox-паттерн).
 * Брокер доставляет «хотя бы раз», поэтому дубликаты отсекает PK `inbox_events.event_id`:
 * запись в inbox и создание доставок — одна транзакция, так что событие обработается ровно один раз.
 */
@Injectable()
export class EventIngestService {
  constructor(private readonly dataSource: DataSource) {}

  /** @returns число созданных доставок; 0 — дубликат или нет подходящих подписчиков. */
  async ingest(event: EventEnvelope<string, unknown>): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO inbox_events (event_id, type) VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.id, event.type],
      );
      if (inserted.length === 0) return 0;

      const created: unknown[] = await manager.query(
        `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, next_attempt_at)
         SELECT id, $1::uuid, $2, $3::jsonb, now()
         FROM webhook_endpoints
         WHERE $2 = ANY (event_types) OR '*' = ANY (event_types)
         RETURNING id`,
        [event.id, event.type, JSON.stringify(event)],
      );
      return created.length;
    });
  }
}
