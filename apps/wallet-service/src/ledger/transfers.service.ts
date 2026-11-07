import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { DomainError } from '../common/domain-error';
import { fingerprint, isUniqueViolation } from '@pp/nest-kit';
import { LedgerService } from './ledger.service';
import { Transfer } from './transfer.entity';

export interface CreateTransferInput {
  idempotencyKey: string;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  reference: string | null;
}

export interface CreateDepositInput {
  idempotencyKey: string;
  accountId: string;
  amount: bigint;
  reference: string | null;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  /** Идемпотентный перевод: повтор с тем же ключом и параметрами возвращает исходный результат. */
  create(input: CreateTransferInput): Promise<Transfer> {
    const requestHash = fingerprint([
      'transfer',
      input.fromAccountId,
      input.toAccountId,
      input.amount,
      input.reference,
    ]);
    return this.runIdempotent(input.idempotencyKey, requestHash, async (manager) => {
      const accounts = await this.ledger.lockAccounts(manager, [
        input.fromAccountId,
        input.toAccountId,
      ]);
      return this.ledger.applyTransfer(manager, accounts, { ...input, requestHash });
    });
  }

  /** Пополнение — перевод с системного счёта той же валюты (зеркало внешнего мира). */
  deposit(input: CreateDepositInput): Promise<Transfer> {
    const requestHash = fingerprint(['deposit', input.accountId, input.amount, input.reference]);
    return this.runIdempotent(input.idempotencyKey, requestHash, async (manager) => {
      const target = await manager.findOneBy(Account, { id: input.accountId });
      if (!target) throw new DomainError('ACCOUNT_NOT_FOUND', `Счёт ${input.accountId} не найден`);
      const system = await this.ledger.ensureSystemAccount(manager, target.currency);
      const accounts = await this.ledger.lockAccounts(manager, [system.id, target.id]);
      return this.ledger.applyTransfer(manager, accounts, {
        idempotencyKey: input.idempotencyKey,
        requestHash,
        fromAccountId: system.id,
        toAccountId: target.id,
        amount: input.amount,
        reference: input.reference,
      });
    });
  }

  async get(id: string): Promise<Transfer> {
    const transfer = await this.dataSource.manager.findOneBy(Transfer, { id });
    if (!transfer) throw new DomainError('TRANSFER_NOT_FOUND', `Перевод ${id} не найден`);
    return transfer;
  }

  /**
   * Выполняет `work` в транзакции с защитой от повторов. Быстрый путь — поиск по ключу;
   * медленный — уникальный индекс: проигравший гонку перечитывает результат победителя.
   */
  private async runIdempotent(
    key: string,
    requestHash: string,
    work: (manager: EntityManager) => Promise<Transfer>,
  ): Promise<Transfer> {
    const existing = await this.findByKey(key);
    if (existing) return this.replay(existing, requestHash);
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findByKey(key);
        if (winner) return this.replay(winner, requestHash);
      }
      throw error;
    }
  }

  private findByKey(idempotencyKey: string): Promise<Transfer | null> {
    return this.dataSource.manager.findOneBy(Transfer, { idempotencyKey });
  }

  private replay(existing: Transfer, requestHash: string): Transfer {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key уже использован с другими параметрами',
      );
    }
    return existing;
  }
}
