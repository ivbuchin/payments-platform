import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '@pp/nest-kit';

export type HoldStatus = 'active' | 'captured' | 'released';

/** Резерв средств (авторизация): блокирует сумму на счёте до capture или release. */
@Entity('holds')
export class Hold {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ type: 'char', length: 64, name: 'request_hash' })
  requestHash: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'text', nullable: true })
  reference: string | null;

  @Column({ type: 'text', default: 'active' })
  status: HoldStatus;

  /** Перевод, в который превратился холд при capture. */
  @Column({ type: 'uuid', name: 'transfer_id', nullable: true })
  transferId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'settled_at', nullable: true })
  settledAt: Date | null;
}
