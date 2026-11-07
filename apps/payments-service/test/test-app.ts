import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PaymentsService } from '../src/payments/payments.service';
import { WalletGateway } from '../src/wallet/wallet.gateway';
import { FakeWallet } from './fake-wallet';

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  wallet: FakeWallet;
  payments: PaymentsService;
  url: string;
  stop(): Promise<void>;
}

/** Реальный PostgreSQL в контейнере + приложение с боевой конфигурацией; wallet заменён моделью. */
export async function startTestApp(): Promise<TestApp> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const wallet = new FakeWallet();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        databaseUrl: container.getConnectionUri(),
        walletUrl: 'http://wallet.invalid',
        walletKeySecret: 'test-secret-0123456789',
        reconcile: { intervalMs: 0, staleAfterMs: 0, authorizationTtlMs: 0 },
      }),
    ],
  })
    .overrideProvider(WalletGateway)
    .useValue(wallet)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  return {
    app,
    dataSource: app.get(DataSource),
    wallet,
    payments: app.get(PaymentsService),
    url: await app.getUrl(),
    stop: async () => {
      await app.close();
      await container.stop();
    },
  };
}
