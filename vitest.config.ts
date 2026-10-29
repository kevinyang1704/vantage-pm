import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'spikes/phase-0-durability/tests/**/*.spec.ts',
      'src/**/*.spec.ts',
      'tests/perf/**/*.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/perf/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/domain/**/*.policy.ts',
        'src/adapters/ui/forecast/forecast-placement.ts',
        'spikes/phase-0-durability/src/migration-protocol.ts',
        'spikes/phase-0-durability/src/update-gate.ts',
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 60,
        branches: 50,
        perFile: true,
        'src/adapters/ui/forecast/forecast-placement.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        'spikes/phase-0-durability/src/migration-protocol.ts': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 90,
        },
        'spikes/phase-0-durability/src/update-gate.ts': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 90,
        },
      },
    },
  },
});
