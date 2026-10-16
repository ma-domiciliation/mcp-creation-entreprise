import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { slugify } from '../profile.js'

// Registre local des dossiers de création ouverts depuis ce poste : ~/.madom/societes.json (0600).
// Une entrée par dossier, clé = jeton secret `mcc_…` de l'API (renvoyé une seule fois par
// POST /dossiers). Le jeton ne sort jamais du registre : les outils renvoient `sanitizeEntry`.
// Les entrées de l'ancienne version (sans jeton `mcc_`, avec mot de passe) sont ignorées à la
// lecture et purgées à la première écriture.

const TOKEN_PREFIX = 'mcc_'
const TERMINAL_STATUSES = ['submitted']

const registryPath = () => process.env.MADOM_REGISTRY_PATH || path.join(homedir(), '.madom', 'societes.json')

const isCurrentEntry = entry => entry && typeof entry.token === 'string' && entry.token.startsWith(TOKEN_PREFIX)

const describeIgnored = entry => ({
  name: entry?.socialDenomination || entry?.name || null,
  createdAt: entry?.createdAt || null,
  reason: 'entrée d\'une ancienne version du MCP (sans jeton de dossier) : ignorée, purgée à la prochaine écriture',
})

const readRegistry = () => {
  const p = registryPath()
  if (!existsSync(p)) return { societes: [], ignored: [] }
  let parsed
  try { parsed = JSON.parse(readFileSync(p, 'utf8')) } catch { return { societes: [], ignored: [] } }
  const all = Array.isArray(parsed?.societes) ? parsed.societes : []
  return {
    societes: all.filter(isCurrentEntry),
    ignored: all.filter(e => !isCurrentEntry(e)).map(describeIgnored),
  }
}

const writeRegistry = ({ societes }) => {
  const p = registryPath()
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify({ societes: societes.filter(isCurrentEntry) }, null, 2), { mode: 0o600 })
  try { chmodSync(p, 0o600) } catch { /* Windows : sans effet */ }
}

const now = () => new Date().toISOString()

const upsertSociete = entry => {
  if (!isCurrentEntry(entry)) throw new Error('Entrée de registre invalide : jeton de dossier attendu')
  const { societes } = readRegistry()
  const idx = societes.findIndex(s => s.token === entry.token)
  const merged = { ...(idx >= 0 ? societes[idx] : { createdAt: now() }), ...entry, updatedAt: now() }
  if (idx >= 0) societes[idx] = merged
  else societes.push(merged)
  writeRegistry({ societes })
  return merged
}

// publicToken = dernier segment de links.paymentPage (…/creation-mcp/paiement/<publicToken>).
const publicTokenFromLinks = links => {
  const url = links?.paymentPage || links?.passwordPage
  if (!url) return null
  const segment = String(url).split(/[?#]/)[0].split('/').filter(Boolean).pop()
  return segment || null
}

// Construit l'entrée de registre depuis une réponse dossier de l'API.
const entryFromDossier = (token, dossier = {}) => ({
  token,
  publicToken: publicTokenFromLinks(dossier.links) || publicTokenFromLinks({ paymentPage: dossier.payment?.paymentUrl }),
  socialDenomination: dossier.sections?.societe?.socialDenomination ?? null,
  juridicForm: dossier.juridicForm ?? null,
  email: dossier.account?.email ?? null,
  status: dossier.status ?? null,
  phase: dossier.phase ?? null,
  links: dossier.links ?? null,
})

// Recherche : sans ref → toutes ; publicToken exact ; sinon dénomination comparée par slug.
const findSocietes = ref => {
  const { societes } = readRegistry()
  if (ref === undefined || ref === null || String(ref).trim() === '') return societes
  const needle = String(ref).trim()
  const byPublicToken = societes.filter(s => s.publicToken && s.publicToken === needle)
  if (byPublicToken.length) return byPublicToken
  const slug = slugify(needle)
  if (!slug) return []
  return societes.filter(s => slugify(s.socialDenomination) === slug)
}

const findSociete = ref => {
  const found = findSocietes(ref)
  return found.length === 1 ? found[0] : null
}

const markTokenInvalid = token => {
  const { societes } = readRegistry()
  const entry = societes.find(s => s.token === token)
  if (!entry) return null
  return upsertSociete({ ...entry, status: 'jeton_invalide' })
}

const isTerminal = entry => TERMINAL_STATUSES.includes(entry?.status)

// Vue courte d'une liste d'entrées (messages de choix, doublons).
const listing = societes => societes.map(s => ({
  socialDenomination: s.socialDenomination, publicToken: s.publicToken, status: s.status, createdAt: s.createdAt,
}))

// Vue sans secret, pour les réponses d'outil.
const sanitizeEntry = entry => {
  if (!entry) return null
  const { token, ...rest } = entry
  return rest
}

export {
  registryPath, readRegistry, writeRegistry, upsertSociete, findSocietes, findSociete,
  publicTokenFromLinks, entryFromDossier, markTokenInvalid, sanitizeEntry, isTerminal, listing,
  TERMINAL_STATUSES, TOKEN_PREFIX,
}
