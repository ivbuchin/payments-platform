/**
 * Деньги — всегда целые числа в минорных единицах (копейки/центы).
 * В домене это bigint, в API и событиях — десятичная строка: JSON number теряет точность выше 2^53.
 */
export const AMOUNT_PATTERN = /^[1-9]\d{0,17}$/;

export const AMOUNT_PATTERN_MESSAGE =
  'amount: положительное целое в минорных единицах, строкой, до 18 цифр';

export function parseAmount(raw: string): bigint {
  if (!AMOUNT_PATTERN.test(raw)) {
    throw new RangeError(AMOUNT_PATTERN_MESSAGE);
  }
  return BigInt(raw);
}

/** Трансформер колонок `bigint`: pg отдаёт их строкой, домен работает с bigint. */
export const bigintTransformer = {
  to: (value: bigint | null | undefined): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value: string | null): bigint | null => (value === null ? null : BigInt(value)),
};
