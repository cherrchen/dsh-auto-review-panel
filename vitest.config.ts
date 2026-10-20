import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['node_modules/**'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.e2e.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
