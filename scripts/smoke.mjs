#!/usr/bin/env node
// Smoke de bout en bout du serveur MCP (stdio) contre le faux serveur scripts/fake-api.mjs.
// Trois passes : client AVEC elicitation (formulaire + URL, réponses automatiques) sur un dossier
// domicilié, client SANS elicitation (repli conversationnel) sur un dossier basic — toutes deux en
// stdio local —, puis le serveur HÉBERGÉ (Streamable HTTP sans session, en in-process) : 10 outils,
// jeton comme identité, lien seul, limites par IP, en-têtes d'IP cliente.
// Aucune sortie d'outil ne doit contenir un jeton `mcc_`. Lancement : npm test.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import http from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema, ElicitationCompleteNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { startFakeApi } from './fake-api.mjs'
import { summarizeQuote } from '../src/creation/summary.js'
import { startHttpServer } from '../src/http/server.js'
import { createLimiter } from '../src/http/limiter.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = path.join(ROOT, 'test-specimens', 'cni-specimen.png')
const TOKEN_RE = /mcc_[A-Za-z0-9_-]{20,}/
const outputs = []
let step = ''
const log = msg => process.stderr.write(`  ${msg}\n`)

const FOUNDER = { gender: 'MR', name: 'Dupont', firstname: 'Jean', email: 'jean.dupont@exemple.fr', tel: '0612345678', birthdate: '12/01/1990', birthCity: 'Paris', birthPostalCode: '75010', nationality: 'Française', maritalStatus: 'Célibataire', fatherName: 'Dupont', fatherFirstname: 'Pierre', motherName: 'Martin', motherFirstname: 'Anne', address: '12 rue de Belzunce, 75010 Paris' }

// Réponses automatiques aux formulaires d'elicitation (depuis requestedSchema).
const autoAnswer = properties => Object.fromEntries(Object.entries(properties).map(([k, p]) => {
  if (p.oneOf) return [k, p.oneOf[0].const]
  if (p.enum) return [k, p.enum[0]]
  if (p.type === 'boolean') return [k, false]
  if (p.type === 'integer' || p.type === 'number') return [k, 1]
  if (p.format === 'email') return [k, `${k.replace(/\W+/g, '')}@exemple.fr`]
  if (/date/i.test(p.description || '') || /date/i.test(k)) return [k, '01/01/1990']
  return [k, `Réponse ${k}`]
}))

// Clôtures d'elicitation URL reçues (notifications/elicitation/complete) : le serveur les envoie en
// arrière-plan quand il constate l'événement (paiement, mot de passe) ou tout de suite (Qonto).
const attendreCloture = async (clotures, attendu, maxMs = 20000) => {
  const debut = Date.now()
  while (clotures.length < attendu) {
    assert.ok(Date.now() - debut < maxMs, `clôture d'elicitation n° ${attendu} non reçue après ${maxMs} ms`)
    await new Promise(r => setTimeout(r, 200))
  }
}

const startSession = async ({ apiUrl, home, elicitation, urls, clotures = [] }) => {
  const client = new Client({ name: 'smoke', version: '0' }, { capabilities: elicitation ? { elicitation: { form: {}, url: {} } } : {} })
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async req => {
      if (req.params.mode === 'url') { urls.push(req.params.url); return { action: 'accept' } }
      return { action: 'accept', content: autoAnswer(req.params.requestedSchema.properties) }
    })
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, n => { clotures.push(n.params.elicitationId) })
  }
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'index.js')], stderr: 'pipe',
    env: { ...process.env, MADOM_API_BASE_URL: apiUrl, MADOM_PROFILE_PATH: path.join(home, 'profil.json'), MADOM_KYC_DIR: path.join(home, 'kyc'), MADOM_REGISTRY_PATH: path.join(home, 'societes.json'), MADOM_NO_BROWSER: '1' },
  })
  await client.connect(transport)
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content.map(c => c.text || '').join('\n')
    outputs.push({ step, name, text })
    assert.doesNotMatch(text, TOKEN_RE, `jeton de dossier dans la sortie de ${name} (${step})`)
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) }
  }
  const ok = async (name, args) => { const r = await call(name, args); assert.equal(r.isError, false, `${name} (${step}) en erreur : ${r.text}`); return r.json }
  const ko = async (name, args, pattern) => { const r = await call(name, args); assert.equal(r.isError, true, `${name} (${step}) aurait dû échouer : ${r.text.slice(0, 200)}`); if (pattern) assert.match(r.text, pattern, `${name} (${step})`); return r.text }
  return { client, call, ok, ko }
}

// Session contre le serveur hébergé (HTTP). `allowToken` : seule creer_societe peut renvoyer le jeton.
const startHttpSession = async url => {
  const client = new Client({ name: 'smoke-http', version: '0' }, { capabilities: { elicitation: { form: {}, url: {} } } })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  const call = async (name, args = {}, { allowToken = false } = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content.map(c => c.text || '').join('\n')
    outputs.push({ step, name, text, allowToken })
    if (!allowToken) assert.doesNotMatch(text, TOKEN_RE, `jeton de dossier dans la sortie de ${name} (${step})`)
    let json = null
    try { json = r.isError ? null : JSON.parse(text) } catch { /* texte brut */ }
    return { isError: !!r.isError, text, json }
  }
  const ok = async (name, args, options) => { const r = await call(name, args, options); assert.equal(r.isError, false, `${name} (${step}) en erreur : ${r.text}`); return r.json }
  const ko = async (name, args, pattern) => { const r = await call(name, args); assert.equal(r.isError, true, `${name} (${step}) aurait dû échouer : ${r.text.slice(0, 200)}`); if (pattern) assert.match(r.text, pattern, `${name} (${step})`); return r.text }
  return { client, call, ok, ko }
}

const hook = (apiUrl, p) => fetch(`${apiUrl}${p}`, { method: 'POST' }).then(r => assert.equal(r.status, 200, `hook ${p}`))
const stats = apiUrl => fetch(`${apiUrl}/__test/stats`).then(r => r.json())

