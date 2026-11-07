import { DomainError as BaseDomainError } from '@pp/nest-kit';

/** Стабильные машинные коды ошибок — часть публичного контракта API. */
export type DomainErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'TRANSFER_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'SAME_ACCOUNT'
  | 'INSUFFICIENT_FUNDS'
  | 'SYSTEM_ACCOUNT_FORBIDDEN'
  | 'BALANCE_LIMIT_EXCEEDED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'HOLD_NOT_FOUND'
  | 'HOLD_STATE_CONFLICT';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  ACCOUNT_NOT_FOUND: 404,
  HOLD_NOT_FOUND: 404,
  TRANSFER_NOT_FOUND: 404,
  ACCOUNT_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  HOLD_STATE_CONFLICT: 409,
  CURRENCY_MISMATCH: 422,
  SAME_ACCOUNT: 422,
  INSUFFICIENT_FUNDS: 422,
  BALANCE_LIMIT_EXCEEDED: 422,
  SYSTEM_ACCOUNT_FORBIDDEN: 403,
};

/** Бизнес-ошибка wallet-service; транспортный слой (`DomainErrorFilter`) отдаёт её как `{ code, message }`. */
export class DomainError extends BaseDomainError {
  constructor(code: DomainErrorCode, message: string) {
    super(code, message, HTTP_STATUS[code]);
  }
}
