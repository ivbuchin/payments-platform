import { OUTBOX_LEASE_SQL } from '@pp/outbox';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Аренда событий outbox для релея и индекс по `holds.account_id` (баланс с учётом холдов). */
export class OutboxLeaseHoldsIndex1730000000001 implements MigrationInterface {
  name = 'OutboxLeaseHoldsIndex1730000000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(OUTBOX_LEASE_SQL);
    await q.query('CREATE INDEX IF NOT EXISTS holds_account_idx ON holds (account_id)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS holds_account_idx');
    await q.query('ALTER TABLE outbox_events DROP COLUMN IF EXISTS locked_until');
  }
}
