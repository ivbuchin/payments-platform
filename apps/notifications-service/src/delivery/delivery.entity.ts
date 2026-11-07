import type { EventEnvelope } from '@pp/contracts';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

/** Попытки доставки одного события одному получателю. `dead` — исчерпаны ретраи, нужен ручной разбор. */
@Entity('webhook_deliveries')
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'endpoint_id' })
  endpointId: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId: string;

  @Column({ type: 'text', name: 'event_type' })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: EventEnvelope<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status: DeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', name: 'next_attempt_at' })
  nextAttemptAt: Date;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError: string | null;

  @Column({ type: 'int', name: 'last_status_code', nullable: true })
  lastStatusCode: number | null;

  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
