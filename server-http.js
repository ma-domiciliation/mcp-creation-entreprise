#!/usr/bin/env node
// madom-mcp — serveur MCP ma-domiciliation hébergé (transport Streamable HTTP, sans session).
// Mode distant : sans état, le jeton `mcc_` du dossier est l'identité (paramètre jeton) ; pas de
// profil, de pièces ni de fin de tunnel : après paiement, le client termine sur le site.
// Variables : PORT (3100), HOST (0.0.0.0), MADOM_API_BASE_URL, MADOM_MCP_INTERNAL_KEY (secret
// partagé avec le site pour transmettre l'IP cliente), MADOM_TRUST_PROXY=1 (derrière un routeur),
// MADOM_ALLOWED_HOSTS (liste d'hôtes acceptés), MADOM_LIMIT_REQUESTS_PER_MINUTE (120),
// MADOM_LIMIT_CREATIONS_PER_HOUR (10), MADOM_LIMIT_UNAUTHORIZED_PER_10MIN (20).
import { startHttpServer } from './src/http/server.js'
import { baseUrl } from './src/creation/api.js'

const { url, close } = await startHttpServer()
console.error(`[madom-mcp-http] démarré — ${url} — API ${baseUrl()} — IP cliente ${process.env.MADOM_MCP_INTERNAL_KEY ? 'transmise' : 'non transmise (MADOM_MCP_INTERNAL_KEY absent)'}`)

const stop = async signal => {
  console.error(`[madom-mcp-http] ${signal} : arrêt`)
  await close()
  process.exit(0)
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
