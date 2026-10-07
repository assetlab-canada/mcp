import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for @assetlab/mcp-server
 *
 * Hermetic, parallel-safe tests. No live network calls.
 * All HTTP boundaries (fetch, KV) are mocked via in-memory fakes.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    isolate: true,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'dist/**'],
      reporter: ['text', 'html'],
    },
    reporters: ['default'],
  },
})
