import { bigintTransformer, parseAmount } from './money';

describe('parseAmount', () => {
  it.each(['1', '100', '999999999999'])('принимает %s', (raw) => {
    expect(parseAmount(raw)).toBe(BigInt(raw));
  });

  it.each(['0', '-5', '1.5', '01', '', ' 1', '1e3', '1000000000000'])('отклоняет %j', (raw) => {
    expect(() => parseAmount(raw)).toThrow(RangeError);
  });
});

describe('bigintTransformer', () => {
  it('сохраняет точность выше 2^53', () => {
    const big = 9007199254740993n;
    expect(bigintTransformer.from(bigintTransformer.to(big) as string)).toBe(big);
  });

  it('пропускает null', () => {
    expect(bigintTransformer.from(null)).toBeNull();
    expect(bigintTransformer.to(null)).toBeNull();
  });
});
