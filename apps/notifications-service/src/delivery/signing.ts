import { createHmac, timingSafeEqual } from 'node:crypto';

/** Подписанная строка — `<unix-секунды>.<тело>`: временная метка защищает от replay-атак. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Значение заголовка `X-PP-Signature`: `t=<ts>,v1=<hmac>`. */
export function buildSignatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;
}

/**
 * Проверка подписи на стороне получателя (экспортируется для документации и тестов).
 * Сравнение в постоянном времени; `toleranceSec` ограничивает возраст запроса.
 */
export function verifySignatureHeader(
  secret: string,
  header: string,
  body: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;

  const expected = Buffer.from(signPayload(secret, timestamp, body), 'hex');
  const actual = Buffer.from(parts.v1, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
