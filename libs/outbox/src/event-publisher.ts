import type { EventEnvelope } from '@pp/contracts';

/** Порт публикации: релей не знает о брокере, что упрощает тесты и замену транспорта. */
export abstract class EventPublisher {
  /** Должен завершиться только после подтверждения брокером (publisher confirm). */
  abstract publish(event: EventEnvelope<string, unknown>): Promise<void>;
  abstract close(): Promise<void>;
}
