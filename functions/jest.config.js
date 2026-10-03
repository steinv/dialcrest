/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  clearMocks: true,
  // Node 24+ dropped buffer.SlowBuffer, which twilio/firebase-admin/the Apple
  // library (via jsonwebtoken) read at load time. index.ts loads the shim first in
  // production; tests import modules directly, so load it before every suite —
  // otherwise whether it ran depends on which suite a worker happened to run first.
  setupFiles: ['<rootDir>/src/slowBufferShim.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
