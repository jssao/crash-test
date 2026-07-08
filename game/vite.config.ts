import { defineConfig } from 'vite';

// GitHub Pages compatible: relative base so the build works from any subpath
// (project pages served at /<repo>/ as well as a user/org root site).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
