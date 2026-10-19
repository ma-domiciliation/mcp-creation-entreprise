// Elicitation MCP : formulaires construits depuis les `questionGroups` de l'API, ouverture d'URL
// (paiement, mot de passe, Qonto) et repli conversationnel quand le client ne supporte rien.
// Ce module ne connaît pas le registre : les outils lui passent `submit(patch)` pour envoyer un PATCH
// et `attendre()` pour sonder l'événement hors bande qui clôt une elicitation URL.

import { randomUUID } from 'node:crypto'

import { isApiError } from './api.js'
import { openUrl } from '../app/open-url.js'
import { summarizeDescriptor } from './summary.js'

const DEFAULT_MAX_GROUPS = 8

// Capacités du client : { form, url }. Le SDK normalise `elicitation: {}` en `{ form: {} }`.
const elicitationSupport = server => {
  let caps
  try { caps = server?.server?.getClientCapabilities?.()?.elicitation } catch { caps = undefined }
  if (!caps || typeof caps !== 'object') return { form: false, url: false }
  return { form: !!caps.form, url: !!caps.url }
}

const describeField = d => [
  d.elicitation?.description || d.hint,
  d.example !== undefined && d.example !== null ? `Exemple : ${d.example}` : null,
  d.askTo ? `Question pour : ${d.askTo}` : null,
].filter(Boolean).join(' — ')

// Formulaire d'elicitation pour un groupe : les descripteurs avec `elicitation` deviennent des
// propriétés (schéma plat du SDK), les règles de section (`field: null`) sont rappelées en texte.
const buildRequestedSchema = group => {
  const properties = {}
  const notes = []
  const fields = []
  for (const d of group?.fields || []) {
    if (typeof d !== 'object' || d === null) continue
    if (!d.field || !d.elicitation) { if (d.label) notes.push(d.label); continue }
    const { description: _desc, ...fragment } = d.elicitation
    properties[d.field] = { title: d.label, ...fragment }
    const description = describeField(d)
    if (description) properties[d.field].description = description
    fields.push(d)
  }
  const message = [`${group?.title || 'Questions'} — questions pour : ${group?.askTo || 'le client'}`, ...notes.map(n => `Rappel : ${n}`)].join('\n')
  return { message, requestedSchema: { type: 'object', properties, required: Object.keys(properties) }, fields }
}

// askGroup(server, group) → { action: 'accept', content } | { action: 'decline' | 'cancel' }
// | { action: 'unsupported' } | { action: 'empty' } | { action: 'error', message }
const askGroup = async (server, group) => {
  if (!elicitationSupport(server).form) return { action: 'unsupported' }
  const { message, requestedSchema } = buildRequestedSchema(group)
  if (!Object.keys(requestedSchema.properties).length) return { action: 'empty' }
  try {
    const result = await server.server.elicitInput({ mode: 'form', message, requestedSchema })
    if (result?.action === 'accept') return { action: 'accept', content: result.content || {} }
    return { action: result?.action || 'cancel' }
  } catch (err) {
    return { action: 'error', message: err?.message || String(err) }
  }
}

// Chemin relatif « coDirigeants[0].name » → ['coDirigeants', 0, 'name']
const parsePath = field => String(field).split(/\.|\[|\]/).filter(s => s !== '').map(s => (/^\d+$/.test(s) ? Number(s) : s))

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const deepSet = (target, tokens, value) => {
  let node = target
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i]
    const nextIsIndex = typeof tokens[i + 1] === 'number'
    if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') node[key] = nextIsIndex ? [] : {}
    node = node[key]
  }
  node[tokens[tokens.length - 1]] = value
  return target
}

// Coercition d'une réponse selon le type du descripteur (montants en chaînes, nombres, vides ignorés).
const coerce = (descriptor, value) => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const type = descriptor?.type
  if (type === 'amount') return String(value).replace(/\s/g, '')
  if (type === 'integer' || type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(n) ? n : value
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (/^(true|oui|yes|1)$/i.test(String(value))) return true
    if (/^(false|non|no|0)$/i.test(String(value))) return false
    return value
  }
  return typeof value === 'string' ? value.trim() : value
}

