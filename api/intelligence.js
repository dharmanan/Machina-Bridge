import { handleIntelligenceProxy, sendJson } from './_lib/intelligence-proxy.js'

export default async function handler(req, res) {
  return handleIntelligenceProxy({
    method: req.method,
    headers: req.headers,
    query: req.query,
    send(status, body, headers = {}) {
      if (headers.allow) res.setHeader('Allow', headers.allow)
      return sendJson(res, status, body)
    },
  })
}
