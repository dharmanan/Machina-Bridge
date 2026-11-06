// Request and upstream limits for the same-origin Solana RPC proxies (api/solana-rpc.js,
// api/solana-read.js). No storage, no external service, no dependency: every check is a pure
// function of the request or of the upstream response. Rate limiting is NOT done here.

export const MAX_RPC_BODY_BYTES = 16 * 1024
export const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024

// The only program/filter shape the app sends through the proxy (src/lib/mainnetSolanaReclaim.ts:
// discoverProgramAccountsThroughProxy): CCTP V2 MessageTransmitter accounts whose rent payee
// (offset 8, right after the Anchor discriminator) is the connected wallet.
export const CCTP_MESSAGE_TRANSMITTER_PROGRAM = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'

const MAX_SIGNATURES_FOR_ADDRESS_LIMIT = 100
const MAX_SIGNATURE_STATUSES = 256
const MAX_MULTIPLE_ACCOUNTS = 100
// A Solana transaction is at most 1232 bytes: 1644 chars in base64, 1683 in base58.
const MAX_ENCODED_TRANSACTION_CHARS = 2048
const MAX_PARAMS = 3
const MAX_ID_CHARS = 128
const COMMITMENTS = new Set(['processed', 'confirmed', 'finalized'])

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export class RpcRequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const reject = (status, code, message) => { throw new RpcRequestError(status, code, message) }
const invalidParams = message => reject(400, -32602, message)
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function base58ByteLength(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || !BASE58.test(value)) return -1
  const bytes = [0]
  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char)
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  let leadingZeros = 0
  while (value[leadingZeros] === '1') leadingZeros++
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop()
  const significant = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length
  return leadingZeros + significant
}

export const isSolanaAddress = value => base58ByteLength(value) === 32
const isSignature = value => base58ByteLength(value) === 64

function headerValue(req, name) {
  const value = req.headers?.[name]
  return typeof (Array.isArray(value) ? value[0] : value) === 'string' ? String(Array.isArray(value) ? value[0] : value) : ''
}

// Body checks run before anything is parsed or forwarded. Vercel parses an application/json body
// lazily and throws on malformed JSON, so the access itself is guarded.
export function readJsonBody(req, maxBytes = MAX_RPC_BODY_BYTES) {
  const mediaType = headerValue(req, 'content-type').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') reject(415, -32600, 'Content-Type must be application/json')

  const declared = headerValue(req, 'content-length').trim()
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) reject(413, -32600, `Request body exceeds ${maxBytes} bytes`)

  let body
  try {
    body = req.body
  } catch {
    reject(400, -32700, 'Parse error')
  }

  let text = null
  if (typeof body === 'string') text = body
  else if (Buffer.isBuffer(body)) text = body.toString('utf8')
  if (text !== null) {
    if (Buffer.byteLength(text, 'utf8') > maxBytes) reject(413, -32600, `Request body exceeds ${maxBytes} bytes`)
    try {
      body = JSON.parse(text)
    } catch {
      reject(400, -32700, 'Parse error')
    }
  } else {
    let serialized
    try {
      serialized = JSON.stringify(body)
    } catch {
      reject(400, -32600, 'Invalid request')
    }
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > maxBytes) reject(413, -32600, `Request body exceeds ${maxBytes} bytes`)
  }

  // Batches are not used by the app or the Solana SDK path and are refused.
  if (!isPlainObject(body)) reject(400, -32600, 'Invalid request')
  return body
}

export function readRequestId(body) {
  const id = body?.id
  if (id === undefined || id === null) return null
  if (typeof id === 'string' && id.length <= MAX_ID_CHARS) return id
  if (typeof id === 'number' && Number.isSafeInteger(id)) return id
  return undefined
}

function optionalConfig(params, index, allowedKeys) {
  const config = params[index]
  if (config === undefined || config === null) return {}
  if (!isPlainObject(config)) invalidParams('Invalid params')
  if (allowedKeys) for (const key of Object.keys(config)) if (!allowedKeys.includes(key)) invalidParams('Invalid params')
  if (config.commitment !== undefined && !COMMITMENTS.has(config.commitment)) invalidParams('Invalid params')
  return config
}

function stringList(value, max, check) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every(check)) invalidParams('Invalid params')
}

