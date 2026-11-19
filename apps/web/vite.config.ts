import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The page talks to the console API on the same origin; SSE passes through this proxy too.
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, changeOrigin: true } },
  },
});
