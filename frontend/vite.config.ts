import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: { '/rpc': { target: 'http://127.0.0.1:8547', rewrite: (p: string) => p.replace(/^\/rpc/, '') || '/' } },
  },
  test: {
    // Logic tests run in node; the render smoke test opts into jsdom with a per-file pragma.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Deterministic env for the suite: see the setup file for why WalletConnect is pinned off.
    setupFiles: ['./src/test/setup.ts'],
  },
} as any);