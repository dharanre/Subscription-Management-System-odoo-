import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on :4000; proxying keeps the session cookie same-origin during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Vite rewrites the Host header to the API's own when the target is given as a bare string. The API only
      // accepts a write when its Origin is the configured app URL or matches the Host it was sent, so a dev
      // server that landed on another port (5174 when 5173 is busy) got "Cross-site requests are not allowed".
      // Passing the browser's Host through keeps that check true on whatever port or address the page is on.
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist' },
});
