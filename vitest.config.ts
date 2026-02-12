import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/cli/**',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 48,
        branches: 40,
        functions: 50,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
