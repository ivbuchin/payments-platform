/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleNameMapper: {
    '^@pp/contracts$': '<rootDir>/../../libs/contracts/src',
    '^@pp/nest-kit$': '<rootDir>/../../libs/nest-kit/src',
  },
  testTimeout: 60000,
};
