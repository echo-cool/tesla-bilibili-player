import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation headers so SharedArrayBuffer (used by the libmedia
// threaded WASM decode path) is available during development too.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: coiHeaders,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    headers: coiHeaders,
  },
  worker: {
    format: 'es',
  },
});
