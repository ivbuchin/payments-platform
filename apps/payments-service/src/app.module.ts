import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DomainErrorFilter } from '@pp/nest-kit';
import { OutboxModule } from '@pp/outbox';
import { buildDataSourceOptions } from './database/data-source-options';
import { HealthController } from './health/health.controller';
import { PaymentsReconciler, RECONCILER_OPTIONS } from './payments/payments-reconciler';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService, WALLET_KEY_SECRET } from './payments/payments.service';
import { HttpWalletGateway } from './wallet/http-wallet.gateway';
import { WalletGateway } from './wallet/wallet.gateway';

export interface AppModuleOptions {
  databaseUrl: string;
  walletUrl: string;
  walletTimeoutMs?: number;
  /** Секрет вывода ключей идемпотентности для вызовов wallet (не короче 16 символов). */
  walletKeySecret: string;
  amqpUrl?: string;
  /** Сверка зависших платежей (раз в 15 с для старше 30 с) и истечение авторизаций (7 суток). */
  reconcile?: { intervalMs: number; staleAfterMs: number; authorizationTtlMs: number };
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          ...buildDataSourceOptions(options.databaseUrl),
          migrationsRun: true,
        }),
        OutboxModule.register({ amqpUrl: options.amqpUrl }),
      ],
      controllers: [PaymentsController, HealthController],
      providers: [
        PaymentsService,
        PaymentsReconciler,
        { provide: WALLET_KEY_SECRET, useValue: options.walletKeySecret },
        {
          provide: RECONCILER_OPTIONS,
          useValue: options.reconcile ?? {
            intervalMs: 15_000,
            staleAfterMs: 30_000,
            authorizationTtlMs: 7 * 24 * 3600_000,
          },
        },
        {
          provide: WalletGateway,
          useValue: new HttpWalletGateway({
            baseUrl: options.walletUrl,
            timeoutMs: options.walletTimeoutMs ?? 3000,
          }),
        },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
