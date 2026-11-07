import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '@pp/nest-kit';

/** Перевод между двумя счетами. Неизменяем после создания. */
@Entity('transfers')
export class Transfer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ type: 'char', length: 64, name: 'request_hash' })
  requestHash: string;

  @Column({ type: 'uuid', name: 'from_account_id' })
  fromAccountId: string;

  @Column({ type: 'uuid', name: 'to_account_id' })
  toAccountId: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'char', length: 3 })
  currency: string;

  /** Внешняя ссылка на причину перевода, например идентификатор платежа. */
  @Column({ type: 'text', nullable: true })
  reference: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
