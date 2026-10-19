// Outils référentiels et devis : lister_centres, rechercher_activites, schema_dossier, devis_creation.
// Tout vient de l'API (/reference/*, /quotes) ; aucun catalogue ni montant local.

import { z } from 'zod'

import { get, post, getJuridicForms, getDossierSchema } from './api.js'
import { run, LocalError, LECTURE } from './run.js'
import { summarizeQuote } from './summary.js'

const listCentres = async () => {
  const { items = [] } = await get('/reference/domiciliation-addresses')
  return {
    items: items.map(c => ({ id: c.id, name: c.name, address: c.address, cp: c.cp, city: c.city })),
    note: 'Le prix ne dépend pas du centre : utiliser devis_creation (juridicForm, product, paymentInterval) pour l\'annoncer. ' +
      'Passer l\'id choisi dans siege.domiciliationAddressId (creer_societe) ou preferences.addressId (profil).',
  }
}

const rechercherActivites = async ({ q, limit }) => {
  const { items = [] } = await get('/reference/activities', { query: { q, limit } })
  const out = { q, items }
  if (!items.length) {
    out.note = 'Aucune activité du catalogue ne correspond : proposer une activité libre dans objet.activities ' +
      '({ redaction: "<phrase décrivant l\'activité>", custom: true, reglementee: false | true }) — reformuler la recherche avec des mots plus génériques peut aussi aider.'
  } else {
    out.note = 'Reprendre `redaction` telle quelle dans objet.activities ({ redaction, custom: false, reglementee }) ; `reglementee` / `justificatif` indiquent une pièce à prévoir.'
  }
  return out
}

const findSection = (schema, key) => {
  const sections = schema.sections || []
  const itemSections = schema.itemSections || []
  return sections.find(s => s.key === key) || itemSections.find(s => s.key === key) || null
}

const schemaDossier = async ({ section }) => {
  const [schema, forms] = await Promise.all([getDossierSchema(), getJuridicForms()])
  const { sections = [], itemSections = [], ...meta } = schema
  if (section) {
    const found = findSection(schema, section)
    if (!found) {
      const known = [...sections.map(s => s.key), ...itemSections.map(s => s.key)]
      throw new LocalError(`Section inconnue « ${section} ». Sections : ${known.join(', ')}.`)
    }
    return { ...meta, section: found }
  }
  return {
    ...meta,
    sections,
    itemSections,
    juridicFormsDetail: forms.items || forms,
    note: 'Catalogue des champs (types, options, conditions requiredWhen / visibleWhen, readOnly). ' +
      'Les régimes fiscaux et mois de clôture par forme sont dans juridicFormsDetail. ' +
      'Le descripteur partners.dougs donne le libellé et l\'explication à utiliser pour la question Dougs (une fois, après le récapitulatif).',
  }
}

const PAYMENT_INTERVALS = ['month', 'year', '2years', '3years']

// Devis d'une domiciliation pour les quatre cadences, en parallèle : le devis demandé en fait partie
// (aucun appel séparé) et le comparatif `cadences` détaille les remises sur la première échéance.
// Résultats bruts indexés par cadence : { month: { status, value | reason }, year: …, … }.
const devisParCadence = async juridicForm => {
  const settled = await Promise.allSettled(PAYMENT_INTERVALS.map(paymentInterval => post('/quotes', { juridicForm, product: 'domiciliation', paymentInterval })))
  return Object.fromEntries(PAYMENT_INTERVALS.map((cadence, i) => [cadence, settled[i]]))
}

const resumeCadence = quote => {
  const q = summarizeQuote(quote)
  return {
    cadence: q.cadence, engagementAnnees: q.recurrence?.engagementAnnees ?? null, aujourdHuiTtc: q.aujourdHui.ttc,
    echeanceHt: q.recurrence?.montantHt ?? null, mensuelHt: q.recurrence?.mensuelHt ?? null,
    moisOfferts: q.recurrence?.moisOfferts ?? 0, remisePremiereEcheancePourcent: q.recurrence?.remisePremiereEcheancePourcent ?? 0,
    resume: q.resume,
  }
}

