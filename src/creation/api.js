// Client HTTP minimal de l'API /api/mcp-creation (contrat : specs/api-mcp-creation.md).
// Aucune règle métier ici : on parle à l'API, on remonte ses erreurs telles quelles (ApiError).
// Le jeton `mcc_` ne figure jamais dans une erreur ni dans un log.

const DEFAULT_BASE_URL = 'https://www.ma-domiciliation.fr/api/mcp-creation'
const DEFAULT_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000
const CACHE_TTL_MS = 60 * 60 * 1000

const baseUrl = () => (process.env.MADOM_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')

class ApiError extends Error {
  constructor (status, body = {}, { retryAfter } = {}) {
    super(body.message || body.error || `Erreur HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.error = body.error || `HTTP_${status}`
    this.details = body.details
    this.retryAfter = retryAfter
  }
}

const isApiError = err => err instanceof ApiError

// Construit l'URL finale : la base porte déjà un chemin (/api/mcp-creation), donc concaténation.
const buildUrl = (path, query) => {
  const url = `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

const parseBody = async response => {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 500) } }
}

const parseRetryAfter = response => {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000))
}

const unreachableError = (err, timeoutMs) => {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
  const cause = err?.cause?.code || err?.cause?.message || err?.message || 'erreur réseau'
  return new ApiError(0, {
    error: timedOut ? 'API_TIMEOUT' : 'API_UNREACHABLE',
    message: timedOut
      ? `L'API ${baseUrl()} n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.`
      : `API injoignable (${baseUrl()}) : ${cause}. Vérifier MADOM_API_BASE_URL et que le serveur tourne.`,
  })
}

// En-têtes du serveur hébergé : l'IP du client final, authentifiée par le secret partagé avec le
// site (MADOM_MCP_INTERNAL_KEY ↔ MCP_INTERNAL_KEY), pour que les limiteurs de l'API comptent par
// client et non par serveur. Sans secret ou sans IP, rien n'est envoyé.
const clientIpHeaders = clientIp => {
  const key = process.env.MADOM_MCP_INTERNAL_KEY
  if (!key || !clientIp) return {}
  return { 'x-madom-mcp-key': key, 'x-madom-client-ip': clientIp }
}

// request(method, path, { token, body, multipart, query, timeoutMs, clientIp })
// - body → JSON ; multipart (FormData) → envoyé tel quel (fetch pose la frontière) ; jamais les deux.
// - Authorization: Bearer seulement si `token` est fourni (un Bearer vide ferait 401 partout).
// - non-2xx → throw ApiError(status, corps) ; corps JSON illisible → error 'HTTP_<status>'.
const request = async (method, path, { token, body, multipart, query, timeoutMs, clientIp } = {}) => {
  const headers = { accept: 'application/json', ...clientIpHeaders(clientIp) }
  if (token) headers.authorization = `Bearer ${token}`
  let payload
  if (multipart) payload = multipart
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const timeout = timeoutMs ?? (multipart ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetch(buildUrl(path, query), {
      method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    throw unreachableError(err, timeout)
  }
  const parsed = await parseBody(response)
  if (response.ok) return parsed
  const errorBody = parsed && parsed.error ? parsed : { error: `HTTP_${response.status}`, message: parsed?.raw || parsed?.message || response.statusText }
  throw new ApiError(response.status, errorBody, { retryAfter: parseRetryAfter(response) })
}

const get = (path, options) => request('GET', path, options)
const post = (path, body, options) => request('POST', path, { ...options, body })
const patch = (path, body, options) => request('PATCH', path, { ...options, body })
const postMultipart = (path, formData, options) => request('POST', path, { ...options, multipart: formData })

// Cache mémoire des référentiels (1 h, comme le Cache-Control de l'API), par URL de base.
const cache = {}
const cachedGet = async (path, { ttlMs = CACHE_TTL_MS, force = false } = {}) => {
  const key = buildUrl(path)
  const hit = cache[key]
  if (!force && hit && hit.expiresAt > Date.now()) return hit.value
  const value = await get(path)
  cache[key] = { value, expiresAt: Date.now() + ttlMs }
  return value
}
const clearCache = () => { for (const key of Object.keys(cache)) delete cache[key] }

const getJuridicForms = options => cachedGet('/reference/juridic-forms', options)
const getDossierSchema = options => cachedGet('/reference/dossier-schema', options)

export {
  DEFAULT_BASE_URL, baseUrl, ApiError, isApiError, buildUrl,
  request, get, post, patch, postMultipart, clientIpHeaders,
  cachedGet, clearCache, getJuridicForms, getDossierSchema,
}
