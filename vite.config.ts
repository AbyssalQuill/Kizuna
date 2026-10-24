import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',   // 显式绑 IPv4：绑定 localhost 时 Node 可能只监听 ::1，127.0.0.1 会连不上
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:1921',
        changeOrigin: true,
      },
    },
  },
  envPrefix: ['VITE_'],
  build: {
    target: ['es2022', 'chrome100'],
    minify: 'esbuild',
    // 默认关闭体积庞大的 sourcemap（从 2.2MB 减到 0），实现秒级重构；需要调试时传入 VITE_SOURCEMAP=true
    sourcemap: process.env.VITE_SOURCEMAP === 'true' ? true : false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand', 'lucide-react'],
        },
      },
    },
  },
});
