import { type DynamicModule, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AmqpPublisher } from './amqp-publisher';
import { EventPublisher } from './event-publisher';
import { OutboxRelay, type OutboxRelayOptions } from './outbox-relay';
import { OutboxWriter } from './outbox-writer';

export interface OutboxModuleOptions {
  /** URL брокера. Без него события копятся в таблице, а релей не стартует (удобно для тестов). */
  amqpUrl?: string;
  relay?: Partial<OutboxRelayOptions>;
}

@Module({})
export class OutboxModule {
  static register(options: OutboxModuleOptions = {}): DynamicModule {
    const providers: DynamicModule['providers'] = [OutboxWriter];
    if (options.amqpUrl) {
      const relayOptions: OutboxRelayOptions = {
        batchSize: 100,
        pollIntervalMs: 500,
        ...options.relay,
      };
      providers.push(
        { provide: EventPublisher, useValue: new AmqpPublisher(options.amqpUrl) },
        {
          provide: OutboxRelay,
          inject: [DataSource, EventPublisher],
          useFactory: (dataSource: DataSource, publisher: EventPublisher) =>
            new OutboxRelay(dataSource, publisher, relayOptions),
        },
      );
    }
    return { module: OutboxModule, global: true, providers, exports: [OutboxWriter] };
  }
}
