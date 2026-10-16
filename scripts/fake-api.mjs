#!/usr/bin/env node
// Faux serveur /api/mcp-creation en mémoire, contrat réduit de specs/api-mcp-creation.md (§ 2–10),
// pour le smoke (scripts/smoke.mjs). Importable (startFakeApi) ou lancé seul : `node scripts/fake-api.mjs [port]`.
// Hooks de test : POST /__test/pay/:publicToken, POST /__test/password/:publicToken, POST /__test/fail-salesforce-once,
// POST /__test/fail-quote-once (le prochain POST /quotes en 3years répond 500),
// POST /__test/reset, GET /__test/last-create (en-têtes d'IP cliente reçus au dernier POST /dossiers),
// GET /__test/stats (compteurs d'appels : quotes, paymentProbes, dossierProbes ; remis à zéro par /__test/reset).

import http from 'node:http'
import { randomBytes } from 'node:crypto'

const SUPPORTED_FORMS = ['SASU', 'SAS', 'SARL', 'EURL', 'SCI']
const SECTIONS = ['siege', 'dirigeant', 'associes', 'societe', 'objet', 'fiscalite', 'capital', 'capitalDeposit']
const LIST_SECTIONS = ['associes']
const CENTRES = [
  { id: 2007, name: 'Paris 75008 - Champs-Élysées', address: '66 avenue des Champs-Élysées', cp: '75008', city: 'Paris' },
  { id: 2006, name: 'Lyon 69002 - Bellecour', address: '10 place Bellecour', cp: '69002', city: 'Lyon' },
]
const ACTIVITES = [
  { label: 'Développement de logiciels', redaction: 'La conception, le développement et l\'édition de logiciels et d\'applications', nature: 'commerciale', reglementee: false, justificatif: null, keywords: ['logiciel', 'application', 'développement', 'app', 'saas'], category: 'Tech' },
  { label: 'Conseil', redaction: 'Le conseil aux entreprises en stratégie et organisation', nature: 'commerciale', reglementee: false, justificatif: null, keywords: ['conseil', 'consulting', 'stratégie'], category: 'Services' },
]
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const field = (section, key, label, extra = {}) => ({ section, field: key, step: section, label, type: extra.type || 'string', askTo: 'dirigeant', blocks: 'payment', ...extra })
const REQUIRED_DIRIGEANT = [
  field('dirigeant', 'gender', 'Civilité', { type: 'enum', options: [{ value: 'MR', title: 'Monsieur' }, { value: 'MME', title: 'Madame' }], elicitation: { type: 'string', title: 'Civilité', oneOf: [{ const: 'MR', title: 'Monsieur' }, { const: 'MME', title: 'Madame' }] } }),
  field('dirigeant', 'name', 'Nom de naissance', { elicitation: { type: 'string', title: 'Nom' } }),
  field('dirigeant', 'firstname', 'Prénom', { elicitation: { type: 'string', title: 'Prénom' } }),
  field('dirigeant', 'birthdate', 'Date de naissance', { type: 'date', example: '12/01/1995', elicitation: { type: 'string', title: 'Date de naissance', description: 'JJ/MM/AAAA' } }),
  field('dirigeant', 'birthCity', 'Ville de naissance', { elicitation: { type: 'string', title: 'Ville de naissance' } }),
  field('dirigeant', 'birthPostalCode', 'Code postal de naissance', { elicitation: { type: 'string', title: 'Code postal' } }),
  field('dirigeant', 'nationality', 'Nationalité', { elicitation: { type: 'string', title: 'Nationalité' } }),
  field('dirigeant', 'fatherName', 'Nom du père', { elicitation: { type: 'string', title: 'Nom du père' } }),
  field('dirigeant', 'motherName', 'Nom de la mère', { elicitation: { type: 'string', title: 'Nom de la mère' } }),
  field('dirigeant', 'ownerAddress', 'Adresse personnelle', { elicitation: { type: 'string', title: 'Adresse' } }),
  field('dirigeant', 'hadPreviousNonSalariedActivity', 'Activité non salariée antérieure ?', { type: 'boolean', elicitation: { type: 'boolean', title: 'Activité non salariée antérieure' } }),
]
const OBJET_FIELD = field('objet', 'activities[0].redaction', 'Activité principale', { elicitation: { type: 'string', title: 'Activité', description: 'Rédaction de l\'activité (rechercher_activites)' } })
const CAPITAL_FIELD = field('capital', 'ownerContributionAmount', 'Apport du dirigeant', { type: 'amount', example: '1000', elicitation: { type: 'string', title: 'Apport (euros)' } })
const DOUGS = { key: 'dougs', label: 'Mise en relation avec Dougs (expertise comptable en ligne)', type: 'boolean', askTo: 'dirigeant', hint: 'Dougs est un cabinet d\'expertise comptable en ligne partenaire : mise en relation pour un devis de comptabilité, sans engagement ; le client est recontacté par Dougs.', requiredWhen: 'never' }

