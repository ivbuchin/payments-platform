import { loadEnv } from './env';

describe('loadEnv', () => {
  it('подставляет порт по умолчанию', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/wallet' }).PORT).toBe(3001);
  });

  it('падает без DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
