import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { Hold } from '../holds/hold.entity';
import { LedgerEntry } from '../ledger/ledger-entry.entity';
import { Transfer } from '../ledger/transfer.entity';
import { OutboxEvent } from '@pp/outbox';

/** Единая конфигурация для приложения, CLI миграций и тестов. Схему меняют только миграции. */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Account, Transfer, LedgerEntry, Hold, OutboxEvent],
    migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
    synchronize: false,
  };
}
