import { fingerprint } from './idempotency';

describe('fingerprint', () => {
  it('детерминирован', () => {
    expect(fingerprint(['a', 1n, null])).toBe(fingerprint(['a', 1n, null]));
  });

  it('различает значения и их порядок', () => {
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['b', 'a']));
    expect(fingerprint(['a', 1n])).not.toBe(fingerprint(['a', 2n]));
  });

  it('отличает null от строки "null"', () => {
    expect(fingerprint(['a', null])).not.toBe(fingerprint(['a', 'null']));
  });

  it('не склеивает соседние поля', () => {
    expect(fingerprint(['ab', 'c'])).not.toBe(fingerprint(['a', 'bc']));
  });
});
