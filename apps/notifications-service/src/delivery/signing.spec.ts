import { buildSignatureHeader, verifySignatureHeader } from './signing';

const NOW = 1_700_000_000;
const BODY = '{"id":"1"}';

describe('подпись вебхука', () => {
  it('валидная подпись проходит проверку', () => {
    const header = buildSignatureHeader('s3cret', NOW, BODY);
    expect(verifySignatureHeader('s3cret', header, BODY, NOW)).toBe(true);
  });

  it('отклоняет изменённое тело и чужой секрет', () => {
    const header = buildSignatureHeader('s3cret', NOW, BODY);
    expect(verifySignatureHeader('s3cret', header, BODY + ' ', NOW)).toBe(false);
    expect(verifySignatureHeader('other', header, BODY, NOW)).toBe(false);
  });

  it('отклоняет устаревший запрос (replay)', () => {
    const header = buildSignatureHeader('s3cret', NOW, BODY);
    expect(verifySignatureHeader('s3cret', header, BODY, NOW + 301)).toBe(false);
    expect(verifySignatureHeader('s3cret', header, BODY, NOW + 299)).toBe(true);
  });

  it('отклоняет мусор вместо заголовка', () => {
    expect(verifySignatureHeader('s3cret', 'garbage', BODY, NOW)).toBe(false);
    expect(verifySignatureHeader('s3cret', 't=abc,v1=zz', BODY, NOW)).toBe(false);
  });
});
