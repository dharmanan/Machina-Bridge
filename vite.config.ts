import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleIntelligenceProxy } from './api/_lib/intelligence-proxy.js'

function intelligenceDevProxy(): Plugin {
  return {
    name: 'machina-intelligence-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/intelligence', (req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')
        const query: Record<string, string> = {}
        for (const [key, value] of requestUrl.searchParams.entries()) query[key] = value
        void handleIntelligenceProxy({
          method: req.method ?? 'GET',
          headers: req.headers,
          query,
          send(status, body, headers = {}) {
            if (headers.allow) res.setHeader('Allow', headers.allow)
            res.statusCode = status
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          },
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), intelligenceDevProxy()],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  server: {
    port: 3000,
    host: 'localhost',
    strictPort: false,
  },
  optimizeDeps: {
    exclude: ['@base-org/account'],
    include: ['buffer'],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/wagmi/')) {
            return 'wagmi'
          }
        },
      },
    },
  },
})
