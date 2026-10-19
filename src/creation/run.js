// Enveloppe commune des outils : sérialisation JSON, erreurs isError, garde-fou anti-secret.

import { toolError } from './errors.js'

// Un jeton de dossier est `mcc_` + 43 caractères base64url : on masque tout ce qui y ressemble.
const TOKEN_PATTERN = /mcc_[A-Za-z0-9_-]{20,}/g
const redact = text => String(text).replace(TOKEN_PATTERN, 'mcc_…')

const redactResult = result => ({
  ...result,
  content: (result.content || []).map(item => (item.type === 'text' ? { ...item, text: redact(item.text) } : item)),
})

const asText = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

// Annotations MCP des outils (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) : certains clients
// (ChatGPT) les exigent pour classer un outil et traitent un outil non annoté comme une écriture. Tout passe par
// l'API fermée de ma-domiciliation.fr (openWorldHint false) et rien n'est jamais détruit (destructiveHint false).
const LECTURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const ECRITURE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const CREATION = { ...ECRITURE, idempotentHint: false }

// run(fn, { redactTokens }) → handler MCP : fn(args) renvoie une valeur JSON (ou déjà un résultat
// MCP si `content` est présent). redactTokens: false seulement pour creer_societe en mode hébergé,
// où le jeton est volontairement renvoyé à l'agent ; les erreurs restent toujours masquées.
const run = (fn, { redactTokens = true } = {}) => async (args = {}) => {
  try {
    const value = await fn(args ?? {})
    const result = value && typeof value === 'object' && Array.isArray(value.content) ? value : asText(value)
    return redactTokens ? redactResult(result) : result
  } catch (err) {
    return redactResult(toolError(err))
  }
}

// Erreur locale (hors API) avec message français : utile pour les refus avant appel.
class LocalError extends Error {
  constructor (message, extra = {}) {
    super(message)
    this.name = 'LocalError'
    Object.assign(this, extra)
  }
}

export { asText, run, redact, LocalError, TOKEN_PATTERN, LECTURE, ECRITURE, CREATION }
