import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
  const proxyTarget = process.env.CLIPROXY_DEV_PROXY_TARGET ?? 'http://localhost:8300';
  const configuredPort = Number(process.env.CLIPROXY_DASHBOARD_PORT ?? 5300);
  const dashboardPort = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 5300;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: dashboardPort,
      strictPort: true,
      proxy: {
        '/admin': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/v1': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/health': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