// Décision du 2026-10-12 (contrat § 4, `billing-period.js` côté site) : accompagnement offert (aucune ligne
// de service), frais légaux seuls le jour J, essai d'un mois conservé, cadences month | year | 2years | 3years
// (Price year / interval_count 1, 2, 3) remisées sur la première échéance (25 / 35 / 45 %).
const BILLING_PERIODS = {
  month: { interval: 'month', intervalCount: 1, months: 1, discountPercent: 0 },
  year: { interval: 'year', intervalCount: 1, months: 12, discountPercent: 25 },
  '2years': { interval: 'year', intervalCount: 2, months: 24, discountPercent: 35 },
  '3years': { interval: 'year', intervalCount: 3, months: 36, discountPercent: 45 },
}
const PAYMENT_INTERVALS = Object.keys(BILLING_PERIODS)
const PAYMENT_INTERVAL_OPTIONS = [{ value: 'month', title: 'Mensuel' }, { value: 'year', title: 'Annuel (1 an)' }, { value: '2years', title: 'Engagement 2 ans' }, { value: '3years', title: 'Engagement 3 ans' }]
const MONTHLY_HT = 2990
const SCHEMA = {
  juridicForms: SUPPORTED_FORMS, dateFormat: 'JJ/MM/AAAA', limits: { associes: 20 }, conventions: { amounts: 'chaînes de chiffres' },
  sections: [
    { key: 'siege', title: 'Siège', kind: 'object', step: 'siege', askTo: 'dirigeant', fields: [{ key: 'siegeType', label: 'Type de siège', type: 'enum', options: ['madomiciliation', 'domicile-dirigeant', 'local-pro', 'centre-tiers'], askTo: 'dirigeant', requiredWhen: 'always' }, { key: 'domiciliationAddressId', label: 'Centre', type: 'integer', optionsRef: 'domiciliation-addresses', askTo: 'dirigeant', requiredWhen: 'siegeType = madomiciliation' }, { key: 'paymentInterval', label: 'Fréquence de paiement de la domiciliation', type: 'enum', options: PAYMENT_INTERVAL_OPTIONS, askTo: 'dirigeant', requiredWhen: 'never' }] },
    { key: 'dirigeant', title: 'Dirigeant', kind: 'object', step: 'dirigeant', askTo: 'dirigeant', fields: REQUIRED_DIRIGEANT.map(f => ({ key: f.field, label: f.label, type: f.type, options: f.options, askTo: 'dirigeant', requiredWhen: 'always' })) },
    { key: 'associes', title: 'Associés', kind: 'list', step: 'associes', askTo: 'dirigeant', fields: [] },
    { key: 'societe', title: 'Société', kind: 'object', step: 'societe', askTo: 'dirigeant', fields: [{ key: 'socialDenomination', label: 'Dénomination', type: 'string', askTo: 'dirigeant', requiredWhen: 'always' }, { key: 'sigle', label: 'Sigle', type: 'string', askTo: 'dirigeant', requiredWhen: 'never' }] },
    { key: 'objet', title: 'Objet', kind: 'object', step: 'objet', askTo: 'dirigeant', fields: [{ key: 'activities', label: 'Activités', type: 'list', askTo: 'dirigeant', requiredWhen: 'always' }] },
    { key: 'fiscalite', title: 'Fiscalité', kind: 'object', step: 'fiscalite', askTo: 'dirigeant', fields: [{ key: 'regimeFiscalTva', label: 'Régime de TVA', type: 'enum', options: ['franchise', 'reel_simplifie', 'reel_normal'], askTo: 'dirigeant', requiredWhen: 'always' }] },
    { key: 'capital', title: 'Capital', kind: 'object', step: 'capital', askTo: 'dirigeant', fields: [{ key: 'ownerContributionAmount', label: 'Apport du dirigeant', type: 'amount', askTo: 'dirigeant', requiredWhen: 'always' }, { key: 'nominalShareValue', label: 'Valeur nominale', type: 'amount', askTo: 'dirigeant', requiredWhen: 'always' }, { key: 'capitalDepositary', label: 'Dépositaire', type: 'enum', options: ['neobanque', 'banque'], askTo: 'dirigeant', requiredWhen: 'always' }] },
    { key: 'capitalDeposit', title: 'Dépôt de capital', kind: 'object', step: 'capitalDeposit', askTo: 'dirigeant', fields: [{ key: 'choice', label: 'Choix', type: 'enum', options: ['qonto', 'banque'], askTo: 'dirigeant', requiredWhen: 'never' }] },
    { key: 'account', title: 'Compte', kind: 'object', step: null, askTo: 'dirigeant', fields: [{ key: 'email', label: 'Email', type: 'email', askTo: 'dirigeant', requiredWhen: 'creation' }, { key: 'tel', label: 'Téléphone', type: 'tel', askTo: 'dirigeant', requiredWhen: 'creation' }] },
    { key: 'partners', title: 'Partenaires', kind: 'object', step: null, askTo: 'dirigeant', fields: [DOUGS] },
  ],
  itemSections: [{ key: 'associe', title: 'Associé', fields: [{ key: 'type', label: 'Type', type: 'enum', options: ['physic', 'moral'], requiredWhen: 'always' }, { key: 'name', label: 'Nom', type: 'string', requiredWhen: 'type = physic' }, { key: 'email', label: 'Email', type: 'email', requiredWhen: 'type = physic' }, { key: 'contributionAmount', label: 'Apport', type: 'amount', requiredWhen: 'always' }] }],
}
const JURIDIC_FORMS = { items: SUPPORTED_FORMS.map(code => ({ code, label: code, titreLabel: ['SASU', 'SAS'].includes(code) ? 'action' : 'part', minAssocies: ['SAS', 'SARL', 'SCI'].includes(code) ? 2 : 1, ownerMustBePerson: ['SARL', 'EURL', 'SCI'].includes(code), regimesFiscaux: [{ key: code === 'SCI' ? 'revenu_foncier' : 'reel_simplifie_is', label: 'IS réel simplifié', reco: true }], regimesTva: [{ key: 'reel_simplifie', label: 'Réel simplifié', reco: true }, { key: 'franchise', label: 'Franchise' }], exerciceMois: ['31 Décembre', '30 Juin'], exerciceAnnee: ['N', 'N+1'] })) }

