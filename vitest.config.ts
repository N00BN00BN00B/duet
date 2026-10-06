import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', ...(process.env.DUET_LIVE ? ['tests/live/**/*.test.ts'] : [])],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
