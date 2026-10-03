import { handleBorrowMarketsProxy } from './_lib/borrow-markets-proxy.js'

export default async function handler(req, res) {
  return handleBorrowMarketsProxy({
    method: req.method,
    headers: req.headers,
    query: req.query,
    // The proxy decides every header (Content-Type, Cache-Control, Allow); upstream headers are never copied here.
    send({ status, headers, body }) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      return res.status(status).send(body)
    },
  })
}
