/**
 * Контракты доменных событий, которыми обмениваются сервисы через RabbitMQ.
 *
 * Правила версионирования: поля можно только добавлять; при несовместимом изменении
 * вводится новый тип события (`wallet.hold.created.v2`), старый живёт, пока есть потребители.
 */

/** Единый конверт события: потребитель дедуплицирует по `id`. */
export interface EventEnvelope<TType extends string, TPayload> {
  /** UUID события; стабилен при повторной доставке. */
  readonly id: string;
  readonly type: TType;
  /** ISO-8601, момент фиксации факта в БД источника. */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Суммы передаются строкой в минорных единицах (копейки), чтобы не терять точность bigint. */
export type MinorUnits = string;

export interface HoldCreatedPayload {
  holdId: string;
  accountId: string;
  amount: MinorUnits;
  currency: string;
  reference: string | null;
}

export interface HoldSettledPayload {
  holdId: string;
  accountId: string;
  amount: MinorUnits;
  currency: string;
  reference: string | null;
}

export interface TransferCompletedPayload {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: MinorUnits;
  currency: string;
  reference: string | null;
}

export type WalletEvent =
  | EventEnvelope<'wallet.hold.created', HoldCreatedPayload>
  | EventEnvelope<'wallet.hold.captured', HoldSettledPayload>
  | EventEnvelope<'wallet.hold.released', HoldSettledPayload>
  | EventEnvelope<'wallet.transfer.completed', TransferCompletedPayload>;

export type PaymentStatus =
  'created' | 'authorized' | 'captured' | 'refunded' | 'canceled' | 'failed';

export interface PaymentStatusChangedPayload {
  paymentId: string;
  status: PaymentStatus;
  amount: MinorUnits;
  currency: string;
  payerAccountId: string;
  merchantAccountId: string;
  failureReason: string | null;
}

export type PaymentEvent = EventEnvelope<'payment.status_changed', PaymentStatusChangedPayload>;

export type PlatformEvent = WalletEvent | PaymentEvent;
export type PlatformEventType = PlatformEvent['type'];

/** Топология RabbitMQ: один topic-exchange, routing key = тип события. */
export const EVENTS_EXCHANGE = 'pp.events';

/** Событие без служебных полей конверта (`id`, `occurredAt` проставляет outbox). */
export type NewEvent<E extends PlatformEvent = PlatformEvent> = E extends {
  type: infer K;
  payload: infer P;
}
  ? { type: K; payload: P }
  : never;

/** Все типы событий во время выполнения — для валидации подписок и маршрутизации. */
export const EVENT_TYPES = [
  'wallet.hold.created',
  'wallet.hold.captured',
  'wallet.hold.released',
  'wallet.transfer.completed',
  'payment.status_changed',
] as const satisfies readonly PlatformEventType[];
