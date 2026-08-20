import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'dsh-llm-as-verifier/core': fileURLToPath(new URL('./src/verifier/index.ts', import.meta.url)),
      'dsh-llm-as-verifier/provider': fileURLToPath(new URL('./src/provider/index.ts', import.meta.url)),
      'dsh-llm-as-verifier/observer': fileURLToPath(new URL('./src/observer/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
  },
})
