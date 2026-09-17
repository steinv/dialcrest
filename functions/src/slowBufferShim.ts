/**
 * Restores `buffer.SlowBuffer`, removed in Node 24+ (long deprecated as
 * DEP0030). The transitive dependency `buffer-equal-constant-time` — pulled in
 * via firebase-admin → jsonwebtoken → jws → jwa — reads `SlowBuffer.prototype`
 * at module-load time, so on a Node without SlowBuffer the very `require` of
 * firebase-admin throws "Cannot read properties of undefined (reading
 * 'prototype')". That would crash every Cloud Function at cold start.
 *
 * SlowBuffer was historically just Buffer; pointing it at Buffer gives the
 * dependency the `.prototype` it reads. Guarded, so it's a no-op on Node
 * versions that still ship SlowBuffer.
 *
 * IMPORTANT: this module must be imported before anything that pulls in
 * firebase-admin (i.e. first in index.ts), so the shim runs before that
 * `require` chain evaluates.
 */
import { Buffer } from 'buffer';

const bufferModule = require('buffer') as { SlowBuffer?: unknown };
if (bufferModule.SlowBuffer === undefined) {
    bufferModule.SlowBuffer = Buffer;
}
