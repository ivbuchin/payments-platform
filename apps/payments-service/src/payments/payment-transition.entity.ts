import type { PaymentStatus } from '@pp/contracts';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Журнал переходов платежа — аудит «кто и когда перевёл платёж в какой статус». */
@Entity('payment_transitions')
export class PaymentTransition {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', name: 'payment_id' })
  paymentId: string;

  @Column({ type: 'text', name: 'from_status' })
  fromStatus: PaymentStatus;

  @Column({ type: 'text', name: 'to_status' })
  toStatus: PaymentStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
