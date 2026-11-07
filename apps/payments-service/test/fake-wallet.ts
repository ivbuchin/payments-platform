import {
  WalletGateway,
  WalletRejectedError,
  WalletUnavailableError,
  type WalletHold,
} from '../src/wallet/wallet.gateway';

interface FakeAccount {
  balance: bigint;
  held: bigint;
  currency: string;
}

interface FakeHold {
  id: string;
  accountId: string;
  amount: bigint;
  status: 'active' | 'captured' | 'released';
  transferId?: string;
}

/**
 * Модель wallet-service в памяти с той же идемпотентностью по ключам.
 * Позволяет детерминированно воспроизводить отказы и сетевые сбои, которые трудно получить от реального сервиса.
 */
export class FakeWallet extends WalletGateway {
  readonly accounts = new Map<string, FakeAccount>();
  readonly holds = new Map<string, FakeHold>();
  private readonly byKey = new Map<string, string>();
  private readonly transfers = new Map<string, string>();
  private seq = 0;

  /** Следующие N вызовов завершатся сетевой ошибкой. */
  failNextCalls = 0;
  readonly calls = { createHold: 0, captureHold: 0, releaseHold: 0, transfer: 0 };

  open(id: string, balance: bigint, currency = 'RUB'): void {
    this.accounts.set(id, { balance, held: 0n, currency });
  }

  balanceOf(id: string): bigint {
    return this.accounts.get(id)!.balance;
  }

  async createHold(input: {
    idempotencyKey: string;
    accountId: string;
    amount: string;
  }): Promise<WalletHold> {
    this.calls.createHold++;
    this.maybeFail();
    const account = this.account(input.accountId);
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return { id: known, currency: account.currency };

    const amount = BigInt(input.amount);
    if (account.balance - account.held < amount) {
      throw new WalletRejectedError('INSUFFICIENT_FUNDS', 'недостаточно средств');
    }
    account.held += amount;
    const id = this.nextId('hold');
    this.holds.set(id, { id, accountId: input.accountId, amount, status: 'active' });
    this.byKey.set(input.idempotencyKey, id);
    return { id, currency: account.currency };
  }

  async captureHold(holdId: string, toAccountId: string): Promise<{ transferId: string }> {
    this.calls.captureHold++;
    this.maybeFail();
    const hold = this.hold(holdId);
    if (hold.status === 'captured') return { transferId: hold.transferId! };
    if (hold.status === 'released')
      throw new WalletRejectedError('HOLD_STATE_CONFLICT', 'холд снят');

    const payer = this.account(hold.accountId);
    payer.held -= hold.amount;
    payer.balance -= hold.amount;
    this.account(toAccountId).balance += hold.amount;
    hold.status = 'captured';
    hold.transferId = this.nextId('transfer');
    return { transferId: hold.transferId };
  }

  async releaseHold(holdId: string): Promise<void> {
    this.calls.releaseHold++;
    this.maybeFail();
    const hold = this.hold(holdId);
    if (hold.status === 'released') return;
    if (hold.status === 'captured')
      throw new WalletRejectedError('HOLD_STATE_CONFLICT', 'холд уже списан');
    this.account(hold.accountId).held -= hold.amount;
    hold.status = 'released';
  }

  async transfer(input: {
    idempotencyKey: string;
    fromAccountId: string;
    toAccountId: string;
    amount: string;
  }): Promise<{ transferId: string }> {
    this.calls.transfer++;
    this.maybeFail();
    const known = this.transfers.get(input.idempotencyKey);
    if (known) return { transferId: known };

    const amount = BigInt(input.amount);
    const from = this.account(input.fromAccountId);
    if (from.balance - from.held < amount) {
      throw new WalletRejectedError('INSUFFICIENT_FUNDS', 'недостаточно средств');
    }
    from.balance -= amount;
    this.account(input.toAccountId).balance += amount;
    const id = this.nextId('transfer');
    this.transfers.set(input.idempotencyKey, id);
    return { transferId: id };
  }

  private maybeFail(): void {
    if (this.failNextCalls > 0) {
      this.failNextCalls--;
      throw new WalletUnavailableError('сеть недоступна');
    }
  }

  private account(id: string): FakeAccount {
    const account = this.accounts.get(id);
    if (!account) throw new WalletRejectedError('ACCOUNT_NOT_FOUND', `счёт ${id} не найден`);
    return account;
  }

  private hold(id: string): FakeHold {
    const hold = this.holds.get(id);
    if (!hold) throw new WalletRejectedError('HOLD_NOT_FOUND', `холд ${id} не найден`);
    return hold;
  }

  private nextId(prefix: string): string {
    // Валидный UUID: id попадают в uuid-колонки payments.
    const n = (++this.seq).toString(16).padStart(12, '0');
    return `${prefix === 'hold' ? '00000001' : '00000002'}-0000-4000-8000-${n}`;
  }
}
