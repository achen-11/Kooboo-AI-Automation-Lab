import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ root: 'frontend', plugins: [vue()], server: { host: '127.0.0.1', port: 4181, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4180' } }, build: { outDir: '../dist', emptyOutDir: true } });
