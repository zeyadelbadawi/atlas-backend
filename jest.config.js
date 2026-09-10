// Unit test configuration — runs against every `*.spec.ts` file under src/,
// no external infrastructure required.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // `otplib` v13 and its `@scure`/`@noble` crypto dependencies ship
  // ESM-only entry points, which Jest cannot parse under the default
  // "never transform node_modules" rule. Transforming just those packages
  // is narrower and safer than switching the whole suite to native ESM.
  transformIgnorePatterns: ['node_modules/(?!(otplib|@otplib|@scure|@noble)/)'],
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@common/(.*)$': '<rootDir>/common/$1',
    '^@database/(.*)$': '<rootDir>/database/$1',
    '^@redis/(.*)$': '<rootDir>/redis/$1',
    '^@health/(.*)$': '<rootDir>/health/$1',
  },
};