const LEGAL_FEES = { SASU: 25663, SAS: 32263, SARL: 26263, EURL: 25663, SCI: 27263 }
const buildQuote = (juridicForm, product, paymentInterval) => {
  const vat = ht => Math.round(ht * 0.2)
  const line = (key, label, ht, extra = {}) => ({ key, label, ht, vat: vat(ht), ttc: ht + vat(ht), ...extra })
  const legalFees = line('legalFees', `Frais de greffe et annonce légale (${juridicForm})`, LEGAL_FEES[juridicForm])
  if (product === 'basic') {
    return { currency: 'eur', product, paymentInterval: null, lines: [legalFees], dueToday: { ht: legalFees.ht, vat: legalFees.vat, ttc: legalFees.ttc }, recurring: null }
  }
  const cadence = paymentInterval || 'month'
  const period = BILLING_PERIODS[cadence]
  const periode = period.intervalCount === 1 ? '1ʳᵉ année' : `${period.intervalCount} ans`
  const lines = [legalFees,
    line('domiciliation', period.interval === 'year' ? `Domiciliation — 1ᵉʳ mois offert, puis ${periode} (remise ${period.discountPercent} %)` : 'Domiciliation — 1ᵉʳ mois offert, puis mensuel', 0, { recurring: true }),
    line('expedition', 'Courrier numérisé et recyclé', 0, { recurring: true })]
  const ht = lines.reduce((s, l) => s + l.ht, 0)
  const amountHt = MONTHLY_HT * period.months
  return {
    currency: 'eur', product, paymentInterval: cadence, lines, dueToday: { ht, vat: vat(ht), ttc: ht + vat(ht) },
    recurring: { interval: period.interval, intervalCount: period.intervalCount, amountHt, monthlyHt: Math.round(amountHt / period.months), trialMonths: 1, firstBillingDiscountPercent: period.discountPercent },
  }
}
const quoteOf = (d, prod) => buildQuote(d.juridicForm, prod, d.sections.siege.paymentInterval)

// ---- état
const dossiers = {} // token → dossier
const byPublic = {}
let failSalesforceOnce = false
let failQuoteOnce = false
let lastCreate = null // { clientIp, mcpKey } du dernier POST /dossiers (serveur hébergé)
const stats = { quotes: 0, paymentProbes: 0, dossierProbes: 0 } // appels reçus (vérification du nombre d'appels côté MCP)

const emptySections = () => ({ siege: {}, dirigeant: { coDirigeants: [] }, associes: [], societe: {}, objet: { activities: [] }, fiscalite: {}, capital: {}, capitalDeposit: {} })
const isBlank = v => v === undefined || v === null || v === ''

// Validation des formats et de la grammaire → errors[]
const validateBody = (body, { creation = false, current = null }) => {
  const errors = []
  const push = (section, field, message) => errors.push({ section, field, message })
  if (creation && !body.juridicForm) push(null, 'juridicForm', 'Forme juridique requise')
  for (const key of Object.keys(body)) {
    if (!['juridicForm', 'applyDefaults', 'account', 'partners', 'attribution', ...SECTIONS].includes(key)) push(key, null, 'Section inconnue')
  }
  const d = body.dirigeant || {}
  if (!isBlank(d.birthdate) && !DATE_RE.test(d.birthdate)) push('dirigeant', 'birthdate', 'Date invalide (JJ/MM/AAAA)')
  if (!isBlank(d.email) && !EMAIL_RE.test(d.email)) push('dirigeant', 'email', 'Email invalide')
  if (!isBlank(d.tel) && !/^(\+33|0)[1-9](\d{2}){4}$/.test(String(d.tel).replace(/[\s.-]/g, ''))) push('dirigeant', 'tel', 'Numéro de téléphone invalide')
  if (!isBlank(body.account?.email) && !EMAIL_RE.test(body.account.email)) push('account', 'email', 'Email invalide')
  if (body.siege?.siegeType && !['madomiciliation', 'domicile-dirigeant', 'local-pro', 'centre-tiers'].includes(body.siege.siegeType)) push('siege', 'siegeType', 'Type de siège invalide')
  if (body.siege?.siegeType === 'madomiciliation' && body.siege.domiciliationAddressId && !CENTRES.some(c => c.id === body.siege.domiciliationAddressId)) push('siege', 'domiciliationAddressId', 'Centre de domiciliation inconnu')
  if (body.partners && Object.keys(body.partners).some(k => k !== 'dougs')) push('partners', Object.keys(body.partners).find(k => k !== 'dougs'), 'Champ inconnu')
  ;(body.associes || []).forEach((a, i) => { if (a.siren && !/^\d{9}$/.test(a.siren)) push('associes', `associes[${i}].siren`, 'SIREN invalide (9 chiffres)') })
  if (!isBlank(body.capital?.ownerContributionAmount) && !/^\d+$/.test(String(body.capital.ownerContributionAmount))) push('capital', 'ownerContributionAmount', 'Montant invalide (chaîne de chiffres)')
  if (creation) {
    if (isBlank(body.account?.email)) push('account', 'email', 'Champ requis à la création du dossier')
    if (isBlank(body.account?.tel)) push('account', 'tel', 'Champ requis à la création du dossier')
    if (isBlank(body.societe?.socialDenomination)) push('societe', 'socialDenomination', 'Champ requis à la création du dossier')
    if (isBlank(body.siege?.siegeType)) push('siege', 'siegeType', 'Champ requis à la création du dossier')
  }
  if (current?.paid && body.account) push('account', null, 'Le compte ne peut plus être modifié après paiement')
  if (body.siege?.paymentInterval !== undefined && !PAYMENT_INTERVALS.includes(body.siege.paymentInterval)) push('siege', 'paymentInterval', PAYMENT_INTERVALS.join(' | '))
  if (current?.paid && body.siege && (body.siege.domiciliationAddressId !== undefined || body.siege.paymentInterval !== undefined)) push('siege', null, 'Adresse de domiciliation définitive après paiement')
  return errors
}

