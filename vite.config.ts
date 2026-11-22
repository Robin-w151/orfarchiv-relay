import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    ssr: true,
    lib: {
      entry: {
        relay: './src/index.ts',
      },
      formats: ['es'],
      name: 'relay',
    },
    emptyOutDir: true,
  },
});
