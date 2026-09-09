import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: Object.fromEntries(['/v1', '/api/auth', '/mcp', '/.well-known', '/unsubscribe', '/health', '/openapi.json'].map(path => [path, {target: 'http://127.0.0.1:8793', changeOrigin: false}])),
  },
})
