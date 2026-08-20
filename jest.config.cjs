/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.backend.json' }],
  },
  collectCoverageFrom: ['backend/services/*.ts'],
  coveragePathIgnorePatterns: ['probe.controller.ts'],
  moduleNameMapper: {
    '^@ones-open/node-sdk$': '<rootDir>/backend/test/sdk.mock.ts',
  },
}
