import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainError } from '../common/domain-error';
import { isUniqueViolation } from '@pp/nest-kit';
import { LedgerEntry } from '../ledger/ledger-entry.entity';
import { Account } from './account.entity';

export interface LedgerPage {
  items: LedgerEntry[];
  /** Курсор для следующей страницы (id последней проводки) или `null`, если данных больше нет. */
  nextBefore: string | null;
}

@Injectable()
export class AccountsService {
  constructor(private readonly dataSource: DataSource) {}

  async create(ownerId: string, currency: string): Promise<Account> {
    try {
      return await this.dataSource.manager.save(
        this.dataSource.manager.create(Account, { ownerId, currency, kind: 'user' }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          'ACCOUNT_ALREADY_EXISTS',
          `У владельца ${ownerId} уже есть счёт в валюте ${currency}`,
        );
      }
      throw error;
    }
  }

  async get(id: string): Promise<Account> {
    const account = await this.dataSource.manager.findOneBy(Account, { id });
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', `Счёт ${id} не найден`);
    return account;
  }

  /** Выписка по счёту, новые проводки первыми; keyset-пагинация устойчива к новым записям. */
  async listLedger(accountId: string, limit: number, before?: string): Promise<LedgerPage> {
    await this.get(accountId);
    const qb = this.dataSource.manager
      .createQueryBuilder(LedgerEntry, 'e')
      .where('e.account_id = :accountId', { accountId })
      .orderBy('e.id', 'DESC')
      .limit(limit + 1);
    if (before) qb.andWhere('e.id < :before', { before });

    const rows = await qb.getMany();
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, nextBefore: hasMore ? items[items.length - 1]!.id : null };
  }
}
