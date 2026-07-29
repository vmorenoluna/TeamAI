import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],  // type incompatibility between vitest 1.x and @vitejs/plugin-react 4.x vite types
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/vitest-setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      reporter: ['text', 'text-summary', 'html'],
    },
    server: {
      deps: {
        inline: ['@/lib/utils', '@/lib/task-store'],
      },
    },
    // jsdom environment used for component tests via @vitest-environment jsdom pragma
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
