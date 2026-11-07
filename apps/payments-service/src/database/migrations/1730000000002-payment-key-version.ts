import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Версия схемы ключей идемпотентности вызовов wallet. Платежи, созданные до миграции, получают 1
 * (`payment:<id>:hold|refund`): их незавершённые операции уже могли выполниться в wallet под этими
 * ключами, и повтор обязан использовать те же. Новые платежи создаются с версией 2 (HMAC).
 */
export class PaymentKeyVersion1730000000002 implements MigrationInterface {
  name = 'PaymentKeyVersion1730000000002';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE payments ADD COLUMN key_version smallint NOT NULL DEFAULT 1');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE payments DROP COLUMN key_version');
  }
}
