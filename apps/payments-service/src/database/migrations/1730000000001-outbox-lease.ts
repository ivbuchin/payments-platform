import { OUTBOX_LEASE_SQL } from '@pp/outbox';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Аренда событий outbox для релея. */
export class OutboxLease1730000000001 implements MigrationInterface {
  name = 'OutboxLease1730000000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(OUTBOX_LEASE_SQL);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE outbox_events DROP COLUMN IF EXISTS locked_until');
  }
}
