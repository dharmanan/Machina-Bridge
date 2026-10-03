import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleBorrowMarketsProxy } from './api/_lib/borrow-markets-proxy.js'
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
          send({ status, headers, body }: { status: number; headers: Record<string, string>; body: string | null }) {
            for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
            res.setHeader('Cache-Control', 'no-store')
            res.statusCode = status
            res.end(body ?? undefined)
          },
        })
      })
      // Same read-only Borrow market proxy as Vercel /api/borrow-markets, so local dev never calls Circle from the browser.
      server.middlewares.use('/api/borrow-markets', (req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')
        const query: Record<string, string> = {}
        for (const [key, value] of requestUrl.searchParams.entries()) query[key] = value
        void handleBorrowMarketsProxy({
          method: req.method ?? 'GET',
          headers: req.headers,
          query,
          send({ status, headers, body }: { status: number; headers: Record<string, string>; body: string }) {
            for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
            res.setHeader('Cache-Control', 'no-store')
            res.statusCode = status
            res.end(body)
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
