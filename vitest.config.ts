import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // The published ui-primitives bundle imports shiki and CSS modules,
      // neither of which loads under the vitest forks pool. Tests assert
      // behavior, not styling, so they run against a prop-compatible stub.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/support/ui-primitives-stub.tsx', import.meta.url),
      ),
    },
  },
  test: {
    exclude: ['node_modules/**'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.e2e.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
