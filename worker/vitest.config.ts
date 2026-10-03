import { defineConfig } from 'vitest/config';

// Unit tests run in Node, which has the same WebCrypto/fetch/Request/Response
// globals the Worker uses; fetch to Google/FCM is stubbed per test.
export default defineConfig({
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
