import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { bigintTransformer } from '@pp/nest-kit';

export type AccountKind = 'user' | 'system';

/**
 * Счёт. `balance` — материализованная сумма проводок, `held` — часть баланса под активными холдами.
 * Доступно к списанию: `balance - held`. Инварианты дублируются CHECK-ограничениями в БД.
 * Системный счёт (источник пополнений) может уходить в минус — это зеркало внешнего мира.
 */
@Entity('accounts')
@Unique('accounts_kind_owner_currency_key', ['kind', 'ownerId', 'currency'])
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', name: 'owner_id' })
  ownerId: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'text', default: 'user' })
  kind: AccountKind;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  balance: bigint;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  held: bigint;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  get available(): bigint {
    return this.balance - this.held;
  }
}
