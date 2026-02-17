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
        lines: 74,
        branches: 70,
        functions: 75,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
