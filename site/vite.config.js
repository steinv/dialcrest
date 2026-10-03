import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Never inline small assets as data: URIs — the CSP only allows img-src 'self'.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        faq: resolve(__dirname, 'faq.html'),
        privacy: resolve(__dirname, 'privacy.html'),
      },
    },
  },
});
