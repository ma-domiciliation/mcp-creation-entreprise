// Serveur node:http du MCP hébergé : POST /mcp (handler MCP), GET /health, 404 ailleurs.
// Journal sur stderr : méthode, chemin, statut, durée, IP — jamais un corps ni un jeton.
// /health est public (avant le contrôle de Host et les limiteurs) : il ne montre de l'API que son
// hôte, de quoi reconnaître prod, local ou recette au déploiement, sans dévoiler le chemin.

import http from 'node:http'

import { baseUrl } from '../creation/api.js'
import { createMcpHandler, clientIp, jsonRpcError, VERSION } from './handler.js'
import { createLimiter } from './limiter.js'

const DEFAULT_PORT = 3100
const DEFAULT_HOST = '0.0.0.0'
const MCP_PATH = '/mcp'

const apiHost = () => { try { return new URL(baseUrl()).host } catch { return null } }

const log = (req, res, startedAt, ip) => {
  const ms = Date.now() - startedAt
  console.error(`[madom-mcp-http] ${req.method} ${req.url} ${res.statusCode} ${ms}ms ${ip || '-'}`)
}

// startHttpServer({ port, host, limiter, allowedHosts, trustProxy, keepAliveMs, quiet }) → { server, url, port, close }
const startHttpServer = async ({
  port = Number(process.env.PORT) || DEFAULT_PORT,
  host = process.env.HOST || DEFAULT_HOST,
  limiter = createLimiter(),
  trustProxy = process.env.MADOM_TRUST_PROXY === '1',
  quiet = false,
  ...handlerOptions
} = {}) => {
  const handler = createMcpHandler({ limiter, trustProxy, ...handlerOptions })
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now()
    const path = (req.url || '/').split('?')[0]
    if (!quiet) res.on('finish', () => log(req, res, startedAt, clientIp(req, trustProxy)))
    if (path === MCP_PATH) return handler(req, res)
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, name: 'madom-mcp', version: VERSION, mode: 'distant', api: apiHost(), mcp: MCP_PATH }))
    }
    jsonRpcError(res, 404, -32000, `Route inconnue : POST ${MCP_PATH} ou GET /health.`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  const url = `http://${shownHost}:${address.port}${MCP_PATH}`
  const close = () => new Promise(resolve => { limiter.stop?.(); server.closeAllConnections?.(); server.close(() => resolve()) })
  return { server, url, port: address.port, close }
}

export { startHttpServer, MCP_PATH }
