// Handler HTTP du serveur MCP hébergé (transport Streamable HTTP, mode sans session).
// Chaque POST crée un McpServer éphémère avec le store hébergé (IP du client, limiteur), le
// connecte à un transport sans session et traite la requête ; tout est fermé à la fin.
// Indépendant du framework : (req, res, parsedBody) avec les objets de node:http.

import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { registerCreationTools } from '../creation/index.js'
import { hostedStore } from '../creation/store.js'
import { SERVER_INSTRUCTIONS } from '../creation/guide.js'
import { createLimiter } from './limiter.js'

const { version: VERSION } = createRequire(import.meta.url)('../../package.json')
const DEFAULT_KEEP_ALIVE_MS = 15_000

const jsonRpcError = (res, status, code, message) => {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

// IPv4 telle quelle, IPv6 ramenée à son /64 (même règle que le site) ; préfixe ::ffff: retiré.
const normalizeIp = raw => {
  if (!raw) return null
  let ip = String(raw).trim()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (!ip.includes(':')) return ip
  const groups = ip.split('::')[0].split(':').filter(Boolean)
  return `${groups.slice(0, 4).map(g => g.toLowerCase()).join(':')}::/64`
}

// IP du client : premier élément de X-Forwarded-For si on fait confiance au proxy (un routeur
// devant l'app, Scalingo), sinon l'adresse de la socket.
const clientIp = (req, trustProxy) => {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '').split(',')[0].trim()
    if (first) return normalizeIp(first)
  }
  return normalizeIp(req.socket?.remoteAddress)
}

const hostAllowed = (req, allowedHosts) => {
  if (!allowedHosts?.length) return true
  const host = String(req.headers.host || '').toLowerCase()
  const bare = host.split(':')[0]
  return allowedHosts.some(h => h === host || h === bare)
}

// MADOM_ALLOWED_HOSTS : noms d'hôte séparés par des virgules ; une URL complète est tolérée (on n'en
// garde que l'hôte, sans schéma, chemin ni barre finale).
const hostOf = value => {
  const raw = value.trim().toLowerCase()
  if (!raw) return null
  try { return new URL(raw.includes('://') ? raw : `http://${raw}`).host || null } catch { return raw }
}
const parseHosts = value => String(value || '').split(',').map(hostOf).filter(Boolean)

// createMcpHandler({ limiter, allowedHosts, trustProxy, keepAliveMs }) → (req, res, parsedBody)
const createMcpHandler = ({
  limiter = createLimiter(),
  allowedHosts = parseHosts(process.env.MADOM_ALLOWED_HOSTS),
  trustProxy = process.env.MADOM_TRUST_PROXY === '1',
  keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
} = {}) => async (req, res, parsedBody) => {
  if (!hostAllowed(req, allowedHosts)) return jsonRpcError(res, 403, -32000, 'Hôte non autorisé.')
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    return jsonRpcError(res, 405, -32000, 'Méthode non autorisée : ce serveur MCP est sans session (POST seulement).')
  }
  const ip = clientIp(req, trustProxy)
  const gate = limiter.hit('requests', ip)
  if (!gate.allowed) {
    res.setHeader('retry-after', String(gate.retryAfter))
    return jsonRpcError(res, 429, -32000, `Trop de requêtes depuis cette adresse : réessayer dans ${gate.retryAfter} s.`)
  }
  const server = new McpServer({ name: 'ma-domiciliation', version: VERSION }, { instructions: SERVER_INSTRUCTIONS })
  registerCreationTools(server, hostedStore({ clientIp: ip, limiter }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, keepAliveMs })
  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
  } catch (err) {
    console.error(`[madom-mcp-http] erreur : ${err?.message || err}`)
    jsonRpcError(res, 500, -32603, 'Erreur interne du serveur MCP.')
  }
}

export { createMcpHandler, clientIp, normalizeIp, hostAllowed, parseHosts, jsonRpcError, VERSION }
