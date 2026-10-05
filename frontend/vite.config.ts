import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    // Demo tunnel hosts only — keep public-host access explicit. A page served through the tunnel
    // reads the local chain through same-origin `/rpc`, proxied to Anvil below.
    allowedHosts: ['demo.mysun.dev'],
    proxy: { '/rpc': { target: 'http://127.0.0.1:8547', rewrite: (p: string) => p.replace(/^\/rpc/, '') || '/' } },
  },
  test: {
    // Logic tests run in node; the render smoke test opts into jsdom with a per-file pragma.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
} as any);
