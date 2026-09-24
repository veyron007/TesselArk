import { defineConfig } from 'vite';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.ERP_API_PORT || 3001}` },
  },
});
