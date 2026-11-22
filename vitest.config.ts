import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig({
  ...viteConfig,
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['src/shared/common/**'],
    env: { NODE_ENV: 'test' },
    environment: 'node',
  },
});
