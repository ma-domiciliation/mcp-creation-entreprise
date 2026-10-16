// Résumés compacts des réponses de l'API pour les outils (formatage seulement, aucun montant ni
// règle métier locale). Un dossier brut pèse ~25 ko ; le résumé vise < 6 ko.

const formatEuros = cents => {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return null
  const euros = (Number(cents) / 100).toFixed(2).replace('.', ',')
  return `${euros.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`
}

const INTERVAL_LABELS = { month: 'mois', year: 'an' }

// Engagement en années d'une récurrence annuelle : intervalCount du devis (1, 2 ou 3), sinon d'après la
// cadence demandée (year → 1, 2years → 2, 3years → 3), 1 à défaut ; null pour une récurrence mensuelle.
const anneesDeCadence = paymentInterval => {
  const m = /^(\d)years$/.exec(String(paymentInterval || ''))
  if (m) return Number(m[1])
  return paymentInterval === 'year' ? 1 : null
}
const engagementAnnees = (rec, paymentInterval) => {
  if (rec?.interval !== 'year') return null
  const count = Number(rec.intervalCount)
  if (count > 0) return count
  return anneesDeCadence(paymentInterval) || 1
}

// Libellé de la période facturée : mois, an, 2 ans, 3 ans.
const periodeLabel = (rec, paymentInterval) => {
  const annees = engagementAnnees(rec, paymentInterval)
  if (annees && annees > 1) return `${annees} ans`
  return INTERVAL_LABELS[rec.interval] || rec.interval
}

const summarizeQuote = quote => {
  if (!quote) return null
  const lignes = (quote.lines || []).map(l => ({
    key: l.key, label: l.label, ht: formatEuros(l.ht), ttc: formatEuros(l.ttc), ...(l.recurring ? { recurring: true } : {}),
  }))
  const today = quote.dueToday || {}
  const rec = quote.recurring
  const recurrence = rec ? {
    interval: rec.interval,
    engagementAnnees: engagementAnnees(rec, quote.paymentInterval),
    montantHt: formatEuros(rec.amountHt),
    mensuelHt: formatEuros(rec.monthlyHt),
    moisOfferts: rec.trialMonths || 0,
    remisePremiereEcheancePourcent: rec.firstBillingDiscountPercent || 0,
  } : null
  let resume = `Aujourd'hui ${formatEuros(today.ttc)} TTC (${formatEuros(today.ht)} HT)`
  if (rec) {
    const extras = []
    if (rec.trialMonths) extras.push(`${rec.trialMonths} mois offert${rec.trialMonths > 1 ? 's' : ''}`)
    if (rec.firstBillingDiscountPercent) extras.push(`−${rec.firstBillingDiscountPercent} % sur la première échéance`)
    resume += `, puis ${formatEuros(rec.amountHt)} HT/${periodeLabel(rec, quote.paymentInterval)}${extras.length ? ` (${extras.join(', ')})` : ''}`
  }
  return {
    produit: quote.product, cadence: quote.paymentInterval, lignes,
    aujourdHui: { ht: formatEuros(today.ht), tva: formatEuros(today.vat), ttc: formatEuros(today.ttc) }, recurrence, resume,
  }
}

const compactOptions = options => (Array.isArray(options)
  ? options.map(o => (typeof o === 'string' ? o : (o.title && o.title !== o.value ? `${o.value} (${o.title})` : o.value)))
  : undefined)

// Descripteur de champ manquant, sans le fragment `elicitation` (réservé à elicitation.js).
const summarizeDescriptor = d => {
  const out = { section: d.section, field: d.field, label: d.label, type: d.type, askTo: d.askTo }
  const description = d.elicitation?.description || d.hint
  if (description) out.description = description
  if (d.example !== undefined) out.example = d.example
  const options = compactOptions(d.options)
  if (options) out.options = options
  if (d.blocks) out.blocks = d.blocks
  return out
}

const summarizeMissing = missing => (Array.isArray(missing) ? missing.map(summarizeDescriptor) : [])

const summarizeGroups = groups => (Array.isArray(groups) ? groups.map(g => ({
  key: g.key, title: g.title, askTo: g.askTo,
  champs: (g.fields || []).map(f => (typeof f === 'string' ? f : `${f.section}${f.field ? `.${f.field}` : ''} — ${f.label}`)),
})) : [])

const summarizeCompleteness = c => (c ? {
  isComplete: c.isComplete === true,
  incompleteSteps: (c.incompleteSteps || []).map(s => (typeof s === 'string' ? s : s.label || s.key)),
  missing: summarizeMissing(c.missing),
  questionGroups: summarizeGroups(c.questionGroups),
  errors: c.errors || [],
} : null)

