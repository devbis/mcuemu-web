import { defineConfig } from 'vite';

export default defineConfig({
  base: '/mcuemu-web/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