// answersToPatch(sections, group, content) → corps de PATCH : scalaires par section, listes
// (coDirigeants, associes, activities…) renvoyées complètes depuis l'état courant (règle de l'API).
const answersToPatch = (sections = {}, group, content = {}) => {
  const descriptors = (group?.fields || []).filter(d => d && typeof d === 'object' && d.field)
  const patch = {}
  for (const [field, raw] of Object.entries(content)) {
    const d = descriptors.find(x => x.field === field)
    if (!d || !d.section) continue
    const value = coerce(d, raw)
    if (value === undefined) continue
    const section = d.section
    const current = sections[section]
    let tokens = parsePath(field)
    // Section-liste (associes) : le chemin est préfixé par son nom (`associes[1].email`).
    const listSection = Array.isArray(current) || (tokens[0] === section && typeof tokens[1] === 'number')
    if (listSection && tokens[0] === section) tokens = tokens.slice(1)
    if (listSection) {
      if (!patch[section]) patch[section] = clone(current) || []
      deepSet(patch[section], tokens, value)
      continue
    }
    if (tokens.length === 1) {
      if (!patch[section]) patch[section] = {}
      patch[section][tokens[0]] = value
      continue
    }
    if (!patch[section]) patch[section] = {}
    const listKey = tokens[0]
    if (patch[section][listKey] === undefined) patch[section][listKey] = clone(current?.[listKey]) ?? (typeof tokens[1] === 'number' ? [] : {})
    deepSet(patch[section], tokens, value)
  }
  return patch
}

// askGroups(server, dossier, submit, { max, only }) : pose chaque groupe, envoie un PATCH par groupe
// via `submit(patch) → dossier`, relit les groupes de la dernière réponse (un PATCH peut en créer).
const askGroups = async (server, dossier, submit, { max = DEFAULT_MAX_GROUPS, only = null } = {}) => {
  const asked = []
  let current = dossier
  let stoppedBy = null
  let erreur = null
  const wanted = key => !only || !only.length || only.includes(key)
  while (asked.length < max) {
    const groups = (current?.completeness?.questionGroups || []).filter(g => wanted(g.key) && !asked.some(a => a.key === g.key))
    const group = groups[0]
    if (!group) break
    const res = await askGroup(server, group)
    const record = { key: group.key, title: group.title, action: res.action }
    asked.push(record)
    if (res.action === 'empty') continue
    if (res.action !== 'accept') { stoppedBy = res.action; erreur = res.message || null; break }
    const patch = answersToPatch(current.sections, group, res.content)
    record.champs = Object.keys(res.content || {})
    if (!Object.keys(patch).length) continue
    try {
      current = await submit(patch)
    } catch (err) {
      if (isApiError(err) && err.status === 400) { stoppedBy = 'validation'; erreur = err; break }
      throw err
    }
  }
  const remaining = (current?.completeness?.questionGroups || []).filter(g => wanted(g.key)).length
  return { questionsPosees: asked, stoppedBy, erreur, dossier: current, groupesRestants: remaining }
}

// Texte de repli : les questions à poser dans la conversation (puis modifier_dossier).
const conversationalFallback = group => {
  const lines = [`${group.title} (à demander à : ${group.askTo || 'le client'})`]
  for (const d of group.fields || []) {
    if (typeof d !== 'object' || d === null) continue
    const s = summarizeDescriptor(d)
    const parts = [s.field ? `${s.section}.${s.field}` : s.section, s.label]
    const extras = [s.description, s.options ? `options : ${s.options.join(' | ')}` : null, s.example !== undefined ? `exemple : ${s.example}` : null].filter(Boolean)
    lines.push(`  - ${parts.join(' — ')}${extras.length ? ` (${extras.join(' ; ')})` : ''}`)
  }
  return lines.join('\n')
}

