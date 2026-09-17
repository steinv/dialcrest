/**
 * Node 24+ removed `buffer.SlowBuffer` (long deprecated as DEP0030). The
 * transitive dependency `buffer-equal-constant-time` — pulled in via
 * firebase-admin → jsonwebtoken → jws → jwa — reads `SlowBuffer.prototype` at
 * module load time, so on a Node without SlowBuffer that `require` throws
 * "Cannot read properties of undefined (reading 'prototype')" before any test
 * runs. index.test.ts hits this because it loads the real firebase-functions
 * (needed to build the Cloud Function handlers it invokes), which imports the
 * real firebase-admin auth module via a subpath the firebase-admin jest mock
 * doesn't intercept.
 *
 * SlowBuffer was historically just Buffer; pointing it at Buffer gives the
 * dependency the `.prototype` it reads. runs as a Jest `setupFiles` entry, i.e.
 * before any module under test is required.
 *
 * NOTE: this is a test-runtime shim only. If the deployed Cloud Functions
 * runtime is ever bumped to nodejs24+, this same dependency will crash on cold
 * start in production — the real fix there is a Node runtime that still ships
 * SlowBuffer (nodejs22) or an updated dependency tree.
 */
const buffer = require('buffer');
if (buffer.SlowBuffer === undefined) {
    buffer.SlowBuffer = buffer.Buffer;
}