const commonChecks = async ({ client, ok, ko }, home, apiUrl) => {
  step = 'inventaire'
  const tools = (await client.listTools()).tools.map(t => t.name).sort()
  assert.equal(tools.length, 19, `19 outils attendus, ${tools.length} trouvés`)
  for (const t of ['guide_creation', 'enregistrer_profil_fondateur', 'voir_profil_fondateur', 'enregistrer_pieces_kyc', 'chercher_pieces', 'mes_societes', 'lister_centres', 'rechercher_activites', 'schema_dossier', 'devis_creation', 'valider_dossier', 'creer_societe', 'completer_dossier', 'statut_dossier', 'modifier_dossier', 'ouvrir_paiement', 'ouvrir_mot_de_passe', 'envoyer_piece', 'deposer_capital']) assert.ok(tools.includes(t), `outil manquant : ${t}`)
  assert.ok(!tools.includes('domicilier_societe') && !tools.includes('devis_domiciliation'), 'outils /v1 présents')
  assert.deepEqual((await client.listPrompts()).prompts.map(p => p.name), ['creer-ma-societe'])
  const guide = await ok('guide_creation'); assert.equal(guide.etapes.length, 6); assert.doesNotMatch(JSON.stringify(guide), /\d\s?€/, 'montant dans le guide')
  step = 'posture'
  assert.match(client.getInstructions() ?? '', /remarque de QA/, 'instructions serveur sans la règle de posture')
  assert.match(JSON.stringify(guide), /remarque de QA/, 'guide sans la règle de posture'); assert.equal(guide.etapes[5].interdits.length, 6, 'interdits de l\'étape 6')
  assert.match(guide.etapes[0].prix, /^Ne pas parler du prix tant que le projet n'est pas cerné/, 'étape 1 : pas de prix'); assert.doesNotMatch(guide.etapes[0].prix, /devis_creation/, 'étape 1 ne doit pas appeler devis_creation')
  assert.match(guide.etapes[2].prix, /devis_creation.*`cadences`.*annuel, 2 ans et 3 ans/, 'étape 3 : prix avec le détail des cadences'); assert.doesNotMatch(JSON.stringify(guide), /(25|35|45) ?%/, 'pourcentage de remise dans le guide')
  assert.match(guide.etapes[5].interdits[3], /Parler du prix dans les premiers échanges/)
  const promptText = (await client.getPrompt({ name: 'creer-ma-societe', arguments: {} })).messages[0].content.text
  assert.match(promptText, /comme à un client/, 'prompt sans la règle de posture')
  step = 'recherche de pièces'
  assert.match(JSON.stringify(guide.etapes[1]), /PROPOSER au client.*accord explicite.*chercher_pieces \(accordDuClient: true\)/, 'guide sans la proposition de recherche')
  assert.match(guide.etapes[1].lecture, /ouvrir les fichiers.*confirmation/i, 'guide sans la lecture des fichiers après accord')
  assert.match(guide.etapes[5].interdits[4], /sans son accord explicite/, 'interdit de la recherche sans accord'); assert.match(guide.etapes[5].interdits[4], /hors des dossiers convenus/)
  assert.match(promptText, /attends mon accord avant de chercher/); assert.match(promptText, /montre-moi ce que tu as trouvé/)
  await ko('chercher_pieces', {}, /accord/); await ko('chercher_pieces', { accordDuClient: false }, /accordDuClient: true/)
  const pieces = path.join(home, 'Documents', 'Scans'); mkdirSync(pieces, { recursive: true })
  writeFileSync(path.join(pieces, 'CNI-Jean.png'), readFileSync(PNG)); writeFileSync(path.join(pieces, 'facture-edf.txt'), 'pas une image'); writeFileSync(path.join(pieces, 'notes.png'), readFileSync(PNG))
  writeFileSync(path.join(pieces, 'IMG_0001.png'), readFileSync(PNG), { flag: 'w' }) // nom sans rapport : doit quand même être listé (autres)
  writeFileSync(path.join(home, 'Documents', 'passeport.png'), 'faux png'); mkdirSync(path.join(home, 'Documents', '.cache'), { recursive: true }); writeFileSync(path.join(home, 'Documents', '.cache', 'cni.png'), readFileSync(PNG))
  let r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')] })
  assert.deepEqual(r.candidats.map(c => c.nom), ['CNI-Jean.png'], JSON.stringify(r.candidats)); assert.equal(r.candidats[0].format, 'png'); assert.equal(r.candidats[0].motif, 'cni'); assert.equal(r.candidatsTronques, false); assert.equal(r.autresTronques, false)
  assert.deepEqual(r.autres.map(c => c.nom).sort(), ['IMG_0001.png', 'notes.png'], JSON.stringify(r.autres)); assert.ok(r.autres.every(c => c.format === 'png' && c.motif === undefined))
  assert.match(r.consigne, /Ouvrir les fichiers.*confirmation/); assert.doesNotMatch(r.consigne, /tronquée/); assert.equal(r.parcoursInterrompu, false)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], motifs: ['notes'], profondeur: 1 }); assert.deepEqual(r.candidats, []); assert.deepEqual(r.autres, []); assert.match(r.consigne, /Aucun fichier candidat/)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], motifs: ['notes'] }); assert.deepEqual(r.candidats.map(c => c.nom), ['notes.png']); assert.equal(r.autres.length, 2)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], limite: 1 }); assert.equal(r.autres.length, 1); assert.equal(r.candidatsTronques, false); assert.equal(r.autresTronques, true)
  // Seuls les autres fichiers sont coupés (cas normal d'un Téléchargements) : pas d'aller-retour imposé, les candidats sont complets.
  assert.match(r.consigne, /autres fichiers sont tronqués/); assert.match(r.consigne, /seulement si la pièce n'y est pas/); assert.doesNotMatch(r.consigne, /Candidats au nom évocateur/)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], motifs: ['png'], limite: 1 }); assert.equal(r.candidats.length, 1); assert.equal(r.candidatsTronques, true); assert.equal(r.autresTronques, false); assert.match(r.consigne, /Candidats au nom évocateur.*préciser le dossier/)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'inexistant')] }); assert.deepEqual(r.dossiers, []); assert.deepEqual(r.candidats, []); assert.match(r.dossiersEcartes[0].raison, /introuvable/); assert.match(r.consigne, /Dossiers écartés/)
  // Motifs de l'agent en texte simple : une regex pathologique ne bloque rien et ne matche rien ; un fragment littéral trie.
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], motifs: ['(a+)+$'] }); assert.deepEqual(r.candidats, []); assert.equal(r.autres.length, 3)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents')], motifs: ['cni-jean'] }); assert.deepEqual(r.candidats.map(c => c.nom), ['CNI-Jean.png']); assert.equal(r.candidats[0].motif, 'cni-jean')
  // Exclusions de sécurité des racines, signalées avec leur raison : le store KYC et la racine du disque sont écartés même indiqués.
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'kyc')] }); assert.deepEqual(r.dossiers, []); assert.deepEqual(r.candidats, []); assert.match(r.dossiersEcartes[0].raison, /réservé/)
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: ['/'] }); assert.deepEqual(r.dossiers, []); assert.deepEqual(r.candidats, []); assert.deepEqual(r.autres, []); assert.match(r.dossiersEcartes[0].raison, /racine du disque/)
  // Un dossier caché indiqué par le client est accepté (iCloud Drive sous ~/Library, dossier caché), les sous-dossiers cachés restent ignorés en parcours.
  r = await ok('chercher_pieces', { accordDuClient: true, dossiers: [path.join(home, 'Documents', '.cache')] }); assert.deepEqual(r.dossiersEcartes, []); assert.deepEqual(r.candidats.map(c => c.nom), ['cni.png']); assert.doesNotMatch(r.consigne, /Dossiers écartés/)
  // Sans dossiers indiqués, les dossiers usuels absents ne sont pas signalés.
  r = await ok('chercher_pieces', { accordDuClient: true }); assert.deepEqual(r.dossiersEcartes, [])
  assert.ok(!outputs.some(o => o.name === 'chercher_pieces' && /kyc\//.test(o.text)), 'le dossier KYC apparaît dans une recherche')

  step = 'profil'
  r = await ok('enregistrer_profil_fondateur', { founder: { ...FOUNDER, birthdate: '1990-01-12' }, preferences: { juridicForm: 'SASU', addressId: 2007, paymentInterval: 'month' } })
  assert.equal(r.verification, 'erreurs'); assert.deepEqual(r.erreursFormat.map(e => e.field), ['birthdate'])
  r = await ok('enregistrer_profil_fondateur', { founder: { birthdate: '12/01/1990' } })
  assert.equal(r.verification, 'ok'); assert.equal(r.profil.founder.name, 'Dupont')
  r = await ok('voir_profil_fondateur'); assert.equal(r.profil.preferences.addressId, 2007)
  r = await ok('enregistrer_pieces_kyc', { kind: 'identite_recto', path: PNG, documentType: 'ID_CARD' }); assert.equal(r.saved.ext, 'png')
  r = await ok('enregistrer_pieces_kyc', { kind: 'identite_verso', path: PNG }); assert.equal(r.pieces.length, 2)
  assert.equal(statSync(path.join(home, 'kyc', 'index.json')).mode & 0o777, 0o600)

  step = 'référentiels'
  r = await ok('lister_centres'); assert.equal(r.items[0].id, 2007)
  r = await ok('rechercher_activites', { q: 'développement d\'une application mobile', limit: 2 }); assert.equal(r.items[0].label, 'Développement de logiciels')
  r = await ok('rechercher_activites', { q: 'zzzz' }); assert.deepEqual(r.items, []); assert.match(r.note, /custom: true/)
  r = await ok('schema_dossier', { section: 'partners' }); assert.equal(r.section.fields[0].key, 'dougs'); assert.match(r.section.fields[0].hint, /Dougs/)
  r = await ok('schema_dossier'); assert.equal(r.sections.length, 10); assert.equal(r.juridicFormsDetail.length, 5)
  step = 'devis'
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: 'year' }); assert.equal(r.recurrence.remisePremiereEcheancePourcent, 25); assert.equal(r.recurrence.moisOfferts, 1); assert.equal(r.recurrence.engagementAnnees, 1)
  assert.match(r.resume, /^Aujourd'hui 307,96 € TTC \(256,63 € HT\), puis 358,80 € HT\/an \(1 mois offert, −25 % sur la première échéance\)$/, r.resume)
  assert.deepEqual(r.cadences.map(c => [c.cadence, c.engagementAnnees, c.remisePremiereEcheancePourcent, c.echeanceHt]), [['month', null, 0, '29,90 €'], ['year', 1, 25, '358,80 €'], ['2years', 2, 35, '717,60 €'], ['3years', 3, 45, '1\u202f076,40 €']], 'comparatif des cadences')
  assert.equal(r.cadences[3].aujourdHuiTtc, '307,96 €'); assert.match(r.cadences[1].resume, /−25 %/)
  assert.deepEqual(r.lignes.map(l => l.key), ['legalFees', 'domiciliation', 'expedition'], 'aucune ligne de service'); assert.equal(r.cadence, 'year')
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: '2years' }); assert.equal(r.recurrence.remisePremiereEcheancePourcent, 35); assert.equal(r.recurrence.engagementAnnees, 2); assert.equal(r.engagementAnnees, undefined, 'engagementAnnees seulement dans recurrence'); assert.equal(r.cadence, '2years'); assert.match(r.resume, /^Aujourd'hui 307,96 € TTC .*, puis 717,60 € HT\/2 ans \(1 mois offert, −35 % sur la première échéance\)$/, r.resume)
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: '3years' }); assert.equal(r.recurrence.remisePremiereEcheancePourcent, 45); assert.equal(r.recurrence.mensuelHt, '29,90 €'); assert.match(r.resume, /puis 1.076,40 € HT\/3 ans \(1 mois offert, −45 %/, r.resume); assert.match(r.quote.lines[1].label, /3 ans \(remise 45 %\)/)
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: 'month' }); assert.equal(r.recurrence.remisePremiereEcheancePourcent, 0); assert.equal(r.recurrence.engagementAnnees, null); assert.match(r.resume, /puis 29,90 € HT\/mois \(1 mois offert\)$/, r.resume)
  await ko('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: '4years' }, /paymentInterval/)
  // Panne du comparatif : le devis demandé est rendu quand même, sans `cadences`, avec une note.
  await hook(apiUrl, '/__test/fail-quote-once')
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: 'year' }); assert.equal(r.cadences, undefined); assert.match(r.note, /indisponible/); assert.equal(r.cadence, 'year'); assert.equal(r.aujourdHui.ttc, '307,96 €')
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: 'year' }); assert.equal(r.cadences.length, 4); assert.equal(r.note, undefined)
  // Le devis demandé est l'un des quatre du comparatif : sa panne fait échouer l'outil, sans appel séparé.
  await hook(apiUrl, '/__test/fail-quote-once')
  await ko('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: '3years' }, /Erreur interne de l'API/)
  let avant = (await stats(apiUrl)).quotes
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation' }); assert.equal(r.cadence, 'month'); assert.equal(r.cadences.length, 4); assert.equal((await stats(apiUrl)).quotes - avant, 4, 'quatre POST /quotes pour une domiciliation, le devis demandé compris')
  avant = (await stats(apiUrl)).quotes
  r = await ok('devis_creation', { juridicForm: 'SASU', product: 'basic', paymentInterval: '2years' }); assert.equal(r.recurrence, null); assert.equal(r.cadence, null); assert.equal(r.cadences, undefined); assert.equal(r.aujourdHui.ttc, '307,96 €'); assert.deepEqual(r.lignes.map(l => l.key), ['legalFees'])
  assert.equal((await stats(apiUrl)).quotes - avant, 1, 'un seul POST /quotes en basic')
  // Engagement replié sur la cadence demandée quand le devis n'a pas d'intervalCount (fonction pure, sans API).
  const sansCount = (paymentInterval, amountHt) => summarizeQuote({ product: 'domiciliation', paymentInterval, lines: [], dueToday: { ht: 25663, vat: 5133, ttc: 30796 }, recurring: { interval: 'year', amountHt, monthlyHt: 2990, trialMonths: 1, firstBillingDiscountPercent: 35 } })
  assert.equal(sansCount('2years', 71760).recurrence.engagementAnnees, 2); assert.match(sansCount('2years', 71760).resume, /717,60 € HT\/2 ans/); assert.equal(sansCount('year', 35880).recurrence.engagementAnnees, 1); assert.match(sansCount('year', 35880).resume, /HT\/an/)
  await ko('devis_creation', { juridicForm: 'SNC', product: 'basic' }, /Formes possibles : SASU, SAS, SARL, EURL, SCI/)
  return r
}

