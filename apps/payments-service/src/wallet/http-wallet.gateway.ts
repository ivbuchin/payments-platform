import { Injectable } from '@nestjs/common';
import {
  WalletGateway,
  WalletRejectedError,
  WalletUnavailableError,
  type WalletAccount,
  type WalletHold,
} from './wallet.gateway';

export interface HttpWalletGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
}

@Injectable()
export class HttpWalletGateway extends WalletGateway {
  constructor(private readonly options: HttpWalletGatewayOptions) {
    super();
  }

  async getAccount(id: string): Promise<WalletAccount> {
    const account = await this.request<WalletAccount>('GET', `/accounts/${id}`);
    return { id: account.id, currency: account.currency, kind: account.kind };
  }

  async createHold(input: {
    idempotencyKey: string;
    accountId: string;
    amount: string;
    reference: string;
  }): Promise<WalletHold> {
    const hold = await this.post<{ id: string; currency: string }>(
      '/holds',
      { accountId: input.accountId, amount: input.amount, reference: input.reference },
      input.idempotencyKey,
    );
    return { id: hold.id, currency: hold.currency };
  }

  async captureHold(holdId: string, toAccountId: string): Promise<{ transferId: string }> {
    const result = await this.post<{ transfer: { id: string } }>(`/holds/${holdId}/capture`, {
      toAccountId,
    });
    return { transferId: result.transfer.id };
  }

  async releaseHold(holdId: string): Promise<void> {
    await this.post(`/holds/${holdId}/release`, {});
  }

  async transfer(input: {
    idempotencyKey: string;
    fromAccountId: string;
    toAccountId: string;
    amount: string;
    reference: string;
  }): Promise<{ transferId: string }> {
    const { idempotencyKey, ...body } = input;
    const transfer = await this.post<{ id: string }>('/transfers', body, idempotencyKey);
    return { transferId: transfer.id };
  }

  private post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  /**
   * Любой сбой, после которого исход неизвестен (сеть, таймаут, обрыв тела ответа, 5xx, 408, 429),
   * — `WalletUnavailableError`: операцию безопасно повторить с тем же ключом. Остальные 4xx —
   * бизнес-отказ, повтор бессмыслен.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      payload = await response.json().catch((cause: unknown) => {
        if (response.ok) throw cause;
        return {};
      });
    } catch (cause) {
      throw new WalletUnavailableError(`wallet-service недоступен: ${String(cause)}`, { cause });
    }

    if (response.ok) return payload as T;

    const status = response.status;
    if (status >= 500 || status === 408 || status === 429) {
      throw new WalletUnavailableError(`wallet-service ответил ${status}`);
    }
    const error = payload as { code?: string; message?: string };
    throw new WalletRejectedError(
      error.code ?? `HTTP_${status}`,
      error.message ?? `wallet-service отклонил запрос (${status})`,
    );
  }
}
