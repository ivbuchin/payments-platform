import { bigintTransformer } from '@pp/nest-kit';
import type { PaymentStatus } from '@pp/contracts';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ type: 'char', length: 64, name: 'request_hash' })
  requestHash: string;

  @Column({ type: 'uuid', name: 'payer_account_id' })
  payerAccountId: string;

  @Column({ type: 'uuid', name: 'merchant_account_id' })
  merchantAccountId: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'text', default: 'created' })
  status: PaymentStatus;

  /** Резерв в wallet-service, созданный при авторизации. */
  @Column({ type: 'uuid', name: 'hold_id', nullable: true })
  holdId: string | null;

  @Column({ type: 'uuid', name: 'capture_transfer_id', nullable: true })
  captureTransferId: string | null;

  @Column({ type: 'uuid', name: 'refund_transfer_id', nullable: true })
  refundTransferId: string | null;

  /** Машинный код причины, если платёж завершился статусом `failed`. */
  @Column({ type: 'text', name: 'failure_reason', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