// ---------------------------------------------------------------- passe A : avec elicitation, dossier domicilié
const passA = async (apiUrl, home) => {
  const urls = []
  const clotures = []
  const s = await startSession({ apiUrl, home, elicitation: true, urls, clotures })
  const { ok, ko } = s
  await commonChecks(s, home, apiUrl)
  const activite = (await ok('rechercher_activites', { q: 'logiciel' })).items[0].redaction

  step = 'A/valider'
  let r = await ok('valider_dossier', { dossier: { societe: { socialDenomination: 'Smoke Domi' }, siege: { siegeType: 'madomiciliation', domiciliationAddressId: 2007 } } })
  assert.equal(r.valid, true); assert.equal(r.isComplete, false); assert.equal(r.corpsEnvoye.account.email, 'jean.dupont+smoke-domi@exemple.fr'); assert.ok(r.assumptions.length >= 5)
  await ko('valider_dossier', { dossier: { societe: { socialDenomination: 'X' } }, utiliserProfil: false }, /juridicForm requis/)

  step = 'A/creer'
  await ko('creer_societe', { dossier: { societe: { socialDenomination: 'Smoke Domi' }, siege: { siegeType: 'madomiciliation' }, account: { email: 'existe@exemple.fr' } } }, /existe\+bis@exemple\.fr/)
  // Un associé sans email et pas d'activité : deux groupes de questions restent, et la forme bascule SASU → SAS.
  r = await ok('creer_societe', { dossier: { societe: { socialDenomination: 'Smoke Domi' }, siege: { siegeType: 'madomiciliation', domiciliationAddressId: 2007, paymentInterval: 'month' }, associes: [{ type: 'physic', name: 'Martin', firstname: 'Claire', contributionAmount: '500' }] } })
  assert.equal(r.cree, true); assert.equal(r.registre, 'ok'); assert.equal(r.status, 'draft'); assert.equal(r.phase, 'pending'); assert.match(r.suite, /completer_dossier/); assert.equal(r.questionsAPoser, undefined)
  assert.equal(r.juridicForm, 'SAS'); assert.match(r.warnings[0].message, /basculée de SASU vers SAS/); assert.equal(r.completeness.questionGroups.length, 2)
  assert.equal(r.payment.quote.recurrence.moisOfferts, 1); assert.equal(r.paymentInterval, 'month'); assert.equal(r.payment.quote.lignes[0].key, 'legalFees'); assert.ok(r.assumptions.some(a => a.field === 'dougs' && a.valeur === 'Non')); assert.equal(r.documents, undefined, 'documents omis en pending')
  const pt = r.societe.publicToken; assert.ok(pt)
  const reg = JSON.parse(readFileSync(path.join(home, 'societes.json'), 'utf8'))
  assert.equal(reg.societes.length, 1, 'ancienne entrée purgée'); assert.match(reg.societes[0].token, /^mcc_/); assert.equal(JSON.stringify(reg).includes('ancien-mot-de-passe'), false)
  assert.equal(statSync(path.join(home, 'societes.json')).mode & 0o777, 0o600)
  r = await ok('creer_societe', { dossier: { societe: { socialDenomination: 'smoke domi' }, siege: { siegeType: 'madomiciliation' } } }); assert.equal(r.doublon, true); assert.equal(r.cree, false)

  step = 'A/compléter'
  await ko('ouvrir_paiement', {}, /pas complet/)
  r = await ok('completer_dossier', { max: 1 }); assert.equal(r.questionsPosees.length, 1); assert.equal(r.questionsPosees[0].action, 'accept'); assert.equal(r.groupesRestants, 1)
  r = await ok('completer_dossier'); assert.equal(r.completeness.isComplete, true, JSON.stringify(r.completeness)); assert.equal(r.status, 'ready_for_payment')
  r = await ok('statut_dossier', { detail: 'complet' }); assert.equal(r.sections.associes[0].email, 'associes0email@exemple.fr', 'liste associes complétée par le formulaire'); assert.equal(r.sections.associes[0].name, 'Martin'); assert.equal(r.sections.objet.activities[0].redaction, 'Réponse activities[0].redaction')
  r = await ok('completer_dossier'); assert.equal(r.dejaComplet, true)

  step = 'A/modifier'
  r = await ok('modifier_dossier', { modifications: { associes: [], juridicForm: 'SASU' } }); assert.equal(r.juridicForm, 'SASU'); assert.equal(r.warnings, undefined); assert.equal(r.completeness.isComplete, true)
  r = await ok('modifier_dossier', { modifications: { associes: [{ type: 'physic', name: 'Martin', firstname: 'Claire', email: 'claire@exemple.fr', contributionAmount: '500' }] } })
  assert.equal(r.juridicForm, 'SAS'); assert.match(r.warnings[0].message, /basculée de SASU vers SAS/)
  r = await ok('modifier_dossier', { modifications: { associes: [], juridicForm: 'SASU', objet: { activities: [{ redaction: activite, custom: false }] } } }); assert.equal(r.juridicForm, 'SASU')
  r = await ok('modifier_dossier', { modifications: { partners: { dougs: false }, societe: { sigle: 'SD' } } }); assert.ok(!r.assumptions.some(a => a.field === 'dougs'), 'hypothèse Dougs levée'); assert.equal(r.completeness.isComplete, true)
  await ko('modifier_dossier', { modifications: { dirigeant: { birthdate: 'hier' } } }, /dirigeant\.birthdate — Date invalide/)
  await ko('modifier_dossier', { modifications: { applyDefaults: true } }, /modifications vide/)
  r = await ok('statut_dossier', { detail: 'complet' }); assert.equal(r.sections.societe.sigle, 'SD'); assert.equal(r.sections.capital.ownerContributionAmount, '1000')

  step = 'A/paiement'
  await ko('ouvrir_mot_de_passe', {}, /pas encore payé/)
  r = await ok('ouvrir_paiement'); assert.equal(r.status, 'unpaid'); assert.equal(r.ouverture.mode, 'elicitation'); assert.equal(urls.at(-1), r.paymentUrl); assert.match(r.paymentUrl, new RegExp(`/creation-mcp/paiement/${pt}$`)); assert.match(r.quote.resume, /1 mois offert/)
  assert.match(r.suite, /TERMINER LA RÉPONSE MAINTENANT/); assert.match(r.suite, /tour suivant/); assert.match(r.ouverture.consigne, /termine ce tour/)
  assert.match(r.ouverture.cloture, /dès que le paiement est constaté/); assert.equal(clotures.length, 0, 'pas de clôture avant le paiement')
  // Une seule sonde par dossier et événement : un second ouvrir_paiement et statut_dossier attendre=… rejoignent la veille en cours
  // (sonde initiale + un réveil par abonné + au plus un tic de 8 s dans la fenêtre) au lieu de lancer chacun sa boucle.
  const sondesAvant = (await stats(apiUrl)).paymentProbes
  r = await ok('ouvrir_paiement'); assert.equal(r.status, 'unpaid'); assert.equal(r.ouverture.mode, 'elicitation'); assert.equal(urls.filter(u => u === r.paymentUrl).length, 2, 'deux elicitations de paiement'); assert.equal(clotures.length, 0)
  r = await ok('statut_dossier', { attendre: 'paiement', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, false); assert.match(r.attente.consigne, /links\.paymentPage/); assert.match(r.attente.consigne, /tour suivant/)
  assert.equal(clotures.length, 0, 'pas de clôture tant que le paiement n\'est pas constaté')
  const sondes = (await stats(apiUrl)).paymentProbes - sondesAvant
  assert.ok(sondes <= 5, `${sondes} sondes de paiement en 5 s pour trois abonnés : boucles non partagées`) // ouvrir_paiement lit aussi /payment une fois (devis)
  await hook(apiUrl, `/__test/pay/${pt}`)
  r = await ok('statut_dossier', { attendre: 'paiement', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, true); assert.equal(r.status, 'paid'); assert.equal(r.phase, 'provisioned'); assert.match(r.suite, /ouvrir_mot_de_passe/)
  await attendreCloture(clotures, 2); assert.equal(clotures.length, 2, 'les deux elicitations de paiement closes par la même veille'); assert.equal(new Set(clotures).size, 2)
  assert.equal(r.documents.items.find(i => i.key === 'owner_id_justif_file').fichierLocal, 'identite_recto (png, ID_CARD)')
  r = await ok('ouvrir_paiement'); assert.equal(r.status, 'paid')
  r = await ok('ouvrir_mot_de_passe'); assert.equal(r.ouverture.mode, 'elicitation'); assert.match(urls.at(-1), /mot-de-passe/); assert.match(r.suite, /tour suivant/)
  assert.match(r.ouverture.cloture, /dès que le mot de passe est constaté/); assert.equal(clotures.length, 2)
  await hook(apiUrl, `/__test/password/${pt}`)
  r = await ok('statut_dossier', { attendre: 'mot_de_passe', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, true); assert.equal(r.account.hasPassword, true); assert.equal(r.status, 'documents_pending')
  await attendreCloture(clotures, 3)
  r = await ok('ouvrir_mot_de_passe'); assert.equal(r.dejaDefini, true)
  await ko('modifier_dossier', { modifications: { account: { tel: '0600000000' } } }, /figés/)

  step = 'A/pièces'
  await ko('deposer_capital', { choice: 'banque' }, /owner_id_justif_file \(Pièce d'identité du dirigeant \(recto\)\)/)
  await ko('envoyer_piece', { key: 'owner_company_kbis', fichier: 'identite_recto' }, /non demandée/)
  await ko('envoyer_piece', { key: 'owner_address_justif_file', fichier: PNG }, /documentType obligatoire/)
  r = await ok('envoyer_piece', { key: 'owner_id_justif_file', fichier: 'identite_recto' })
  assert.equal(r.submission, 'awaiting_pair'); assert.equal(r.envoye.documentType, 'ID_CARD'); assert.equal(r.envoye.convertiEnPdf, false); assert.match(r.suite, /verso/)
  r = await ok('envoyer_piece', { key: 'owner_id_justif_file_2', fichier: 'identite_verso' }); assert.equal(r.submission, 'success'); assert.equal(r.envoye.documentType, null)
  r = await ok('envoyer_piece', { key: 'owner_address_justif_file', fichier: PNG, documentType: 'TAX_NOTICE' }); assert.equal(r.documents.isComplete, true); assert.equal(r.status, 'password_set'); assert.ok(r.nextActions.some(a => a.action === 'choose_capital_deposit'))

  step = 'A/capital'
  await hook(apiUrl, '/__test/fail-salesforce-once')
  await ko('deposer_capital', { choice: 'qonto' }, /Rejouer deposer_capital/)
  r = await ok('deposer_capital', { choice: 'qonto' }); assert.equal(r.status, 'submitted'); assert.equal(r.qonto.redirectionLink, 'https://qonto.com/signup/fake'); assert.equal(r.ouverture.mode, 'elicitation'); assert.equal(urls.at(-1), 'https://qonto.com/signup/fake')
  assert.match(r.ouverture.cloture, /immédiatement/); await attendreCloture(clotures, 4, 3000); assert.equal(new Set(clotures).size, 4, 'quatre elicitationId distincts')
  await ko('modifier_dossier', { modifications: { societe: { sigle: 'X' } } }, /finalisé/)
  r = await ok('mes_societes'); assert.equal(r.societes.length, 1); assert.equal(r.societes[0].status, 'submitted'); assert.equal(r.societes[0].token, undefined); assert.equal(r.entreesIgnorees.length, 0, 'ancienne entrée purgée du registre')
  await s.client.close()
  log('passe A (avec elicitation, domiciliation) : OK')
}

// ---------------------------------------------------------------- passe B : sans elicitation, dossier basic
const passB = async (apiUrl, home) => {
  const s = await startSession({ apiUrl, home, elicitation: false, urls: [] })
  const { ok, ko } = s
  await commonChecks(s, home, apiUrl)

  step = 'B/creer'
  let r = await ok('creer_societe', { dossier: { juridicForm: 'SASU', societe: { socialDenomination: 'Smoke Basic' }, siege: { siegeType: 'domicile-dirigeant', siegeCurrentAddress: '12 rue de Belzunce, 75010 Paris' } } })
  assert.equal(r.cree, true); assert.equal(r.product, 'basic'); assert.ok(r.questionsAPoser.length >= 1); assert.match(r.suite, /modifier_dossier/); assert.match(r.questionsAPoser[0], /objet\.activities\[0\]\.redaction — Activité principale/)
  assert.equal(r.payment.quote.recurrence, null)
  const pt = r.societe.publicToken

  step = 'B/compléter (repli)'
  r = await ok('completer_dossier'); assert.equal(r.stoppedBy, 'unsupported'); assert.ok(r.questionsAPoser.length >= 1)
  r = await ok('modifier_dossier', { modifications: { objet: { activities: [{ redaction: 'Le conseil aux entreprises', custom: true }] } } })
  assert.equal(r.completeness.isComplete, true, JSON.stringify(r.completeness.missing)); assert.equal(r.status, 'ready_for_payment')
  r = await ok('modifier_dossier', { modifications: { partners: { dougs: true } } }); assert.equal(r.completeness.isComplete, true)

  step = 'B/paiement (repli lien)'
  r = await ok('ouvrir_paiement'); assert.equal(r.ouverture.mode, 'lien'); assert.match(r.ouverture.consigne, /ne pas le recopier/); assert.match(r.paymentUrl, new RegExp(pt)); assert.equal(r.quote.recurrence, null); assert.equal(r.ouverture.cloture, undefined)
  await hook(apiUrl, `/__test/pay/${pt}`)
  r = await ok('statut_dossier', { attendre: 'paiement', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, true)
  r = await ok('ouvrir_mot_de_passe'); assert.equal(r.ouverture.mode, 'lien')
  await hook(apiUrl, `/__test/password/${pt}`)
  r = await ok('statut_dossier', { attendre: 'mot_de_passe', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, true)
  assert.deepEqual(r.documents.items.filter(i => i.required).map(i => i.key), ['owner_id_justif_file', 'siege_current_address_justif'])

  step = 'B/pièces (PDF forcé)'
  r = await ok('envoyer_piece', { key: 'owner_id_justif_file', fichier: 'identite_recto' })
  assert.equal(r.envoye.convertiEnPdf, true); assert.equal(r.envoye.filename, 'identite_recto.pdf'); assert.equal(r.envoye.documentType, null, 'pas de type sur un item pdf seul'); assert.equal(r.submission, null)
  r = await ok('envoyer_piece', { key: 'siege_current_address_justif', fichier: PNG }); assert.equal(r.envoye.convertiEnPdf, true); assert.equal(r.documents.isComplete, true)

  step = 'B/capital'
  r = await ok('deposer_capital', { choice: 'banque' }); assert.equal(r.status, 'submitted'); assert.equal(r.qonto, undefined); assert.match(r.suite, /banque/)
  r = await ok('deposer_capital', { choice: 'banque' }); assert.equal(r.status, 'submitted', 'rejeu idempotent')
  r = await ok('mes_societes'); assert.equal(r.societes.length, 1); assert.equal(r.profil.fondateur, 'Jean Dupont')
  await s.client.close()
  log('passe B (sans elicitation, basic) : OK')
}

// ---------------------------------------------------------------- passe C : serveur hébergé (HTTP sans session)
const HOSTED_TOOLS = ['guide_creation', 'lister_centres', 'rechercher_activites', 'schema_dossier', 'devis_creation', 'valider_dossier', 'creer_societe', 'statut_dossier', 'modifier_dossier', 'ouvrir_paiement']
const DIRIGEANT = { gender: 'MR', name: 'Dupont', firstname: 'Jean', birthdate: '12/01/1990', birthCity: 'Paris', birthPostalCode: '75010', nationality: 'Française', maritalStatus: 'Célibataire', fatherName: 'Dupont', fatherFirstname: 'Pierre', motherName: 'Martin', motherFirstname: 'Anne', ownerAddress: '12 rue de Belzunce, 75010 Paris', email: 'jean.dupont@exemple.fr', tel: '0612345678' }
const TOKEN_FORMAT = /^mcc_[A-Za-z0-9_-]{43}$/

const rawPost = (port, { host, body, accept = 'application/json, text/event-stream' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept, ...(host ? { host } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject)
  req.end(body || '{}')
})

const passC = async apiUrl => {
  // Le serveur tourne dans ce processus : l'API et le secret partagé viennent de l'environnement.
  process.env.MADOM_API_BASE_URL = apiUrl
  process.env.MADOM_MCP_INTERNAL_KEY = 'smoke-secret'
  const limiter = createLimiter({ requests: 80, creations: 2, unauthorized: 2 })
  const srv = await startHttpServer({ port: 0, host: '127.0.0.1', limiter, allowedHosts: ['127.0.0.1', 'mcp.ma-domiciliation.fr'], quiet: true })
  const s = await startHttpSession(srv.url)
  const { ok, ko } = s
  try {
    step = 'C/inventaire'
    const tools = (await s.client.listTools()).tools.map(t => t.name).sort()
    assert.deepEqual(tools, [...HOSTED_TOOLS].sort(), 'outils du mode hébergé')
    assert.deepEqual((await s.client.listPrompts()).prompts.map(p => p.name), ['creer-ma-societe'])
    const prompt = await s.client.getPrompt({ name: 'creer-ma-societe', arguments: {} }); assert.match(prompt.messages[0].content.text, /code de reprise/)
    const guide = await ok('guide_creation'); const guideText = JSON.stringify(guide)
    assert.equal(guide.etapes.length, 6); assert.match(guideText, /extraction/); assert.match(guideText, /code de reprise/); assert.match(guideText, /tout se passe sur le site/i)
    assert.doesNotMatch(guideText, /enregistrer_profil_fondateur|enregistrer_pieces_kyc|chercher_pieces|envoyer_piece|deposer_capital|completer_dossier|ouvrir_mot_de_passe|mes_societes/)
    assert.doesNotMatch(guideText, /\d\s?€/, 'montant dans le guide')
    assert.match(guideText, /PROPOSER au client.*accord explicite.*outils de fichiers de l'assistant.*en ouvrant les fichiers/, 'guide hébergé sans la proposition de recherche'); assert.match(prompt.messages[0].content.text, /attends mon accord avant de chercher/); assert.match(prompt.messages[0].content.text, /montre-moi ce que tu as trouvé/)
    assert.match(s.client.getInstructions() ?? '', /remarque de QA/, 'instructions serveur sans la règle de posture'); assert.match(guideText, /remarque de QA/); assert.match(prompt.messages[0].content.text, /comme à un client/)
    assert.match(s.client.getInstructions() ?? '', /message final/, 'instructions serveur sans la règle de remise au client'); assert.match(guide.remise_au_client, /sans appeler d'autre outil/)
    assert.match(JSON.stringify(guide.etapes[3].ordre_des_outils), /tour suivant/); assert.match(prompt.messages[0].content.text, /avant de vérifier/)
    const statutTool = (await s.client.listTools()).tools.find(t => t.name === 'statut_dossier'); assert.match(statutTool.description, /jamais dans le tour qui/); assert.match(statutTool.inputSchema.properties.attendre.description, /tour suivant/)
    const health = await fetch(`http://127.0.0.1:${srv.port}/health`).then(r => r.json()); assert.equal(health.ok, true); assert.equal(health.mode, 'distant'); assert.equal(health.api, new URL(apiUrl).host)

    step = 'C/référentiels'
    let r = await ok('lister_centres'); assert.equal(r.items[0].id, 2007)
    r = await ok('devis_creation', { juridicForm: 'SASU', product: 'basic' }); assert.equal(r.aujourdHui.ttc, '307,96 €')
    r = await ok('devis_creation', { juridicForm: 'SASU', product: 'domiciliation', paymentInterval: '2years' }); assert.equal(r.recurrence.remisePremiereEcheancePourcent, 35); assert.match(r.resume, /2 ans/)

    step = 'C/jeton requis'
    await ko('statut_dossier', {}, /jeton/i)
    await ko('statut_dossier', { jeton: 'mcc_trop-court' }, /mal formé/)
    await ko('modifier_dossier', { jeton: 'pas-un-jeton', modifications: { societe: { sigle: 'X' } } }, /mal formé/)

    step = 'C/creer'
    const dossier = { juridicForm: 'SASU', societe: { socialDenomination: 'Smoke Hébergé' }, account: { email: 'jean+smoke-heberge@exemple.fr', tel: '0612345678' }, siege: { siegeType: 'domicile-dirigeant', siegeCurrentAddress: '12 rue de Belzunce, 75010 Paris' }, dirigeant: DIRIGEANT, objet: { activities: [{ redaction: 'Le conseil aux entreprises', custom: true }] } }
    r = await ok('valider_dossier', { dossier }); assert.match(r.mode, /nouveau dossier/); assert.equal(r.valid, true)
    r = await ok('creer_societe', { dossier }, { allowToken: true })
    assert.equal(r.cree, true); assert.match(r.jeton, TOKEN_FORMAT); assert.match(r.consigne, /code de reprise/); assert.match(r.consigne, /message final/); assert.equal(r.registre, undefined)
    assert.equal(r.completeness.isComplete, true, JSON.stringify(r.completeness.missing)); assert.match(r.suite, /ouvrir_paiement/)
    const jeton = r.jeton; const pt = r.societe.publicToken; assert.ok(pt)
    const last = await fetch(`${apiUrl}/__test/last-create`).then(x => x.json())
    assert.equal(last.clientIp, '127.0.0.1', 'IP cliente transmise à l\'API'); assert.equal(last.mcpKey, 'smoke-secret', 'secret partagé transmis à l\'API')

    step = 'C/dossier'
    r = await ok('statut_dossier', { jeton }); assert.equal(r.societe.publicToken, pt); assert.equal(r.status, 'ready_for_payment'); assert.ok(r.links.customerArea)
    r = await ok('valider_dossier', { jeton, dossier: { societe: { sigle: 'SH' } } }); assert.equal(r.mode, 'dossier existant'); assert.equal(r.valid, true)
    r = await ok('modifier_dossier', { jeton, modifications: { partners: { dougs: false } } }); assert.equal(r.completeness.isComplete, true); assert.match(r.suite, /ouvrir_paiement/)
    r = await ok('modifier_dossier', { jeton, modifications: { objet: { activities: [] } } }); assert.equal(r.completeness.isComplete, false); assert.ok(r.questionsAPoser.length >= 1); assert.match(r.suite, /conversation/)
    r = await ok('modifier_dossier', { jeton, modifications: { objet: { activities: [{ redaction: 'Le conseil aux entreprises', custom: true }] } } }); assert.equal(r.completeness.isComplete, true)

    step = 'C/paiement (lien seul)'
    r = await ok('ouvrir_paiement', { jeton }); assert.equal(r.ouverture.mode, 'lien'); assert.match(r.paymentUrl, new RegExp(pt)); assert.match(r.suite, /customerArea/)
    assert.match(r.suite, /TERMINER LA RÉPONSE MAINTENANT/); assert.match(r.suite, /tour suivant/); assert.match(r.ouverture.consigne, /termine ce tour/)
    r = await ok('statut_dossier', { jeton, attendre: 'paiement', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, false); assert.match(r.attente.consigne, /paymentPage/); assert.match(r.attente.consigne, /sans relancer en boucle/)
    await hook(apiUrl, `/__test/pay/${pt}`)
    r = await ok('statut_dossier', { jeton, attendre: 'paiement', delaiMaxSecondes: 5 }); assert.equal(r.attente.atteint, true); assert.match(r.suite, /passwordPage/); assert.match(r.suite, /customerArea/)
    await ko('statut_dossier', { jeton, attendre: 'mot_de_passe' })
    r = await ok('ouvrir_paiement', { jeton }); assert.equal(r.status, 'paid'); assert.match(r.suite, /site/)

    step = 'C/limite de créations'
    r = await ok('creer_societe', { dossier: { ...dossier, account: { email: 'jean+smoke-heberge-2@exemple.fr', tel: '0612345678' } } }, { allowToken: true }); assert.match(r.jeton, TOKEN_FORMAT)
    await ko('creer_societe', { dossier }, /RATE_LIMITED_LOCAL/)

    step = 'C/jetons inconnus'
    const unknown = `mcc_${'A'.repeat(43)}`
    let text = await ko('statut_dossier', { jeton: unknown }, /inconnu ou révoqué/); assert.doesNotMatch(text, /AAAAAAAA/, 'jeton inconnu recopié dans l\'erreur')
    await ko('statut_dossier', { jeton: unknown }, /inconnu ou révoqué/)
    text = await ko('statut_dossier', { jeton: unknown }, /RATE_LIMITED_LOCAL/)
    await ko('statut_dossier', { jeton }, /RATE_LIMITED_LOCAL/) // même IP : bloquée aussi avec un jeton valide

    step = 'C/HTTP brut'
    assert.equal(await rawPost(srv.port, { host: 'evil.example' }), 403, 'hôte interdit')
    assert.equal((await fetch(srv.url)).status, 405)
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/autre`)).status, 404)
    let status = 200
    for (let i = 0; i < 100 && status !== 429; i++) status = await rawPost(srv.port, { body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) })
    assert.equal(status, 429, '429 au-delà des requêtes par minute')
  } finally {
    await s.client.close()
    await srv.close()
    delete process.env.MADOM_MCP_INTERNAL_KEY
  }
  log('passe C (serveur hébergé, HTTP) : OK')
}

// ---------------------------------------------------------------- main
const main = async () => {
  const api = await startFakeApi()
  try {
    for (const [name, pass] of [['A', passA], ['B', passB]]) {
      const home = mkdtempSync(path.join(tmpdir(), `madom-smoke-${name}-`))
      mkdirSync(home, { recursive: true })
      // Registre d'une ancienne version (uuid + mot de passe) : doit être ignoré puis purgé.
      writeFileSync(path.join(home, 'societes.json'), JSON.stringify({ societes: [{ token: 'c0ffee00-uuid', name: 'Ancienne SAS', password: 'ancien-mot-de-passe', createdAt: '2026-09-01T00:00:00Z' }] }))
      await fetch(`${api.url}/__test/reset`, { method: 'POST' })
      await pass(api.url, home)
    }
    await fetch(`${api.url}/__test/reset`, { method: 'POST' })
    await passC(api.url)
    assert.ok(!outputs.some(o => !o.allowToken && TOKEN_RE.test(o.text)), 'un jeton de dossier est sorti d\'un outil')
    const revealed = outputs.filter(o => o.allowToken).length
    process.stderr.write(`smoke OK — ${outputs.length} appels d'outils, aucun jeton en sortie (hors ${revealed} creer_societe hébergés)\n`)
  } catch (err) {
    process.stderr.write(`smoke KO à l'étape « ${step} » : ${err.stack || err}\n`)
    process.exitCode = 1
  } finally {
    await api.close()
  }
}

await main()
process.exit(process.exitCode || 0)
