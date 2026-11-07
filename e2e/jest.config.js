/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { warnOnly: false } },
    ],
  },
  moduleNameMapper: {
    '^@pp/contracts$': '<rootDir>/../libs/contracts/src',
    '^@pp/nest-kit$': '<rootDir>/../libs/nest-kit/src',
    '^@pp/outbox$': '<rootDir>/../libs/outbox/src',
  },
  testTimeout: 120000,
};