const questionsAPoser = groups => (Array.isArray(groups) ? groups.map(conversationalFallback) : [])

const CONSIGNE_LIEN = 'Transmettre ce lien exact au client (ne pas le recopier à la main, ne pas le tronquer) dans le message qui termine ce tour, ' +
  'sans appeler d\'autre outil avant : le client ne voit pas un texte écrit entre deux appels d\'outils. ' +
  'Le lien suffit : ne jamais dire au client que la page (ou le paiement) n\'a pas pu être ouverte.'

// Après l'accept d'une elicitation URL, le client MCP (Claude Code) affiche une attente jusqu'à la
// notification `notifications/elicitation/complete`. Elle part en arrière-plan, sans bloquer l'outil :
// à l'issue de `attendre()` (sonde de l'événement hors bande : paiement, mot de passe), ou tout de
// suite quand rien n'est à attendre (Qonto). Une sonde en échec ou à l'échéance notifie quand même,
// pour ne jamais laisser le client bloqué : l'assistant relit l'état avec statut_dossier.
const notifyElicitationCompletion = (server, elicitationId, attendre) => {
  let notify
  try { notify = server.server.createElicitationCompletionNotifier(elicitationId) } catch { return false }
  const run = async () => {
    try { if (attendre) await attendre() } catch { /* relu par statut_dossier */ }
    try { await notify() } catch { /* client déconnecté */ }
  }
  run()
  return true
}

// Ouvre une page du site pour le client : elicitation URL si le client MCP la supporte, sinon
// navigateur local (sauf MADOM_NO_BROWSER), sinon lien à transmettre. Jamais de secret dans le message.
// lienSeul: true (serveur hébergé) → lien à transmettre directement, sans elicitation ni navigateur.
// attendre: { fn, cloture } → `fn()` sonde en arrière-plan l'événement qui clôt l'elicitation, `cloture`
// décrit ce signal dans le résultat ; sans `attendre`, l'elicitation est close dès l'ouverture.
const openUrlElicitation = async (server, { url, message, lienSeul = false, attendre = null }) => {
  if (!url) return { mode: 'lien', url: null, consigne: 'Aucune URL fournie par l\'API.' }
  if (lienSeul) return { mode: 'lien', url, consigne: CONSIGNE_LIEN }
  if (elicitationSupport(server).url) {
    try {
      const elicitationId = randomUUID()
      const result = await server.server.elicitInput({ mode: 'url', url, message: message || CONSIGNE_LIEN, elicitationId })
      const action = result?.action || 'accept'
      // Refusée ou annulée par le client : la page n'est pas ouverte, le lien se donne tel quel (pas de navigateur : il a refusé).
      if (action !== 'accept') return { mode: 'lien', url, consigne: CONSIGNE_LIEN, elicitation: action }
      const out = { mode: 'elicitation', action, url, consigne: CONSIGNE_LIEN }
      if (notifyElicitationCompletion(server, elicitationId, attendre?.fn)) {
        out.cloture = attendre?.cloture || 'Elicitation close immédiatement : rien à attendre sur cette page.'
      }
      return out
    } catch { /* repli navigateur */ }
  }
  if (!process.env.MADOM_NO_BROWSER) {
    try {
      await openUrl(url)
      return { mode: 'navigateur', url, consigne: `Page ouverte dans le navigateur de ce poste. ${CONSIGNE_LIEN}` }
    } catch { /* repli lien */ }
  }
  return { mode: 'lien', url, consigne: CONSIGNE_LIEN }
}

export {
  elicitationSupport, buildRequestedSchema, askGroup, answersToPatch, askGroups,
  conversationalFallback, questionsAPoser, openUrlElicitation, parsePath, coerce, DEFAULT_MAX_GROUPS, CONSIGNE_LIEN,
}
