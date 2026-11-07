export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/**
 * Экспоненциальная пауза с «полным джиттером»: случайное значение в [0, min(max, base·2^n)].
 * Джиттер разносит повторы во времени, чтобы упавший получатель не получал синхронный шквал запросов.
 * `random` инжектируется ради детерминированных тестов.
 */
export function computeBackoffMs(
  attempt: number,
  { baseMs, maxMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling) + 1;
}