// Une valeur longue (ex. objet social généré) est tronquée : le texte complet est dans sections (detail=complet).
const shorten = (value, max = 160) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max).replace(/\s+\S*$/, '')}… (texte complet dans sections)` : value)

const summarizeAssumptions = assumptions => (Array.isArray(assumptions) ? assumptions.map(a => ({
  section: a.section, field: a.field, label: a.label, valeur: shorten(a.valueLabel ?? a.value),
})) : [])

const WARNING_LABELS = {
  JURIDIC_FORM_SWITCHED: w => `Forme juridique basculée de ${w.from} vers ${w.to} d'après le nombre d'associés (modifier_dossier avec juridicForm pour revenir).`,
  JURIDIC_FORM_FIELDS_RESET: w => `Champs effacés car invalides pour ${w.juridicForm} : ${(w.fields || []).join(', ')} (à redonner).`,
  JURIDIC_FORM_CHANGED_AFTER_PAYMENT: () => 'Forme juridique changée après paiement : les frais légaux ont été facturés au tarif de la forme payée.',
  CONTRIBUTION_IGNORED: w => `Apport ignoré : porté par une personne non associée${w.field ? ` (${w.field})` : ''}.`,
  // Un seul dossier non payé par email : l'API remplace le précédent (contrat § 6.1 et § 11.6).
  PENDING_SUPERSEDED: w => `Un dossier précédent${w.previous?.socialDenomination ? ` (« ${w.previous.socialDenomination} »)` : ''} portant le même email a été remplacé par celui-ci : ` +
    'son code de reprise et son lien de paiement ne fonctionnent plus. À dire au client' +
    (w.previous?.paymentStarted ? ', qui avait déjà commencé à payer : ne pas terminer le paiement sur l\'ancienne page.' : '.'),
}

const summarizeWarnings = warnings => (Array.isArray(warnings) ? warnings.map(w => {
  if (typeof w === 'string') return { code: w }
  const render = WARNING_LABELS[w.code]
  return { ...w, message: render ? render(w) : w.message }
}) : [])

// documents.items → items compacts ; `localFileFor(key)` (optionnel) ajoute la pièce KYC locale disponible.
const summarizeDocuments = (documents, { localFileFor } = {}) => {
  if (!documents) return null
  return {
    isComplete: documents.isComplete === true,
    items: (documents.items || []).map(item => {
      const out = { key: item.key, label: item.label, required: item.required === true, status: item.status, formats: item.formats }
      if (item.hint) out.hint = item.hint
      if (item.documentType) {
        out.documentType = typeof item.documentType === 'object'
          ? { value: item.documentType.value ?? null, options: compactOptions(item.documentType.options) }
          : item.documentType
      }
      if (item.verification) out.verification = item.verification
      const local = localFileFor ? localFileFor(item.key) : null
      if (local) out.fichierLocal = local
      return out
    }),
  }
}

// summarizeDossier(d, { sections, localFileFor })
const summarizeDossier = (d, { sections = false, localFileFor } = {}) => {
  if (!d) return null
  const out = {
    phase: d.phase, status: d.status, juridicForm: d.juridicForm, product: d.product, paymentInterval: d.paymentInterval,
  }
  const warnings = summarizeWarnings(d.warnings)
  if (warnings.length) out.warnings = warnings
  out.completeness = summarizeCompleteness(d.completeness)
  const assumptions = summarizeAssumptions(d.assumptions)
  if (assumptions.length) out.assumptions = assumptions
  // En phase pending, documents.items est une liste provisoire (sans Netheos) : la vraie liste vient après paiement.
  if (d.phase !== 'pending' && d.documents) out.documents = summarizeDocuments(d.documents, { localFileFor })
  if (d.payment) {
    out.payment = { status: d.payment.status, paidAt: d.payment.paidAt ?? null }
    const quote = summarizeQuote(d.payment.quote)
    if (quote) out.payment.quote = quote
  }
  if (d.account) out.account = { email: d.account.email, tel: d.account.tel, hasPassword: d.account.hasPassword === true }
  if (d.domiciliation) out.domiciliation = d.domiciliation
  if (d.qonto?.redirectionLink) out.qonto = { redirectionLink: d.qonto.redirectionLink, status: d.qonto.status ?? null }
  if (d.links) out.links = d.links
  out.nextActions = d.nextActions || []
  if (sections) out.sections = d.sections
  return out
}

// Réponse standard d'un outil « dossier » : identité de la société + résumé.
const dossierResponse = (entry, dossier, options) => ({
  societe: { socialDenomination: dossier?.sections?.societe?.socialDenomination ?? entry?.socialDenomination ?? null, publicToken: entry?.publicToken ?? null },
  ...summarizeDossier(dossier, options),
})

export {
  formatEuros, summarizeQuote, summarizeDescriptor, summarizeMissing, summarizeGroups, summarizeCompleteness,
  summarizeAssumptions, summarizeWarnings, summarizeDocuments, summarizeDossier, dossierResponse, WARNING_LABELS,
}
