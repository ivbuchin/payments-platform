import { OutboxEvent } from '@pp/outbox';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { PaymentTransition } from '../payments/payment-transition.entity';
import { Payment } from '../payments/payment.entity';

/** Единая конфигурация для приложения, CLI миграций и тестов. Схему меняют только миграции. */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Payment, PaymentTransition, OutboxEvent],
    migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
    synchronize: false,
  };
}
