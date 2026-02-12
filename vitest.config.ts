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
        lines: 65,
        branches: 52,
        functions: 67,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
