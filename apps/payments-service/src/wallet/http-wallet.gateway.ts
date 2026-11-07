import { Injectable } from '@nestjs/common';
import {
  WalletGateway,
  WalletRejectedError,
  WalletUnavailableError,
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

  private async post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new WalletUnavailableError(`wallet-service недоступен: ${String(cause)}`, { cause });
    }

    if (response.ok) return (await response.json()) as T;

    const error = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    if (response.status >= 500) {
      throw new WalletUnavailableError(`wallet-service ответил ${response.status}`);
    }
    throw new WalletRejectedError(
      error.code ?? `HTTP_${response.status}`,
      error.message ?? `wallet-service отклонил запрос (${response.status})`,
    );
  }
}
