import { DomainError as BaseDomainError } from '@pp/nest-kit';

export type DomainErrorCode =
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_STATE_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'REFUND_REJECTED'
  | 'WALLET_UNAVAILABLE';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  PAYMENT_NOT_FOUND: 404,
  PAYMENT_STATE_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  REFUND_REJECTED: 422,
  WALLET_UNAVAILABLE: 503,
};

export class DomainError extends BaseDomainError {
  constructor(code: DomainErrorCode, message: string) {
    super(code, message, HTTP_STATUS[code]);
  }
}
