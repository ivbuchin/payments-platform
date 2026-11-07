export interface WalletAccount {
  id: string;
  currency: string;
  kind: 'user' | 'system';
}

export interface WalletHold {
  id: string;
  currency: string;
}

/** Бизнес-отказ wallet-service (4xx): повтор бессмыслен, платёж переводится в итоговое состояние. */
export class WalletRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletRejectedError';
  }
}

/** Транспортный сбой или 5xx: исход неизвестен, операцию безопасно повторить с тем же ключом. */
export class WalletUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalletUnavailableError';
  }
}

/**
 * Порт к wallet-service. Все методы идемпотентны: ключи детерминированно выводятся из id платежа,
 * поэтому повтор после сбоя не удвоит списание.
 */
export abstract class WalletGateway {
  /** Бизнес-отказ `ACCOUNT_NOT_FOUND`, если счёта нет. */
  abstract getAccount(id: string): Promise<WalletAccount>;

  abstract createHold(input: {
    idempotencyKey: string;
    accountId: string;
    amount: string;
    reference: string;
  }): Promise<WalletHold>;

  abstract captureHold(holdId: string, toAccountId: string): Promise<{ transferId: string }>;

  abstract releaseHold(holdId: string): Promise<void>;

  abstract transfer(input: {
    idempotencyKey: string;
    fromAccountId: string;
    toAccountId: string;
    amount: string;
    reference: string;
  }): Promise<{ transferId: string }>;
}
