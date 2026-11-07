import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { WebhookDelivery } from '../delivery/delivery.entity';
import { WebhookEndpoint } from '../webhooks/webhook-endpoint.entity';

/** Единая конфигурация для приложения, CLI миграций и тестов. Схему меняют только миграции. */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [WebhookEndpoint, WebhookDelivery],
    migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
    synchronize: false,
  };
}
