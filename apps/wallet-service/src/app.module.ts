import { Module } from '@nestjs/common';
import { DomainErrorFilter } from '@pp/nest-kit';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';

import { buildDataSourceOptions } from './database/data-source-options';
import { HealthController } from './health/health.controller';
import { HoldsController } from './holds/holds.controller';
import { HoldsService } from './holds/holds.service';
import { LedgerService } from './ledger/ledger.service';
import { TransfersController } from './ledger/transfers.controller';
import { TransfersService } from './ledger/transfers.service';
import { OutboxModule } from '@pp/outbox';

@Module({})
export class AppModule {
  static forRoot(databaseUrl: string, amqpUrl?: string): ReturnType<typeof AppModule.build> {
    return AppModule.build(databaseUrl, amqpUrl);
  }

  private static build(databaseUrl: string, amqpUrl?: string) {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          ...buildDataSourceOptions(databaseUrl),
          migrationsRun: true,
        }),
        OutboxModule.register({ amqpUrl }),
      ],
      controllers: [AccountsController, TransfersController, HoldsController, HealthController],
      providers: [
        AccountsService,
        TransfersService,
        HoldsService,
        LedgerService,
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