const mergeSections = (sections, body) => {
  for (const key of SECTIONS) {
    if (body[key] === undefined) continue
    if (LIST_SECTIONS.includes(key)) { sections[key] = JSON.parse(JSON.stringify(body[key] || [])); continue }
    for (const [k, v] of Object.entries(body[key] || {})) {
      if (v === null) delete sections[key][k]
      else if (v !== undefined) sections[key][k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v
    }
  }
}

const DEFAULTS = [
  ['fiscalite', 'regimeFiscalTva', 'reel_simplifie', 'Régime de TVA', 'Réel simplifié'],
  ['fiscalite', 'exerciceMois', '31 Décembre', 'Clôture de l\'exercice', '31 Décembre'],
  ['capital', 'ownerContributionAmount', '1000', 'Apport du dirigeant', '1 000 €'],
  ['capital', 'nominalShareValue', '1', 'Valeur nominale', '1 €'],
  ['capital', 'capitalDepositary', 'neobanque', 'Dépositaire du capital', 'Néobanque (Qonto)'],
  ['capitalDeposit', 'choice', 'qonto', 'Dépôt de capital', 'Qonto'],
  ['dirigeant', 'hadPreviousNonSalariedActivity', false, 'Activité non salariée antérieure', 'Non'],
]
const applyDefaults = d => {
  for (const [section, key, value, label, valueLabel] of DEFAULTS) {
    if (isBlank(d.sections[section][key])) { d.sections[section][key] = value; d.assumptions.push({ section, field: key, value, label, valueLabel }) }
  }
  if (d.partners.dougs === undefined || d.partners.dougs === null) { d.partners.dougs = false; d.assumptions.push({ section: 'partners', field: 'dougs', value: false, label: 'Mise en relation Dougs', valueLabel: 'Non' }) }
}
const refreshAssumptions = d => { d.assumptions = d.assumptions.filter(a => (a.section === 'partners' ? d.partners[a.field] === a.value : d.sections[a.section][a.field] === a.value)) }

const applyFormRules = (d, explicit) => {
  const n = d.sections.associes.length
  const before = d.juridicForm
  if (explicit) d.juridicForm = explicit
  if (d.juridicForm === 'SASU' && n > 0) d.juridicForm = 'SAS'
  else if (d.juridicForm === 'SAS' && n === 0 && !explicit) d.juridicForm = 'SASU'
  else if (d.juridicForm === 'EURL' && n > 0) d.juridicForm = 'SARL'
  else if (d.juridicForm === 'SARL' && n === 0 && !explicit) d.juridicForm = 'EURL'
  const warnings = []
  if (d.juridicForm !== before && d.juridicForm !== explicit) warnings.push({ code: 'JURIDIC_FORM_SWITCHED', from: before, to: d.juridicForm })
  if (d.paid && d.juridicForm !== before) warnings.push({ code: 'JURIDIC_FORM_CHANGED_AFTER_PAYMENT' })
  return warnings
}

const completeness = d => {
  const s = d.sections
  const missing = REQUIRED_DIRIGEANT.filter(f => isBlank(s.dirigeant[f.field]))
  if (!s.objet.activities?.length || isBlank(s.objet.activities[0]?.redaction)) missing.push(OBJET_FIELD)
  if (isBlank(s.capital.ownerContributionAmount)) missing.push(CAPITAL_FIELD)
  s.associes.forEach((a, i) => { if (isBlank(a.email)) missing.push(field('associes', `associes[${i}].email`, `Email de l'associé ${i + 1}`, { askTo: 'associe', elicitation: { type: 'string', format: 'email', title: 'Email' } })) })
  if (['SAS', 'SARL', 'SCI'].includes(d.juridicForm) && s.associes.length < 1) missing.push({ section: 'associes', field: null, step: 'associes', label: 'Au moins un associé en plus du dirigeant', type: 'rule', askTo: 'dirigeant', blocks: 'payment', elicitation: null })
  const groups = []
  const bySection = {}
  for (const m of missing) (bySection[m.section] ||= []).push(m)
  for (const [section, fields] of Object.entries(bySection)) {
    const chunks = []; for (let i = 0; i < fields.length; i += 8) chunks.push(fields.slice(i, i + 8))
    chunks.forEach((chunk, i) => groups.push({ key: chunks.length > 1 ? `${section}-${i + 1}` : section, title: `${SCHEMA.sections.find(x => x.key === section)?.title || section}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`, askTo: chunk[0].askTo, fields: chunk }))
  }
  const steps = [...new Set(missing.map(m => m.section))].map(key => ({ key, label: SCHEMA.sections.find(x => x.key === key)?.title || key }))
  return { isComplete: missing.length === 0, incompleteSteps: steps, missing, questionGroups: groups, errors: [] }
}

const product = d => (d.sections.siege.siegeType === 'madomiciliation' ? 'domiciliation' : 'basic')
const documentsItems = d => {
  const p = d.pieces
  const item = (key, label, required, formats, withType, options) => ({ key, section: 'identite', label, hint: null, required, status: p[key] ? 'received' : 'missing', formats, documentType: withType ? { value: p[key]?.type ?? null, options } : null, verification: p[key]?.verif ?? null })
  if (d.paid && product(d) === 'domiciliation') {
    return [
      item('owner_id_justif_file', 'Pièce d\'identité du dirigeant (recto)', true, ['pdf', 'jpeg', 'png'], true, [{ value: 'ID_CARD', title: 'Carte d\'identité' }, { value: 'PASSPORT', title: 'Passeport' }, { value: 'RESIDENCE_PERMIT', title: 'Titre de séjour' }]),
      item('owner_id_justif_file_2', 'Pièce d\'identité du dirigeant (verso)', p.owner_id_justif_file?.type !== 'PASSPORT', ['pdf', 'jpeg', 'png'], false),
      item('owner_address_justif_file', 'Justificatif de domicile du dirigeant', true, ['pdf', 'jpeg', 'png'], true, ['PROVIDER_INVOICE_OR_SCHEDULE', 'TAX_NOTICE', 'RENT_RECEIPT']),
      { key: 'statuts_file', section: 'statuts', label: 'Statuts', hint: null, required: false, status: 'auto', formats: ['pdf'], documentType: null, verification: null },
    ]
  }
  const items = [item('owner_id_justif_file', 'Pièce d\'identité du dirigeant', true, ['pdf'], false), item('owner_id_justif_file_2', 'Pièce d\'identité du dirigeant (verso)', false, ['pdf'], false)]
  if (d.sections.siege.siegeType === 'domicile-dirigeant') items.push(item('siege_current_address_justif', 'Justificatif de domicile du siège', true, ['pdf'], false))
  items.push({ key: 'statuts_file', section: 'statuts', label: 'Statuts', hint: null, required: false, status: 'auto', formats: ['pdf'], documentType: null, verification: null })
  return items
}

const HOST = 'http://localhost:3002'
const links = d => ({ paymentPage: `${HOST}/creation-mcp/paiement/${d.publicToken}`, passwordPage: `${HOST}/creation-mcp/mot-de-passe/${d.publicToken}`, customerArea: `${HOST}/creation-entreprise/dossier` })

const serialize = (d, { quote = false, warnings = [] } = {}) => {
  const c = completeness(d)
  const items = documentsItems(d)
  const requiredOk = items.filter(i => i.required).every(i => i.status === 'received')
  const netheosOk = items.every(i => !i.verification || ['validated', 'pending'].includes(i.verification.status))
  let status
  if (d.submitted) status = 'submitted'
  else if (d.paid) status = !d.password ? 'paid' : (requiredOk && netheosOk ? 'password_set' : 'documents_pending')
  else status = d.paymentAttempt ? 'awaiting_payment' : (c.isComplete ? 'ready_for_payment' : 'draft')
  const nextActions = []
  if (!d.paid) {
    if (!c.isComplete) nextActions.push({ action: 'ask', label: `Poser les ${c.missing.length} questions restantes au client`, groups: c.questionGroups.map(g => g.key) })
    else nextActions.push({ action: 'pay', url: links(d).paymentPage })
  } else if (d.submitted) nextActions.push({ action: 'done' })
  else {
    if (!d.password) nextActions.push({ action: 'wait_password', url: links(d).passwordPage })
    const missing = items.filter(i => i.required && i.status === 'missing').map(i => i.key)
    if (missing.length) nextActions.push({ action: 'upload', reason: 'missing', label: `Transmettre ${missing.length} pièce(s)`, keys: missing })
    const rejected = items.filter(i => i.verification?.status === 'rejected').map(i => i.key)
    if (rejected.length) nextActions.push({ action: 'upload', reason: 'rejected', label: 'Redéposer les pièces refusées', keys: rejected })
    if (d.password && requiredOk && !rejected.length) nextActions.push({ action: 'choose_capital_deposit' })
  }
  const prod = product(d)
  return {
    phase: d.paid ? 'provisioned' : 'pending', status, juridicForm: d.juridicForm, product: prod, paymentInterval: prod === 'domiciliation' ? (d.sections.siege.paymentInterval || 'month') : null,
    sections: d.sections, completeness: c, assumptions: d.assumptions,
    documents: { isComplete: requiredOk, items },
    payment: { status: d.paid ? 'paid' : (d.paymentAttempt ? 'pending' : 'unpaid'), paymentUrl: links(d).paymentPage, quote: quote ? quoteOf(d, prod) : null, paidAt: d.paidAt },
    account: { email: d.account.email, tel: d.account.tel, hasPassword: d.password },
    qonto: { redirectionLink: d.submitted && d.capitalChoice === 'qonto' ? 'https://qonto.com/signup/fake' : null, status: null },
    domiciliation: d.paid && prod === 'domiciliation' ? { required: true, courseReady: true, netheosStatus: 'ATTENTE_DOCUMENTS', blocked: false, identity: { status: d.pieces.owner_id_justif_file_2 ? 'VALIDATION_OK' : null, attempts: d.pieces.owner_id_justif_file_2 ? 1 : 0, documentType: d.pieces.owner_id_justif_file?.type ?? null, hasVerso: !!d.pieces.owner_id_justif_file_2 }, address: { status: d.pieces.owner_address_justif_file ? 'VALIDATION_OK' : null, attempts: d.pieces.owner_address_justif_file ? 1 : 0, documentType: d.pieces.owner_address_justif_file?.type ?? null }, piecesValidated: requiredOk, questionnaireDone: false, signatureDone: false } : null,
    warnings, links: links(d), nextActions,
  }
}

// ---- serveur
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
const error = (res, status, error, message, details) => json(res, status, details === undefined ? { error, message } : { error, message, details })
const readJson = async req => { let body = ''; for await (const c of req) body += c; if (!body) return {}; try { return JSON.parse(body) } catch { return null } }

const handle = async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const auth = req.headers.authorization
  let d = null
  if (auth) {
    const m = /^Bearer (mcc_[A-Za-z0-9_-]{43})$/.exec(auth)
    d = m ? dossiers[m[1]] : null
    if (!d) return error(res, 401, 'UNAUTHORIZED', 'Jeton de dossier invalide')
  }
  // hooks de test
  let hook = /^\/__test\/(pay|password)\/([^/]+)$/.exec(path)
  if (hook && req.method === 'POST') {
    const t = byPublic[hook[2]]; if (!t) return error(res, 404, 'NOT_FOUND', 'publicToken inconnu')
    if (hook[1] === 'pay') { t.paid = true; t.paidAt = new Date().toISOString() } else { if (!t.paid) return error(res, 402, 'PAYMENT_REQUIRED', 'pending'); t.password = true }
    return json(res, 200, { ok: true })
  }
  if (path === '/__test/fail-salesforce-once' && req.method === 'POST') { failSalesforceOnce = true; return json(res, 200, { ok: true }) }
  if (path === '/__test/fail-quote-once' && req.method === 'POST') { failQuoteOnce = true; return json(res, 200, { ok: true }) }
  if (path === '/__test/reset' && req.method === 'POST') { for (const k of Object.keys(dossiers)) delete dossiers[k]; for (const k of Object.keys(byPublic)) delete byPublic[k]; lastCreate = null; for (const k of Object.keys(stats)) stats[k] = 0; return json(res, 200, { ok: true }) }
  if (path === '/__test/stats' && req.method === 'GET') return json(res, 200, { ...stats })
  if (path === '/__test/last-create' && req.method === 'GET') return json(res, 200, lastCreate || {})
  // référentiels
  const cache = { 'cache-control': 'public, max-age=3600' }
  if (path === '/reference/juridic-forms') return json(res, 200, JURIDIC_FORMS, cache)
  if (path === '/reference/domiciliation-addresses') return json(res, 200, { items: CENTRES }, cache)
  if (path === '/reference/dossier-schema') return json(res, 200, SCHEMA, cache)
  if (path === '/reference/activities') {
    const q = url.searchParams.get('q'); const limit = url.searchParams.get('limit')
    if (q === null) return json(res, 200, { groups: [{ category: 'Tech', items: ACTIVITES.filter(a => a.category === 'Tech') }, { category: 'Services', items: ACTIVITES.filter(a => a.category === 'Services') }] }, cache)
    if (q.length > 500 || (limit !== null && !/^[1-6]$/.test(limit))) return error(res, 400, 'VALIDATION_ERROR', 'Paramètres invalides', [{ section: null, field: q.length > 500 ? 'q' : 'limit', message: 'invalide' }])
    const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    const items = ACTIVITES.map(a => ({ ...a, score: words.filter(w => a.keywords.some(k => k.includes(w)) || a.label.toLowerCase().includes(w)).length })).filter(a => a.score > 0).sort((a, b) => b.score - a.score).slice(0, Number(limit || 3))
    return json(res, 200, { items })
  }
  if (path === '/quotes' && req.method === 'POST') {
    stats.quotes += 1
    const b = await readJson(req); if (!b) return error(res, 400, 'VALIDATION_ERROR', 'Corps de requête JSON invalide.')
    if (!SUPPORTED_FORMS.includes(b.juridicForm)) return error(res, 422, 'UNSUPPORTED_JURIDIC_FORM', 'Forme juridique non prise en charge', { supported: SUPPORTED_FORMS })
    if (!['domiciliation', 'basic'].includes(b.product)) return error(res, 400, 'VALIDATION_ERROR', 'Produit invalide', [{ section: null, field: 'product', message: 'domiciliation | basic' }])
    if (b.paymentInterval !== undefined && !PAYMENT_INTERVALS.includes(b.paymentInterval)) return error(res, 400, 'VALIDATION_ERROR', 'Paramètres de devis invalides.', [{ section: null, field: 'paymentInterval', message: `Cadence attendue : ${PAYMENT_INTERVALS.join(' | ')}.` }])
    if (failQuoteOnce && b.paymentInterval === '3years') { failQuoteOnce = false; return error(res, 500, 'INTERNAL_ERROR', 'Panne simulée du calcul de devis.') }
    return json(res, 200, buildQuote(b.juridicForm, b.product, b.product === 'domiciliation' ? b.paymentInterval : 'month'))
  }
  if (path === '/dossiers/validate' && req.method === 'POST') {
    const b = await readJson(req); if (!b) return error(res, 400, 'VALIDATION_ERROR', 'Corps de requête JSON invalide.')
    const errors = validateBody(b, { creation: !d, current: d })
    const tmp = d ? JSON.parse(JSON.stringify(d)) : { juridicForm: b.juridicForm, sections: emptySections(), account: b.account || {}, partners: {}, assumptions: [], pieces: {}, paid: false }
    if (!errors.length || d) { mergeSections(tmp.sections, b); if (b.partners?.dougs !== undefined) tmp.partners.dougs = b.partners.dougs; if (b.applyDefaults) applyDefaults(tmp); refreshAssumptions(tmp) }
    const warnings = SUPPORTED_FORMS.includes(tmp.juridicForm) ? applyFormRules(tmp, b.juridicForm) : []
    const c = completeness(tmp)
    return json(res, 200, { valid: errors.length === 0, isComplete: c.isComplete, juridicForm: tmp.juridicForm, errors, missing: c.missing, questionGroups: c.questionGroups, warnings, assumptions: tmp.assumptions })
  }
  if (path === '/dossiers' && req.method === 'POST') {
    lastCreate = { clientIp: req.headers['x-madom-client-ip'] ?? null, mcpKey: req.headers['x-madom-mcp-key'] ?? null }
    const b = await readJson(req); if (!b) return error(res, 400, 'VALIDATION_ERROR', 'Corps de requête JSON invalide.')
    if (b.juridicForm && !SUPPORTED_FORMS.includes(b.juridicForm)) return error(res, 422, 'UNSUPPORTED_JURIDIC_FORM', 'Forme juridique non prise en charge', { supported: SUPPORTED_FORMS })
    const errors = validateBody(b, { creation: true })
    if (errors.length) return error(res, 400, 'VALIDATION_ERROR', 'Données invalides.', errors)
    if (String(b.account.email).trim().toLowerCase() === 'existe@exemple.fr') return error(res, 409, 'EMAIL_EXISTS', 'Un compte existe déjà avec cet email.')
    const token = `mcc_${randomBytes(32).toString('base64url')}`
    const nd = { token, publicToken: randomBytes(16).toString('hex'), juridicForm: b.juridicForm, sections: emptySections(), account: { email: String(b.account.email).trim().toLowerCase(), tel: b.account.tel }, partners: {}, assumptions: [], pieces: {}, paid: false, password: false, submitted: false, paidAt: null, paymentAttempt: false }
    mergeSections(nd.sections, b); if (b.partners?.dougs !== undefined) nd.partners.dougs = b.partners.dougs
    if (b.applyDefaults) applyDefaults(nd)
    const warnings = applyFormRules(nd, null)
    dossiers[token] = nd; byPublic[nd.publicToken] = nd
    return json(res, 201, { token, dossier: serialize(nd, { quote: true, warnings }) })
  }
  if (!d) return path.startsWith('/dossiers/me') ? error(res, 401, 'UNAUTHORIZED', 'Jeton requis') : error(res, 404, 'NOT_FOUND', 'Route inconnue')
  if (path === '/dossiers/me' && req.method === 'GET') { stats.dossierProbes += 1; return json(res, 200, serialize(d)) }
  if (path === '/dossiers/me' && req.method === 'PATCH') {
    if (d.submitted) return error(res, 409, 'DOSSIER_FINALIZED', 'Dossier finalisé : plus de modification possible.')
    const b = await readJson(req); if (!b) return error(res, 400, 'VALIDATION_ERROR', 'Corps de requête JSON invalide.')
    if (b.applyDefaults !== undefined) return error(res, 400, 'VALIDATION_ERROR', 'Données invalides.', [{ section: null, field: 'applyDefaults', message: 'Champ inconnu' }])
    const errors = validateBody(b, { current: d })
    if (errors.length) return error(res, 400, 'VALIDATION_ERROR', 'Données invalides.', errors)
    if (b.account?.email && String(b.account.email).toLowerCase() === 'existe@exemple.fr') return error(res, 409, 'EMAIL_EXISTS', 'Un compte existe déjà avec cet email.')
    if (b.juridicForm && !SUPPORTED_FORMS.includes(b.juridicForm)) return error(res, 422, 'UNSUPPORTED_JURIDIC_FORM', 'Forme juridique non prise en charge', { supported: SUPPORTED_FORMS })
    mergeSections(d.sections, b)
    if (b.account) d.account = { ...d.account, ...b.account }
    if (b.partners?.dougs !== undefined) d.partners.dougs = b.partners.dougs
    // Un champ renseigné explicitement (même à la valeur par défaut) n'est plus une hypothèse.
    d.assumptions = d.assumptions.filter(a => b[a.section]?.[a.field] === undefined)
    refreshAssumptions(d)
    const warnings = applyFormRules(d, b.juridicForm || null)
    return json(res, 200, serialize(d, { warnings }))
  }
  if (path === '/dossiers/me/payment' && req.method === 'GET') {
    stats.paymentProbes += 1
    return json(res, 200, { status: d.paid ? 'paid' : (d.paymentAttempt ? 'pending' : 'unpaid'), paymentUrl: links(d).paymentPage, quote: quoteOf(d, product(d)), paidAt: d.paidAt })
  }
  const up = /^\/dossiers\/me\/documents\/([^/]+)$/.exec(path)
  if (up && req.method === 'POST') {
    if (!d.paid) return error(res, 402, 'PAYMENT_REQUIRED', 'Dossier non payé')
    const key = decodeURIComponent(up[1])
    const items = documentsItems(d); const item = items.find(i => i.key === key && i.status !== 'auto')
    if (!item) return error(res, 400, 'KEY_NOT_REQUESTED', 'Pièce non demandée pour ce dossier', { requested: items.filter(i => i.status !== 'auto').map(i => i.key) })
    if (item.verification?.status === 'validated') return error(res, 409, 'NETHEOS_PIECE_VALIDATED', 'Pièce déjà validée')
    let form
    try { form = await new Response(req, { headers: req.headers }).formData() } catch { return error(res, 400, 'VALIDATION_ERROR', 'Multipart invalide', [{ section: null, field: 'file', message: 'Fichier requis' }]) }
    const file = form.get('file'); const type = form.get('documentType')
    if (!file || typeof file === 'string') return error(res, 400, 'VALIDATION_ERROR', 'Fichier requis', [{ section: null, field: 'file', message: 'Fichier requis' }])
    const buf = Buffer.from(await file.arrayBuffer())
    const ext = buf.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : buf[0] === 0x89 ? 'png' : (buf[0] === 0xff && buf[1] === 0xd8) ? 'jpeg' : 'inconnu'
    if (!item.formats.includes(ext)) return error(res, 400, 'INVALID_FORMAT', 'Format de fichier refusé', { formats: item.formats })
    if (item.documentType && !type) return error(res, 422, 'DOCUMENT_TYPE_REQUIRED', 'Type de document requis', { options: item.documentType.options })
    if (item.documentType && type && !item.documentType.options.some(o => (typeof o === 'string' ? o : o.value) === type)) return error(res, 422, 'INVALID_DOCUMENT_TYPE', 'Type de document inconnu', { options: item.documentType.options })
    if (!item.documentType && type) return error(res, 400, 'DOCUMENT_TYPE_NOT_APPLICABLE', 'Cette pièce ne prend pas de type de document')
    d.pieces[key] = { type: type || null, ext, size: buf.length, name: file.name }
    let submission = null
    if (product(d) === 'domiciliation') {
      if (key === 'owner_id_justif_file') { submission = type === 'PASSPORT' ? { result: 'success' } : { result: 'awaiting_pair' }; d.pieces[key].verif = { status: type === 'PASSPORT' ? 'pending' : 'awaiting_pair' } }
      if (key === 'owner_id_justif_file_2') { submission = { result: 'success' }; d.pieces[key].verif = { status: 'pending' }; if (d.pieces.owner_id_justif_file) d.pieces.owner_id_justif_file.verif = { status: 'pending' } }
      if (key === 'owner_address_justif_file') { submission = { result: 'success' }; d.pieces[key].verif = { status: 'validated' } }
    }
    return json(res, 200, { ...serialize(d), submission })
  }
  if (path === '/dossiers/me/capital-deposit' && req.method === 'POST') {
    if (!d.paid) return error(res, 402, 'PAYMENT_REQUIRED', 'Dossier non payé')
    const b = await readJson(req)
    if (!b || !['qonto', 'banque'].includes(b.choice)) return error(res, 400, 'VALIDATION_ERROR', 'Choix invalide', [{ section: null, field: 'choice', message: 'qonto | banque' }])
    const items = documentsItems(d); const missing = items.filter(i => i.required && i.status === 'missing')
    if (missing.length) return error(res, 422, 'DOCUMENTS_MISSING', 'Des pièces sont manquantes', { missing: missing.map(i => ({ key: i.key, label: i.label, required: true, status: 'missing' })) })
    const pending = items.filter(i => i.verification && !['validated', 'pending'].includes(i.verification.status))
    if (pending.length) return error(res, 422, 'NETHEOS_PIECES_PENDING', 'Pièces non validées par Netheos', { domiciliation: serialize(d).domiciliation })
    if (!d.submitted) { d.submitted = true; d.capitalChoice = b.choice; d.sections.capitalDeposit.choice = b.choice }
    if (failSalesforceOnce) { failSalesforceOnce = false; return error(res, 502, 'SALESFORCE_SYNC_FAILED', 'Synchronisation Salesforce échouée') }
    return json(res, 200, serialize(d))
  }
  return error(res, 404, 'NOT_FOUND', 'Route inconnue')
}

const startFakeApi = ({ port = 0, host = '127.0.0.1' } = {}) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => handle(req, res).catch(err => error(res, 500, 'INTERNAL_ERROR', err.message)))
  server.on('error', reject)
  server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}`, close: () => new Promise(r => server.close(r)) }))
})

export { startFakeApi, buildQuote, SCHEMA, CENTRES }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, '/'))) {
  const { url } = await startFakeApi({ port: Number(process.argv[2] || 0) })
  console.error(`[fake-api] ${url}`)
  process.stdout.write(`${url}\n`)
}
