import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { DomainError } from '../common/domain-error';
import { fingerprint, isUniqueViolation } from '@pp/nest-kit';
import { LedgerService } from '../ledger/ledger.service';
import { Transfer } from '../ledger/transfer.entity';
import { OutboxWriter } from '@pp/outbox';
import { Hold } from './hold.entity';

export interface CreateHoldInput {
  idempotencyKey: string;
  accountId: string;
  amount: bigint;
  reference: string | null;
}

export interface CaptureResult {
  hold: Hold;
  transfer: Transfer;
}

/**
 * Жизненный цикл холда: `active → captured | released`. Переходы финальны.
 * Повтор уже совершённого перехода с теми же параметрами безопасен и возвращает прежний результат.
 */
@Injectable()
export class HoldsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxWriter,
  ) {}

  async create(input: CreateHoldInput): Promise<Hold> {
    const requestHash = fingerprint(['hold', input.accountId, input.amount, input.reference]);
    const existing = await this.findByKey(input.idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const accounts = await this.ledger.lockAccounts(manager, [input.accountId]);
        const account = accounts.get(input.accountId)!;
        if (account.available < input.amount) {
          throw new DomainError(
            'INSUFFICIENT_FUNDS',
            `На счёте ${account.id} недостаточно средств`,
          );
        }
        await manager.update(Account, account.id, { held: account.held + input.amount });

        const hold = await manager.save(
          manager.create(Hold, {
            idempotencyKey: input.idempotencyKey,
            requestHash,
            accountId: account.id,
            amount: input.amount,
            currency: account.currency,
            reference: input.reference,
            status: 'active',
          }),
        );
        await this.outbox.add(manager, {
          type: 'wallet.hold.created',
          payload: this.payload(hold),
        });
        return hold;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findByKey(input.idempotencyKey);
        if (winner) return this.replay(winner, requestHash);
      }
      throw error;
    }
  }

  async get(id: string): Promise<Hold> {
    const hold = await this.dataSource.manager.findOneBy(Hold, { id });
    if (!hold) throw new DomainError('HOLD_NOT_FOUND', `Холд ${id} не найден`);
    return hold;
  }

  /** Списывает зарезервированную сумму на счёт получателя. */
  capture(holdId: string, toAccountId: string): Promise<CaptureResult> {
    return this.dataSource.transaction(async (manager) => {
      const hold = await this.lockHold(manager, holdId);

      if (hold.status === 'captured') {
        const transfer = await manager.findOneByOrFail(Transfer, { id: hold.transferId! });
        if (transfer.toAccountId !== toAccountId) {
          throw new DomainError('HOLD_STATE_CONFLICT', 'Холд уже списан на другой счёт');
        }
        return { hold, transfer };
      }
      if (hold.status !== 'active') {
        throw new DomainError('HOLD_STATE_CONFLICT', `Холд в статусе ${hold.status}`);
      }

      const accounts = await this.ledger.lockAccounts(manager, [hold.accountId, toAccountId]);
      const payer = accounts.get(hold.accountId)!;

      // Сначала снимаем заморозку, затем обычный перевод: проверка доступности пройдёт,
      // потому что balance >= held + amount гарантирован ограничением счёта.
      payer.held -= hold.amount;
      await manager.update(Account, payer.id, { held: payer.held });

      const transfer = await this.ledger.applyTransfer(manager, accounts, {
        // Детерминированный ключ: capture одного холда не может породить два перевода.
        idempotencyKey: `hold-capture:${hold.id}`,
        requestHash: fingerprint(['capture', hold.id, toAccountId]),
        fromAccountId: hold.accountId,
        toAccountId,
        amount: hold.amount,
        reference: hold.reference,
      });

      hold.status = 'captured';
      hold.transferId = transfer.id;
      hold.settledAt = new Date();
      await manager.update(Hold, hold.id, {
        status: hold.status,
        transferId: transfer.id,
        settledAt: hold.settledAt,
      });
      await this.outbox.add(manager, {
        type: 'wallet.hold.captured',
        payload: this.payload(hold),
      });
      return { hold, transfer };
    });
  }

  /** Снимает резерв без списания. */
  release(holdId: string): Promise<Hold> {
    return this.dataSource.transaction(async (manager) => {
      const hold = await this.lockHold(manager, holdId);
      if (hold.status === 'released') return hold;
      if (hold.status !== 'active') {
        throw new DomainError('HOLD_STATE_CONFLICT', `Холд в статусе ${hold.status}`);
      }

      const accounts = await this.ledger.lockAccounts(manager, [hold.accountId]);
      const account = accounts.get(hold.accountId)!;
      await manager.update(Account, account.id, { held: account.held - hold.amount });

      hold.status = 'released';
      hold.settledAt = new Date();
      await manager.update(Hold, hold.id, { status: hold.status, settledAt: hold.settledAt });
      await this.outbox.add(manager, {
        type: 'wallet.hold.released',
        payload: this.payload(hold),
      });
      return hold;
    });
  }

  /** Холд блокируется раньше счетов — единый порядок захвата для capture и release. */
  private async lockHold(manager: EntityManager, id: string): Promise<Hold> {
    const hold = await manager.findOne(Hold, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!hold) throw new DomainError('HOLD_NOT_FOUND', `Холд ${id} не найден`);
    return hold;
  }

  private findByKey(idempotencyKey: string): Promise<Hold | null> {
    return this.dataSource.manager.findOneBy(Hold, { idempotencyKey });
  }

  private replay(existing: Hold, requestHash: string): Hold {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key уже использован с другими параметрами',
      );
    }
    return existing;
  }

  private payload(hold: Hold) {
    return {
      holdId: hold.id,
      accountId: hold.accountId,
      amount: hold.amount.toString(),
      currency: hold.currency,
      reference: hold.reference,
    };
  }
}
