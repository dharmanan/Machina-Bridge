import { handleIntelligenceProxy } from './_lib/intelligence-proxy.js'

export default async function handler(req, res) {
  return handleIntelligenceProxy({
    method: req.method,
    headers: req.headers,
    query: req.query,
    // The proxy decides every header (Content-Type, Cache-Control, ETag, Allow); upstream headers are never copied here.
    send({ status, headers, body }) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      if (body === null) return res.status(status).end()
      return res.status(status).send(body)
    },
  })
}
