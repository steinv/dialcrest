/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // Restores buffer.SlowBuffer (removed in Node 24+), which a transitive dep of
  setupFiles: ['<rootDir>/jest.setup.js'],
  clearMocks: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
