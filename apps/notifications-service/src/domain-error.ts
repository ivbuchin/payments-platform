import { DomainError as BaseDomainError } from '@pp/nest-kit';

export type DomainErrorCode =
  'WEBHOOK_NOT_FOUND' | 'WEBHOOK_URL_REJECTED' | 'DELIVERY_NOT_FOUND' | 'DELIVERY_STATE_CONFLICT';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  WEBHOOK_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  DELIVERY_STATE_CONFLICT: 409,
  WEBHOOK_URL_REJECTED: 422,
};

export class DomainError extends BaseDomainError {
  constructor(code: DomainErrorCode, message: string) {
    super(code, message, HTTP_STATUS[code]);
  }
}
