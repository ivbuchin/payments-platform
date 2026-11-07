import { OUTBOX_TABLE_SQL } from '@pp/outbox';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1730000000000 implements MigrationInterface {
  name = 'Init1730000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE payments (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key      text        NOT NULL UNIQUE,
        request_hash         char(64)    NOT NULL,
        payer_account_id     uuid        NOT NULL,
        merchant_account_id  uuid        NOT NULL,
        amount               bigint      NOT NULL CHECK (amount > 0),
        currency             char(3)     NOT NULL,
        status               text        NOT NULL DEFAULT 'created'
                             CHECK (status IN
                               ('created', 'authorized', 'captured', 'refunded', 'canceled', 'failed')),
        hold_id              uuid,
        capture_transfer_id  uuid,
        refund_transfer_id   uuid,
        failure_reason       text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payments_distinct_parties CHECK (payer_account_id <> merchant_account_id)
      );

      CREATE TABLE payment_transitions (
        id          bigserial PRIMARY KEY,
        payment_id  uuid        NOT NULL REFERENCES payments (id),
        from_status text        NOT NULL,
        to_status   text        NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX payment_transitions_payment_idx ON payment_transitions (payment_id, id);
    `);
    await q.query(OUTBOX_TABLE_SQL);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE outbox_events, payment_transitions, payments;`);
  }
}
