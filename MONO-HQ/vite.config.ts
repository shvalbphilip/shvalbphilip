import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // assetsInlineLimit 0: never inline assets as data: URIs. The CSP (default-src 'self') blocks data: fonts, and the
  // smallest self-hosted font files were being inlined, which produced CSP errors in the console.
  build: { outDir: '../dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
