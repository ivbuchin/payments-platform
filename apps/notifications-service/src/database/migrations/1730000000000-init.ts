import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1730000000000 implements MigrationInterface {
  name = 'Init1730000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE webhook_endpoints (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        url         text        NOT NULL,
        secret      text        NOT NULL,
        event_types text[]      NOT NULL CHECK (cardinality(event_types) > 0),
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Inbox: журнал обработанных событий. PK по event_id делает обработку идемпотентной.
      CREATE TABLE inbox_events (
        event_id     uuid PRIMARY KEY,
        type         text        NOT NULL,
        received_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE webhook_deliveries (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id      uuid        NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
        event_id         uuid        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        status           text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'delivered', 'dead')),
        attempts         int         NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz NOT NULL,
        last_error       text,
        last_status_code int,
        delivered_at     timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (endpoint_id, event_id)
      );
      CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
        WHERE status = 'pending';
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE webhook_deliveries, inbox_events, webhook_endpoints;`);
  }
}
