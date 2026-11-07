import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DomainErrorFilter } from '@pp/nest-kit';
import { OutboxModule } from '@pp/outbox';
import { buildDataSourceOptions } from './database/data-source-options';
import { HealthController } from './health/health.controller';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { HttpWalletGateway } from './wallet/http-wallet.gateway';
import { WalletGateway } from './wallet/wallet.gateway';

export interface AppModuleOptions {
  databaseUrl: string;
  walletUrl: string;
  walletTimeoutMs?: number;
  amqpUrl?: string;
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
