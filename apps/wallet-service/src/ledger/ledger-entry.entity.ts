import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '@pp/nest-kit';

export type EntryDirection = 'debit' | 'credit';

/** Проводка двойной записи: каждый перевод порождает ровно две (debit и credit на равную сумму). */
@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', name: 'transfer_id' })
  transferId: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId: string;

  @Column({ type: 'text' })
  direction: EntryDirection;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  /** Баланс счёта сразу после проводки — выписка без пересчёта истории. */
  @Column({ type: 'bigint', name: 'balance_after', transformer: bigintTransformer })
  balanceAfter: bigint;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
