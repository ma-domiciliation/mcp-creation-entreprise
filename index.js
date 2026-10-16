#!/usr/bin/env node
// madom-mcp — serveur MCP ma-domiciliation (stdio).
// Création de société : client fin de l'API /api/mcp-creation de ma-domiciliation.fr (aucune clé requise).
// Variables : MADOM_API_BASE_URL (défaut https://www.ma-domiciliation.fr/api/mcp-creation),
// MADOM_PROFILE_PATH, MADOM_KYC_DIR, MADOM_REGISTRY_PATH, MADOM_NO_BROWSER=1.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { registerCreationTools } from './src/creation/index.js'
import { localStore } from './src/creation/store.js'
import { baseUrl } from './src/creation/api.js'
import { SERVER_INSTRUCTIONS } from './src/creation/guide.js'

const server = new McpServer({ name: 'ma-domiciliation', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS })
registerCreationTools(server, localStore())

await server.connect(new StdioServerTransport())
console.error(`[madom-mcp] démarré — API ${baseUrl()}`)
