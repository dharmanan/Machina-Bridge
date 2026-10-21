import type { Plugin } from 'vite'
import handler from '../uniswap-arc-preview'

// Local Vite adapter for the same server-only handler used by /api on Vercel.
// Requires the same server environment variables and origin policy; no fallback keys.
export function uniswapArcDevPreview(): Plugin {
  return {
    name: 'machina-uniswap-arc-preview',
    configureServer(server) {
      server.middlewares.use('/api/uniswap-arc-preview', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        const response = {
          setHeader(name: string, value: string) { res.setHeader(name, value) },
          status(code: number) { res.statusCode = code; return response },
          json(body: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) },
        }
        try {
          let body = ''
          if (req.method === 'POST') {
            let size = 0
            const chunks: Buffer[] = []
            for await (const chunk of req) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              size += bytes.length
              if (size > 8192) { response.status(413).json({ error: 'request_too_large' }); return }
              chunks.push(bytes)
            }
            body = Buffer.concat(chunks).toString('utf8')
          }
          await handler({ method: req.method, headers: req.headers, body }, response)
        } catch { response.status(503).json({ error: 'uniswap_arc_review_blocked', writesEnabled: false }) }
      })
    },
  }
}
