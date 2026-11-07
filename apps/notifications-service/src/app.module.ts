import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DomainErrorFilter } from '@pp/nest-kit';
import { buildDataSourceOptions } from './database/data-source-options';
import { DeliveriesController } from './delivery/deliveries.controller';
import { DeliveriesService } from './delivery/deliveries.service';
import { DELIVERY_OPTIONS, DeliveryWorker, type DeliveryOptions } from './delivery/delivery-worker';
import { HealthController } from './health/health.controller';
import { AmqpConsumer } from './messaging/amqp-consumer';
import { EventIngestService } from './messaging/event-ingest.service';
import { ALLOW_PRIVATE_TARGETS, WebhooksService } from './webhooks/webhooks.service';
import { WebhooksController } from './webhooks/webhooks.controller';

export interface AppModuleOptions {
  databaseUrl: string;
  /** Без URL брокера потребитель не запускается. */
  amqpUrl?: string;
  allowPrivateWebhookTargets: boolean;
  delivery: DeliveryOptions;
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
      ],
      controllers: [WebhooksController, DeliveriesController, HealthController],
      providers: [
        WebhooksService,
        DeliveriesService,
        DeliveryWorker,
        EventIngestService,
        { provide: ALLOW_PRIVATE_TARGETS, useValue: options.allowPrivateWebhookTargets },
        { provide: DELIVERY_OPTIONS, useValue: options.delivery },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
        ...(options.amqpUrl
          ? [
              {
                provide: AmqpConsumer,
                inject: [EventIngestService],
                useFactory: (ingest: EventIngestService) =>
                  new AmqpConsumer(options.amqpUrl!, ingest),
              },
            ]
          : []),
      ],
    };
  }
}
