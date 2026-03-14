import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5300,
    strictPort: true,
    proxy: {
      '/admin': {
        target: 'http://localhost:8300',
        changeOrigin: true,
      },
    },
  },
});
