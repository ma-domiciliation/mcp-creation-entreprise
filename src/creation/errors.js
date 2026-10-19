// Traduction des erreurs de l'API en messages français actionnables (contrat § 2.1 et § 10).
// Chaque message nomme l'outil à utiliser ensuite ; le bloc brut { error, status, details } suit.

import { isApiError } from './api.js'

const list = (items, render) => (Array.isArray(items) && items.length ? items.map(render).join('\n') : '')

const validationLines = details => list(details, d => {
  const where = [d.section, d.field].filter(Boolean).join('.') || 'dossier'
  return `  - ${where} — ${d.message}`
})

const validationError = err => {
  const lines = validationLines(err.details)
  const frozen = /apr[eè]s paiement/i.test(`${err.message} ${JSON.stringify(err.details || '')}`)
  const head = frozen
    ? `Modification refusée : ${err.message} Après paiement, le compte (email, téléphone) et le siège (centre, cadence) sont figés ; ces changements se font sur le site (links.customerArea).`
    : `L'API a refusé les données : ${err.message}`
  return `${head}${lines ? `\n${lines}` : ''}\nCorriger avec modifier_dossier (ou creer_societe si le dossier n'existe pas encore).`
}

const optionsText = options => list(options, o => (typeof o === 'string' ? o : `${o.value || o.key || o.code}${o.label ? ` (${o.label})` : ''}`)).replace(/\n/g, ', ') || 'voir documents.items'

const pieceStatus = (label, piece) => {
  if (!piece) return null
  const parts = [`${label} : ${piece.status || 'inconnu'}`]
  if (piece.documentType) parts.push(`type ${piece.documentType}`)
  if (piece.attempts !== undefined) parts.push(`${piece.attempts} tentative(s)`)
  if (piece.hasVerso !== undefined) parts.push(piece.hasVerso ? 'recto + verso reçus' : 'verso manquant')
  return `  - ${parts.join(', ')}`
}

const netheosPending = err => {
  const d = err.details?.domiciliation || {}
  const lines = [pieceStatus('Identité', d.identity), pieceStatus('Justificatif de domicile', d.address)].filter(Boolean).join('\n')
  return `Les pièces de domiciliation ne sont pas encore validées par Netheos (vérification d'identité) : ${err.message}` +
    (lines ? `\n${lines}` : '') +
    '\nSi une pièce est refusée (rejected / VALIDATION_KO), la redéposer avec envoyer_piece (CNI : recto ID_CARD puis verso). ' +
    'Si elle est en cours de vérification, attendre puis relancer deposer_capital (statut_dossier pour suivre).'
}

