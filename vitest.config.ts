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
        lines: 35,
        branches: 30,
        functions: 40,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
