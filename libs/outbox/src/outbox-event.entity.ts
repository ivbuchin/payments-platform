import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Transactional outbox: событие пишется в той же транзакции, что и изменение данных,
 * а отдельный релей позже публикует его в брокер. Это гарантирует доставку «хотя бы раз».
 */
@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'jsonb' })
  payload: object;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt: Date;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt: Date | null;
}

/** DDL таблицы — единый для всех сервисов; подключается из миграции сервиса. */
export const OUTBOX_TABLE_SQL = `
  CREATE TABLE outbox_events (
    id           uuid PRIMARY KEY,
    type         text        NOT NULL,
    payload      jsonb       NOT NULL,
    occurred_at  timestamptz NOT NULL,
    published_at timestamptz
  );
  CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at)
    WHERE published_at IS NULL;
`;
