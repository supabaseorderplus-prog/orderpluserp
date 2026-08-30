import { configDefaults, defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: [
      'src/__tests__/diagnostic-api.test.ts',
      'src/__tests__/salesman-dropdown-bug-condition.test.ts',
      'src/__tests__/salesman-dropdown-preservation.test.ts',
    ],
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
