import type { PaymentStatus } from '@pp/contracts';

/**
 * Конечный автомат платежа. Единственный источник истины о допустимых переходах:
 * и сервис, и тесты опираются на эту таблицу.
 *
 *   created ──► authorized ──► captured ──► refunded
 *      │            │
 *      ▼            ▼
 *    failed      canceled
 */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['authorized', 'failed'],
  authorized: ['captured', 'canceled'],
  captured: ['refunded'],
  refunded: [],
  canceled: [],
  failed: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
