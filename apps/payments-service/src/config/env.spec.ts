import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  WALLET_URL: 'http://localhost:3001',
  WALLET_KEY_SECRET: 'f3a9c1d27b8e4a6f90b1c2d3e4f5a6b7',
};

describe('loadEnv: WALLET_KEY_SECRET', () => {
  it('принимает случайный секрет', () => {
    expect(loadEnv(base).WALLET_KEY_SECRET).toBe(base.WALLET_KEY_SECRET);
  });

  it.each(['короткий', 'dev-only-change-me-0123456789', 'change-me-change-me-change'])(
    'отклоняет %j',
    (secret) => {
      expect(() => loadEnv({ ...base, WALLET_KEY_SECRET: secret })).toThrow(/WALLET_KEY_SECRET/);
    },
  );

  it('требует секрет', () => {
    expect(() => loadEnv({ ...base, WALLET_KEY_SECRET: undefined })).toThrow(/WALLET_KEY_SECRET/);
  });
});