const devisCreation = async ({ juridicForm, product, paymentInterval }) => {
  if (product === 'basic') {
    const quote = await post('/quotes', { juridicForm, product })
    return { ...summarizeQuote(quote), quote }
  }
  // Domiciliation : cadence demandée (month par défaut, comme l'API) prise parmi les quatre devis ; une
  // panne sur une autre cadence ne fait pas échouer le devis demandé, le comparatif est alors omis et signalé.
  const demandee = paymentInterval || 'month'
  const resultats = await devisParCadence(juridicForm)
  if (resultats[demandee].status === 'rejected') throw resultats[demandee].reason
  const quote = resultats[demandee].value
  const complet = PAYMENT_INTERVALS.every(c => resultats[c].status === 'fulfilled')
  const out = { ...summarizeQuote(quote), ...(complet ? { cadences: PAYMENT_INTERVALS.map(c => resumeCadence(resultats[c].value)) } : {}), quote }
  if (!complet) out.note = 'Comparatif des cadences indisponible pour le moment : annoncer le devis demandé seulement et proposer les autres cadences sur le site.'
  return out
}

const registerReferenceTools = server => {
  server.registerTool('lister_centres', {
    annotations: LECTURE,
    title: 'Centres de domiciliation disponibles',
    description: 'Liste les centres de domiciliation (id, nom, adresse) acceptant une création de société. ' +
      'Le prix est le même pour tous : l\'annoncer avec devis_creation.',
    inputSchema: {},
  }, run(listCentres))

  server.registerTool('rechercher_activites', {
    annotations: LECTURE,
    title: 'Rechercher une activité dans le catalogue',
    description: 'Recherche les rédactions d\'activité du catalogue ma-domiciliation.fr à partir d\'une description libre ' +
      '(ex. « développement d\'une application mobile »). Renvoie des items { label, redaction, nature, reglementee, justificatif, category, score }. ' +
      'Sans résultat, proposer une activité libre (custom: true).',
    inputSchema: {
      q: z.string().min(1).max(500).describe('Description de l\'activité en langage naturel'),
      limit: z.number().int().min(1).max(6).optional().describe('Nombre de résultats (défaut 3)'),
    },
  }, run(rechercherActivites))

  server.registerTool('schema_dossier', {
    annotations: LECTURE,
    title: 'Schéma du dossier de création',
    description: 'Catalogue complet des champs du dossier (sections siege, dirigeant, associes, societe, objet, fiscalite, capital, capitalDeposit, ' +
      'plus account et partners) avec types, options, conditions et exemples, et le détail des formes juridiques (régimes fiscaux, TVA, clôture). ' +
      'À consulter pour formuler une question (ex. partners.dougs) ou vérifier une valeur avant modifier_dossier. ' +
      'Paramètre section pour n\'obtenir qu\'une section.',
    inputSchema: {
      section: z.string().optional().describe('Clé de section (ex. dirigeant, partners, associes) ; vide = tout le schéma'),
    },
  }, run(schemaDossier))

  server.registerTool('devis_creation', {
    annotations: LECTURE,
    title: 'Devis de création de société',
    description: 'Calcule le devis réel (montants Stripe du site) pour une forme juridique et un produit : ' +
      '`domiciliation` (siège chez ma-domiciliation : mensuel, annuel ou engagement 2 / 3 ans) ou `basic` (création seule : frais légaux seuls, paiement unique). ' +
      'L\'accompagnement à la création est offert : seuls les frais légaux sont facturés le jour du paiement. Renvoie les lignes, le montant dû aujourd\'hui, la récurrence (mois offerts, remise sur la première échéance selon la cadence), un résumé prêt à annoncer ' +
      'et, pour une domiciliation, `cadences` : le comparatif des quatre cadences (montant de l\'échéance et remise sur la première échéance pour mensuel, annuel, 2 ans, 3 ans), à détailler au client quand le prix est annoncé. ' +
      'Ne pas annoncer le prix dans les premiers échanges, avant que le projet soit cerné. Aucun montant ni pourcentage n\'est connu localement : toujours passer par cet outil.',
    inputSchema: {
      juridicForm: z.string().describe('SASU, SAS, SARL, EURL ou SCI'),
      product: z.enum(['domiciliation', 'basic']),
      paymentInterval: z.enum(['month', 'year', '2years', '3years']).optional().describe('Cadence de la domiciliation : month (mensuel), year (1 an), 2years ou 3years (engagement 2 ou 3 ans, remise sur la première échéance d\'après le devis) ; défaut month ; ignoré pour basic'),
    },
  }, run(devisCreation))
}

export { registerReferenceTools, listCentres, rechercherActivites, schemaDossier, devisCreation }
