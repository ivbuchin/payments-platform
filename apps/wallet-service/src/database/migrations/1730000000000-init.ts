import { OUTBOX_TABLE_SQL } from '@pp/outbox';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1730000000000 implements MigrationInterface {
  name = 'Init1730000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE accounts (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id    text        NOT NULL,
        currency    char(3)     NOT NULL,
        kind        text        NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
        balance     bigint      NOT NULL DEFAULT 0,
        held        bigint      NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT accounts_kind_owner_currency_key UNIQUE (kind, owner_id, currency),
        -- Пользовательский счёт не может уйти в минус или заморозить больше, чем есть.
        CONSTRAINT accounts_user_funds_check CHECK (
          kind = 'system' OR (balance >= 0 AND held >= 0 AND held <= balance)
        )
      );

      CREATE TABLE transfers (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key  text        NOT NULL UNIQUE,
        request_hash     char(64)    NOT NULL,
        from_account_id  uuid        NOT NULL REFERENCES accounts (id),
        to_account_id    uuid        NOT NULL REFERENCES accounts (id),
        amount           bigint      NOT NULL CHECK (amount > 0),
        currency         char(3)     NOT NULL,
        reference        text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id)
      );

      CREATE TABLE ledger_entries (
        id             bigserial PRIMARY KEY,
        transfer_id    uuid        NOT NULL REFERENCES transfers (id),
        account_id     uuid        NOT NULL REFERENCES accounts (id),
        direction      text        NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount         bigint      NOT NULL CHECK (amount > 0),
        balance_after  bigint      NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
      CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

      CREATE TABLE holds (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key  text        NOT NULL UNIQUE,
        request_hash     char(64)    NOT NULL,
        account_id       uuid        NOT NULL REFERENCES accounts (id),
        amount           bigint      NOT NULL CHECK (amount > 0),
        currency         char(3)     NOT NULL,
        reference        text,
        status           text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'captured', 'released')),
        transfer_id      uuid        REFERENCES transfers (id),
        created_at       timestamptz NOT NULL DEFAULT now(),
        settled_at       timestamptz
      );

    `);
    await q.query(OUTBOX_TABLE_SQL);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE outbox_events, holds, ledger_entries, transfers, accounts;
    `);
  }
}
