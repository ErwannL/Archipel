import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/ui', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/ui': 'http://127.0.0.1:8080' } },
});
