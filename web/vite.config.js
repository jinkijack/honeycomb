import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const DAEMON = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    // shared/ vive acima da raiz do front; sem isso o dev server recusa servir
    fs: { allow: ['..'] },
    proxy: {
      '/api': DAEMON,
      '/ws': { target: DAEMON, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
