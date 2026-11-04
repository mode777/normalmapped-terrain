import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 8192,
    rollupOptions: {
      input: {
        infinite: resolve(process.cwd(), 'infinite.html'),
        dem: resolve(process.cwd(), 'dem.html'),
      },
    },
  },
});
