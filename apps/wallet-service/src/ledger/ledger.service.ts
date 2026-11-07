import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { DomainError } from '../common/domain-error';
import { OutboxWriter } from '@pp/outbox';
import { LedgerEntry } from './ledger-entry.entity';
import { Transfer } from './transfer.entity';

const SYSTEM_OWNER = 'system';

export interface TransferCommand {
  idempotencyKey: string;
  requestHash: string;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  reference: string | null;
}

/**
 * Ядро двойной записи. Все методы принимают транзакционный `EntityManager`:
 * вызывающий определяет границы транзакции, а ядро гарантирует инварианты внутри неё.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly outbox: OutboxWriter) {}

  /**
   * Блокирует счета `SELECT ... FOR UPDATE` в детерминированном порядке (по id).
   * Единый порядок захвата исключает взаимные блокировки (deadlock) при встречных переводах.
   */
  async lockAccounts(
    manager: EntityManager,
    ids: readonly string[],
  ): Promise<Map<string, Account>> {
    const unique = [...new Set(ids)];
    const rows = await manager.find(Account, {
      where: { id: In(unique) },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const byId = new Map(rows.map((account) => [account.id, account]));
    const missing = unique.find((id) => !byId.has(id));
    if (missing) {
      throw new DomainError('ACCOUNT_NOT_FOUND', `Счёт ${missing} не найден`);
    }
    return byId;
  }

  /** Системный счёт валюты создаётся лениво; `ON CONFLICT DO NOTHING` безопасен при гонках. */
  async ensureSystemAccount(manager: EntityManager, currency: string): Promise<Account> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Account)
      .values({ ownerId: SYSTEM_OWNER, currency, kind: 'system' })
      .orIgnore()
      .execute();
    return manager.findOneByOrFail(Account, { kind: 'system', ownerId: SYSTEM_OWNER, currency });
  }

  /** Проводит перевод между уже заблокированными счетами. */
  async applyTransfer(
    manager: EntityManager,
    accounts: ReadonlyMap<string, Account>,
    cmd: TransferCommand,
  ): Promise<Transfer> {
    if (cmd.fromAccountId === cmd.toAccountId) {
      throw new DomainError('SAME_ACCOUNT', 'Нельзя переводить средства на тот же счёт');
    }
    const from = accounts.get(cmd.fromAccountId)!;
    const to = accounts.get(cmd.toAccountId)!;
    if (from.currency !== to.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Валюты счетов не совпадают');
    }
    if (from.kind === 'user' && from.available < cmd.amount) {
      throw new DomainError('INSUFFICIENT_FUNDS', `На счёте ${from.id} недостаточно средств`);
    }

    from.balance -= cmd.amount;
    to.balance += cmd.amount;
    await manager.update(Account, from.id, { balance: from.balance });
    await manager.update(Account, to.id, { balance: to.balance });

    const transfer = await manager.save(
      manager.create(Transfer, {
        idempotencyKey: cmd.idempotencyKey,
        requestHash: cmd.requestHash,
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: cmd.amount,
        currency: from.currency,
        reference: cmd.reference,
      }),
    );

    await manager.insert(LedgerEntry, [
      {
        transferId: transfer.id,
        accountId: from.id,
        direction: 'debit',
        amount: cmd.amount,
        balanceAfter: from.balance,
      },
      {
        transferId: transfer.id,
        accountId: to.id,
        direction: 'credit',
        amount: cmd.amount,
        balanceAfter: to.balance,
      },
    ]);

    await this.outbox.add(manager, {
      type: 'wallet.transfer.completed',
      payload: {
        transferId: transfer.id,
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: cmd.amount.toString(),
        currency: from.currency,
        reference: cmd.reference,
      },
    });
    return transfer;
  }
}