function validateProgramAccounts(params) {
  if (params.length !== 2 || params[0] !== CCTP_MESSAGE_TRANSMITTER_PROGRAM) invalidParams('getProgramAccounts is limited to the CCTP payee lookup')
  const config = optionalConfig(params, 1, ['commitment', 'encoding', 'filters'])
  if (config.encoding !== 'base64' || !Array.isArray(config.filters) || config.filters.length !== 1) {
    invalidParams('getProgramAccounts is limited to the CCTP payee lookup')
  }
  const [filter] = config.filters
  const memcmp = isPlainObject(filter) && Object.keys(filter).length === 1 ? filter.memcmp : null
  if (!isPlainObject(memcmp) || Object.keys(memcmp).some(k => k !== 'offset' && k !== 'bytes')
    || memcmp.offset !== 8 || !isSolanaAddress(memcmp.bytes)) {
    invalidParams('getProgramAccounts is limited to the CCTP payee lookup')
  }
}

// Only methods with an unbounded cost get shape checks; every other allow-listed method is
// forwarded unchanged (the body limit still applies) so the Solana SDK keeps working.
const PARAM_RULES = {
  getProgramAccounts: validateProgramAccounts,
  getSignaturesForAddress(params) {
    if (!isSolanaAddress(params[0])) invalidParams('Invalid params')
    const config = optionalConfig(params, 1)
    // The RPC default is 1000; the app always asks for 25 or fewer.
    if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > MAX_SIGNATURES_FOR_ADDRESS_LIMIT) {
      invalidParams(`getSignaturesForAddress limit must be 1-${MAX_SIGNATURES_FOR_ADDRESS_LIMIT}`)
    }
  },
  getSignatureStatuses(params) {
    stringList(params[0], MAX_SIGNATURE_STATUSES, isSignature)
    optionalConfig(params, 1)
  },
  getMultipleAccounts(params) {
    stringList(params[0], MAX_MULTIPLE_ACCOUNTS, isSolanaAddress)
    optionalConfig(params, 1)
  },
  getAccountInfo(params) {
    if (!isSolanaAddress(params[0])) invalidParams('Invalid params')
    optionalConfig(params, 1)
  },
  getTransaction(params) {
    if (!isSignature(params[0])) invalidParams('Invalid params')
    optionalConfig(params, 1)
  },
  sendTransaction(params) {
    if (typeof params[0] !== 'string' || !params[0] || params[0].length > MAX_ENCODED_TRANSACTION_CHARS) invalidParams('Invalid transaction')
    optionalConfig(params, 1)
  },
  simulateTransaction(params) {
    if (typeof params[0] !== 'string' || !params[0] || params[0].length > MAX_ENCODED_TRANSACTION_CHARS) invalidParams('Invalid transaction')
    optionalConfig(params, 1)
  },
}

export function readRpcCall(body, allowedMethods) {
  const method = typeof body.method === 'string' ? body.method : ''
  if (!allowedMethods.has(method)) reject(400, -32601, 'Unsupported Solana RPC method')
  if (body.params !== undefined && !Array.isArray(body.params)) invalidParams('Invalid params')
  const params = body.params ?? []
  if (params.length > MAX_PARAMS) invalidParams('Invalid params')
  PARAM_RULES[method]?.(params)
  return { method, params }
}

// Reads at most maxBytes of the upstream body; a larger (or larger-declared) body is aborted.
export async function readLimitedText(response, maxBytes = MAX_UPSTREAM_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw new RpcRequestError(502, -32000, 'Solana RPC response exceeded the size limit')
  }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new RpcRequestError(502, -32000, 'Solana RPC response exceeded the size limit')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RpcRequestError(502, -32000, 'Solana RPC response exceeded the size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8')
}

// A whole request (every provider attempt together) has one time budget. Each attempt gets the
// smaller of its own timeout and what is left; no attempt starts with less than minAttemptMs.
export function createDeadline(totalMs, now = () => Date.now()) {
  const end = now() + totalMs
  return {
    attemptTimeout(perAttemptMs, minAttemptMs = 1_000) {
      const left = end - now()
      return left < minAttemptMs ? 0 : Math.min(perAttemptMs, left)
    },
  }
}
