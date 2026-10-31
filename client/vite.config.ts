import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on :4000; proxying keeps the session cookie same-origin during development.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  build: { outDir: 'dist' },
});