const MESSAGES = {
  VALIDATION_ERROR: validationError,
  UNAUTHORIZED: err => err.hint || ('Jeton de dossier refusé par l\'API (perdu, révoqué, ou dossier remplacé par un creer_societe plus récent sur le même email). Ce dossier ne peut plus être piloté depuis le MCP : ' +
    'terminer sur le site (lien du dossier dans mes_societes), ou recommencer avec creer_societe (sur le même email, le nouveau dossier remplace l\'ancien).'),
  PAYMENT_REQUIRED: () => 'Cette action exige un dossier payé. Utiliser ouvrir_paiement, puis statut_dossier avec attendre="paiement".',
  NOT_FOUND: err => `Ressource introuvable (${err.message}). Vérifier MADOM_API_BASE_URL (${process.env.MADOM_API_BASE_URL || 'valeur par défaut'}) et la référence du dossier.`,
  // details.kind : 'user' (un compte existe) ou 'pending' (un autre dossier non payé porte l'email ; contrat § 2.1 et § 11.6).
  EMAIL_EXISTS: err => (err.details?.kind === 'pending'
    ? `Un autre dossier non payé porte déjà cet email. ${err.message} ` +
      'Proposer un autre alias via modifications.account.email, ou, pour reprendre ce dossier à sa place, recommencer avec creer_societe sur cet email (le dossier précédent est alors remplacé).'
    : `Un compte existe déjà avec cet email sur ma-domiciliation.fr (règle : une société = un compte). ${err.message} ` +
      'Proposer un autre alias (ex. prenom+nomsociete@domaine) via dossier.account.email (creer_societe) ou modifications.account.email (modifier_dossier avant paiement).'),
  DOSSIER_FINALIZED: () => 'Dossier déjà finalisé : plus aucune modification possible via modifier_dossier. Le suivi se fait sur le site (links.customerArea).',
  PAYLOAD_TOO_LARGE: () => 'Corps de requête trop volumineux (limite 100 ko en JSON, 20 Mo par pièce). Réduire les données envoyées.',
  UNSUPPORTED_JURIDIC_FORM: err => `Forme juridique non prise en charge. Formes possibles : ${(err.details?.supported || []).join(', ') || 'voir schema_dossier'}.`,
  DOSSIER_INCOMPLETE: err => `Dossier incomplet : ${err.message} Utiliser modifier_dossier (ou completer_dossier en local) avant de demander le lien de paiement.`,
  RATE_LIMITED: err => `Trop de requêtes (limite de l'API). Réessayer dans ${err.retryAfter ? `${err.retryAfter} s` : 'quelques minutes'}.`,
  // Limiteur de création de lead du site (même sens que RATE_LIMITED, autre code).
  TOO_MANY_REQUESTS: () => 'Trop de dossiers créés depuis cette adresse ou ce numéro de téléphone (limite anti-abus du site). Réessayer plus tard ou terminer sur le site.',
  KEY_NOT_REQUESTED: err => `Cette pièce n'est pas demandée pour ce dossier. Clés acceptées : ${(err.details?.requested || []).join(', ') || 'voir documents.items dans statut_dossier'}.`,
  INVALID_FORMAT: err => `Format de fichier refusé. Formats acceptés pour cette pièce : ${(err.details?.formats || []).join(', ') || 'pdf'}. ` +
    'Une image sera convertie en PDF automatiquement si la pièce n\'accepte que le PDF (envoyer_piece).',
  DOCUMENT_TYPE_NOT_APPLICABLE: () => 'Cette pièce ne prend pas de documentType : relancer envoyer_piece sans ce paramètre.',
  DOCUMENT_TYPE_REQUIRED: err => `Le type de document est obligatoire pour cette pièce. Options : ${optionsText(err.details?.options)}. Relancer envoyer_piece avec documentType.`,
  INVALID_DOCUMENT_TYPE: err => `Type de document inconnu. Options : ${optionsText(err.details?.options)}.`,
  NETHEOS_SUSPENDED: err => `Vérification d'identité suspendue chez Netheos : ${err.message} Le client doit contacter ma-domiciliation.fr ou terminer sur le site ; rien à redéposer depuis le MCP.`,
  NETHEOS_PIECE_VALIDATED: () => 'Cette pièce est déjà validée par Netheos : elle ne peut plus être remplacée.',
  NETHEOS_UNAVAILABLE: () => 'Netheos (vérification d\'identité) est indisponible. Le fichier a été conservé mais non transmis : ' +
    'redéposer la pièce plus tard avec envoyer_piece (même clé, même fichier).',
  DOCUMENTS_MISSING: err => 'Des pièces manquent avant le dépôt de capital :\n' +
    (list(err.details?.missing, m => `  - ${m.key || m}${m.label ? ` (${m.label})` : ''}`) || '  (voir documents.items dans statut_dossier)') +
    '\nLes envoyer avec envoyer_piece puis relancer deposer_capital.',
  NETHEOS_PIECES_PENDING: netheosPending,
  QONTO_UNSUPPORTED_JURIDIC_FORM: err => `Qonto ne prend pas en charge cette forme juridique (${err.message}). Choisir deposer_capital avec choice="banque".`,
  QONTO_REGISTRATION_FAILED: () => 'L\'inscription Qonto a échoué côté site. Réessayer deposer_capital, ou choisir choice="banque".',
  SALESFORCE_SYNC_FAILED: () => 'La synchronisation côté ma-domiciliation.fr a échoué après le dépôt de capital. Rejouer deposer_capital avec le même choix (l\'opération est idempotente).',
  API_UNREACHABLE: err => `${err.message}`,
  API_TIMEOUT: err => `${err.message} Réessayer.`,
  INTERNAL_ERROR: () => 'Erreur interne de l\'API ma-domiciliation.fr (signalée automatiquement). Réessayer dans quelques instants ; si elle persiste, terminer sur le site.',
  NOT_IMPLEMENTED: () => 'Route non disponible sur ce serveur (déploiement incomplet). Réessayer plus tard ou terminer sur le site.',
}

const genericMessage = err => {
  if (err.status >= 500) return `Erreur serveur ${err.status} (${err.error}) : ${err.message} Réessayer plus tard.`
  if (err.error.startsWith('NETHEOS_')) return `Vérification d'identité (Netheos) : ${err.message}`
  if (err.error.startsWith('QONTO_')) return `Qonto : ${err.message} Sinon choisir deposer_capital avec choice="banque".`
  return `Erreur ${err.status} (${err.error}) : ${err.message}`
}

// Message français + bloc brut pour un ApiError ; message simple pour toute autre erreur.
const formatApiError = err => {
  if (!isApiError(err)) return `Erreur${err?.error ? ` ${err.error}` : ''} : ${err?.message || String(err)}`
  const render = MESSAGES[err.error] || genericMessage
  const raw = { error: err.error, status: err.status }
  if (err.details !== undefined) raw.details = err.details
  if (err.retryAfter !== undefined) raw.retryAfter = err.retryAfter
  return `${render(err)}\n\n${JSON.stringify(raw, null, 2)}`
}

// Résultat MCP en erreur (isError: true).
const toolError = err => ({ isError: true, content: [{ type: 'text', text: formatApiError(err) }] })

export { formatApiError, toolError, MESSAGES }
