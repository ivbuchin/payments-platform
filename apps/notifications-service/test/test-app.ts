import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DeliveryWorker } from '../src/delivery/delivery-worker';
import { EventIngestService } from '../src/messaging/event-ingest.service';

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  worker: DeliveryWorker;
  ingest: EventIngestService;
  url: string;
  stop(): Promise<void>;
}

export const MAX_ATTEMPTS = 3;

/** Реальный PostgreSQL в контейнере; воркер не стартует сам — тесты тактируют его вручную. */
export async function startTestApp(): Promise<TestApp> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        databaseUrl: container.getConnectionUri(),
        allowPrivateWebhookTargets: true,
        delivery: {
          maxAttempts: MAX_ATTEMPTS,
          baseDelayMs: 5,
          maxDelayMs: 20,
          timeoutMs: 2000,
          batchSize: 50,
          leaseMs: 60_000,
          pollIntervalMs: 50,
          autoStart: false,
        },
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  return {
    app,
    dataSource: app.get(DataSource),
    worker: app.get(DeliveryWorker),
    ingest: app.get(EventIngestService),
    url: await app.getUrl(),
    stop: async () => {
      await app.close();
      await container.stop();
    },
  };
}
