// Outils dossier : valider_dossier, creer_societe, completer_dossier, statut_dossier, modifier_dossier.

import { z } from 'zod'

import { post, isApiError } from './api.js'
import { run, LocalError } from './run.js'
import { formatApiError } from './errors.js'
import { buildCreateBody } from './prefill.js'
import { summarizeMissing, summarizeGroups, summarizeWarnings, summarizeAssumptions, summarizeQuote, dossierResponse } from './summary.js'
import { validateDossier, refreshDossier, updateDossier, waitForStatus } from './dossiers.js'
import { elicitationSupport, askGroups, questionsAPoser } from './elicitation.js'
import { upsertSociete, entryFromDossier, findSocietes, isTerminal, listing } from '../app/registry.js'
import { kycFileForJustifKey } from '../app/kyc.js'

const WAIT_LABELS = { paiement: 'le paiement', mot_de_passe: 'le choix du mot de passe' }

// Pièce KYC locale disponible pour une clé de document (affichée dans documents.items).
const localFileFor = key => {
  const local = kycFileForJustifKey(key)
  return local ? `${local.kind} (${local.ext}${local.documentType ? `, ${local.documentType}` : ''})` : null
}

const compactValidation = result => ({
  valid: result.valid === true,
  isComplete: result.isComplete === true,
  juridicForm: result.juridicForm,
  errors: result.errors || [],
  missing: summarizeMissing(result.missing),
  questionGroups: summarizeGroups(result.questionGroups),
  warnings: summarizeWarnings(result.warnings),
  assumptions: summarizeAssumptions(result.assumptions),
})

const validerDossier = async (store, args) => {
  const { dossier = {}, utiliserProfil = true, applyDefaults = true } = args
  if (store.hasRef(args)) {
    const entry = store.resolve(args)
    const { applyDefaults: _a, ...body } = dossier
    const result = await validateDossier(store, entry, { ...body, applyDefaults })
    return { mode: 'dossier existant', societe: { socialDenomination: entry.socialDenomination, publicToken: entry.publicToken }, ...compactValidation(result) }
  }
  const body = buildCreateBody(store.profile(), dossier, { utiliserProfil, applyDefaults })
  if (!body.juridicForm) throw new LocalError('juridicForm requis pour valider un nouveau dossier (SASU, SAS, SARL, EURL, SCI), ou preferences.juridicForm dans le profil.')
  const result = await post('/dossiers/validate', body)
  return { mode: 'nouveau dossier (dry-run de creer_societe)', corpsEnvoye: body, ...compactValidation(result) }
}

const suggestAlias = email => {
  const [local, domain] = String(email || '').split('@')
  if (!domain) return null
  const [base, tag] = local.split('+')
  return `${base}+${tag ? `${tag}-bis` : 'bis'}@${domain}`
}

const openDossiers = denomination => findSocietes(denomination).filter(s => !isTerminal(s) && s.status !== 'jeton_invalide')

const CONSIGNE_JETON = 'Conserver ce jeton : il identifie ce dossier dans le paramètre `jeton` de tous les outils (statut_dossier, modifier_dossier, ouvrir_paiement…). ' +
  'Le donner une seule fois au client comme code de reprise (pour continuer dans une autre conversation), dans un message final et jamais entre deux appels d\'outils ; ' +
  'ne jamais le publier ni le mettre dans un message partagé.'

const creerSociete = async (server, store, { dossier = {}, utiliserProfil = true, applyDefaults = true, confirmerDoublon = false }) => {
  const local = store.mode === 'local'
  const denomination = dossier.societe?.socialDenomination
  if (!denomination) throw new LocalError('dossier.societe.socialDenomination requis (nom de la société).')
  const existing = local ? openDossiers(denomination) : []
  if (existing.length && !confirmerDoublon) {
    return {
      doublon: true, cree: false,
      dossiersExistants: listing(existing),
      consigne: 'Un dossier en cours porte déjà ce nom sur ce poste : continuer avec statut_dossier / completer_dossier (paramètre societe), ' +
        'ou rappeler creer_societe avec confirmerDoublon: true pour en ouvrir un second.',
    }
  }
  const body = buildCreateBody(store.profile(), dossier, { utiliserProfil, applyDefaults })
  if (!body.juridicForm) throw new LocalError(`juridicForm requis (SASU, SAS, SARL, EURL, SCI)${local ? ', ou preferences.juridicForm dans le profil' : ''}.`)
  if (!local) {
    const gate = store.limiter.peek('creations', store.clientIp)
    if (!gate.allowed) throw new LocalError(`Trop de dossiers créés depuis cette adresse : réessayer dans ${Math.ceil((gate.retryAfter || 60) / 60)} min.`, { error: 'RATE_LIMITED_LOCAL', retryAfter: gate.retryAfter })
  }
  let created
  try {
    created = await post('/dossiers', body, { clientIp: store.clientIp })
  } catch (err) {
    if (isApiError(err) && err.error === 'EMAIL_EXISTS') {
      const alias = suggestAlias(body.account?.email)
      err.message = `${err.message} Email envoyé : ${body.account?.email || '?'}${alias ? ` — proposer par exemple ${alias} via dossier.account.email.` : ''}`
    }
    throw err
  }
  const { token, dossier: d } = created
  const entry = entryFromDossier(token, d)
  const out = { cree: true }
  if (local) {
    out.registre = 'ok'
    try {
      upsertSociete(entry)
    } catch (err) {
      out.registre = `ÉCHEC d'écriture du registre local (${err.message}) : le jeton de ce dossier est perdu pour le MCP. ` +
        'Le client termine ce dossier sur le site via links.paymentPage, ou on recommence avec creer_societe après avoir corrigé MADOM_REGISTRY_PATH.'
    }
  } else {
    store.limiter.hit('creations', store.clientIp)
    out.jeton = token
    out.consigne = CONSIGNE_JETON
  }
  Object.assign(out, dossierResponse(entry, d))
  if (d.payment?.quote === null) out.devis = 'indisponible pour l\'instant (relancer devis_creation ou ouvrir_paiement plus tard)'
  const groups = d.completeness?.questionGroups || []
  if (!d.completeness?.isComplete && groups.length) {
    if (local && elicitationSupport(server).form) {
      out.suite = 'completer_dossier (formulaires d\'elicitation pour les questions restantes)'
    } else {
      out.questionsAPoser = questionsAPoser(groups)
      out.suite = 'Poser ces questions au client dans la conversation, puis modifier_dossier (section par section ; listes complètes).'
    }
  } else {
    out.suite = 'statut_dossier detail=complet pour le récapitulatif, question Dougs (modifier_dossier partners.dougs), accord explicite, puis ouvrir_paiement.'
  }
  return out
}

const completerDossier = async (server, store, args) => {
  const { groupes, max = 8 } = args
  const entry = store.resolve(args)
  const dossier = await refreshDossier(store, entry)
  if (dossier.completeness?.isComplete) {
    return { dejaComplet: true, ...dossierResponse(entry, dossier), suite: 'statut_dossier detail=complet pour le récapitulatif, question Dougs, accord explicite, ouvrir_paiement.' }
  }
  if (!elicitationSupport(server).form) {
    const groups = (dossier.completeness?.questionGroups || []).filter(g => !groupes?.length || groupes.includes(g.key))
    return {
      questionsPosees: [], stoppedBy: 'unsupported',
      questionsAPoser: questionsAPoser(groups),
      suite: 'Ce client MCP ne supporte pas les formulaires : poser ces questions dans la conversation puis envoyer les réponses avec modifier_dossier (section par section, listes complètes).',
      ...dossierResponse(entry, dossier),
    }
  }
  const result = await askGroups(server, dossier, patch => updateDossier(store, entry, patch), { max, only: groupes })
  const out = { questionsPosees: result.questionsPosees, groupesRestants: result.groupesRestants }
  if (result.stoppedBy) {
    out.stoppedBy = result.stoppedBy
    if (result.erreur) out.erreur = isApiError(result.erreur) ? formatApiError(result.erreur) : String(result.erreur)
  }
  const final = result.dossier
  const remaining = final.completeness?.questionGroups || []
  if (final.completeness?.isComplete) {
    out.suite = 'Dossier complet : statut_dossier detail=complet pour le récapitulatif, question Dougs, accord explicite, ouvrir_paiement.'
  } else if (result.stoppedBy === 'validation') {
    out.suite = 'L\'API a refusé une réponse : corriger avec modifier_dossier puis relancer completer_dossier.'
  } else if (result.stoppedBy === 'decline' || result.stoppedBy === 'cancel') {
    out.suite = 'Le client a interrompu le formulaire : poser les questions restantes dans la conversation puis modifier_dossier, ou relancer completer_dossier.'
    out.questionsAPoser = questionsAPoser(remaining)
  } else if (result.stoppedBy === 'error') {
    out.questionsAPoser = questionsAPoser(remaining)
    out.suite = 'Formulaire indisponible : poser les questions dans la conversation puis modifier_dossier.'
  } else if (remaining.length) {
    out.suite = `Relancer completer_dossier pour les ${remaining.length} groupe(s) restant(s).`
  }
  return { ...out, ...dossierResponse(entry, final) }
}

const statutDossier = async (store, args) => {
  const local = store.mode === 'local'
  const { detail = 'resume', attendre, delaiMaxSecondes = local ? 120 : 60 } = args
  const entry = store.resolve(args)
  let attente
  if (attendre) {
    const result = await waitForStatus(store, entry, { until: attendre, maxSeconds: delaiMaxSecondes })
    attente = { cible: attendre, atteint: result.atteint, dureeSecondes: result.dureeSecondes }
    if (!result.atteint) {
      attente.consigne = `${WAIT_LABELS[attendre] || attendre} n'est pas encore constaté après ${result.dureeSecondes} s : terminer la réponse en demandant au client s'il a terminé sur la page du site ` +
        `(${attendre === 'paiement' ? 'links.paymentPage' : 'links.passwordPage'}), sans relancer en boucle ; relancer statut_dossier attendre=${attendre} au tour suivant, quand il le confirme.`
    }
  }
  const dossier = await refreshDossier(store, entry)
  const out = { ...(attente ? { attente } : {}), ...dossierResponse(entry, dossier, { sections: detail === 'complet', localFileFor: local ? localFileFor : undefined }) }
  if (attente?.atteint && attendre === 'paiement') {
    out.suite = local
      ? 'Paiement constaté : ouvrir_mot_de_passe, puis statut_dossier attendre=mot_de_passe.'
      : 'Paiement constaté. Le client termine sur le site : choix du mot de passe (links.passwordPage, où il est redirigé après le paiement), ' +
        'puis justificatifs, dépôt de capital, questionnaire et signature dans son espace client (links.customerArea). Donner ces liens dans un message final. L\'assistant n\'envoie aucune pièce.'
  }
  if (attente?.atteint && attendre === 'mot_de_passe') out.suite = 'Mot de passe défini : relire documents.items puis envoyer_piece pour chaque pièce demandée, puis deposer_capital.'
  return out
}

const modifierDossier = async (store, args) => {
  const { modifications = {} } = args
  const { applyDefaults: _never, ...body } = modifications
  if (!Object.keys(body).length) throw new LocalError('modifications vide : indiquer au moins une section (ex. { societe: { sigle: "ABC" } }).')
  const entry = store.resolve(args)
  const dossier = await updateDossier(store, entry, body)
  const out = dossierResponse(entry, dossier, { localFileFor: store.mode === 'local' ? localFileFor : undefined })
  if (dossier.completeness?.isComplete) out.suite = 'Dossier complet : récapitulatif (statut_dossier detail=complet), question Dougs si pas encore posée, accord explicite, ouvrir_paiement.'
  else if (dossier.phase === 'pending') {
    out.suite = store.mode === 'local'
      ? 'Des questions restent : completer_dossier (ou poser les questions de completeness.questionGroups puis modifier_dossier).'
      : 'Des questions restent : les poser au client dans la conversation (questionsAPoser) puis modifier_dossier.'
    if (store.mode !== 'local') out.questionsAPoser = questionsAPoser(dossier.completeness?.questionGroups || [])
  }
  return out
}

const registerDossierTools = (server, store) => {
  const local = store.mode === 'local'
  const ref = local ? '`societe`' : '`jeton`'
  server.registerTool('valider_dossier', {
    title: 'Valider un dossier sans l\'enregistrer (dry-run)',
    description: `Vérifie auprès de l'API, sans rien écrire, les formats et la complétude d'un dossier. Sans ${ref} : dry-run exact de creer_societe ` +
      `(${local ? 'profil + ' : ''}dossier fourni, applyDefaults) → corpsEnvoye, errors, missing, questionGroups, assumptions. Avec ${ref} : les modifications sont fusionnées au dossier existant.`,
    inputSchema: {
      dossier: z.record(z.any()).describe('Sections du dossier (juridicForm, account, siege, dirigeant, associes, societe, objet, fiscalite, capital) ; voir schema_dossier'),
      ...store.optionalDossierParam,
      ...(local ? { utiliserProfil: z.boolean().optional().describe('Compléter avec le profil fondateur (défaut true ; sans societe seulement)') } : {}),
      applyDefaults: z.boolean().optional().describe('Laisser l\'API poser les réponses les plus courantes (défaut true)'),
    },
  }, run(args => validerDossier(store, args)))

  server.registerTool('creer_societe', {
    title: 'Ouvrir le dossier de création sur ma-domiciliation.fr',
    description: (local
      ? 'Crée le dossier (POST /dossiers) dès que forme, dénomination, email, téléphone et siège sont connus, complété par le profil fondateur ' +
        'et par les réponses les plus courantes (applyDefaults → assumptions, à annoncer au client). Le jeton du dossier est conservé localement et jamais affiché. ' +
        'Renvoie l\'état du dossier, le devis réel et les questions restantes (completer_dossier, ou questionsAPoser puis modifier_dossier). '
      : 'Crée le dossier (POST /dossiers) dès que forme, dénomination, email, téléphone, siège et dirigeant sont connus, complété par les réponses les plus courantes ' +
        '(applyDefaults → assumptions, à annoncer au client). Renvoie le `jeton` du dossier (à réutiliser dans tous les outils et à donner une fois au client comme code de reprise), ' +
        'l\'état du dossier, le devis réel et les questions restantes (questionsAPoser : les poser dans la conversation puis modifier_dossier). ') +
      'Ne pas ouvrir le paiement avant l\'accord explicite du client sur le récapitulatif.',
    inputSchema: {
      dossier: z.record(z.any()).describe(`juridicForm${local ? ' (sinon profil)' : ''}, societe { socialDenomination, commercialBrand?, sigle? }, siege { siegeType madomiciliation | domicile-dirigeant | local-pro | centre-tiers, ` +
        `domiciliationAddressId?, paymentInterval? (month | year | 2years | 3years), siegeCurrentAddress? … }, account ${local ? '? { email?, tel? } (sinon alias du profil)' : '{ email, tel } (une société = un compte : alias prenom+nom-de-la-societe@domaine conseillé)'}, objet? { activities: [{ redaction, custom?, reglementee? }] }, ` +
        `associes? [{ type physic | moral, … }], dirigeant${local ? '?' : ' (identité, adresse, filiation, email, tel)'}, fiscalite?, capital? — champs : schema_dossier`),
      ...(local ? { utiliserProfil: z.boolean().optional().describe('Compléter avec le profil fondateur (défaut true)') } : {}),
      applyDefaults: z.boolean().optional().describe('Défaut true'),
      ...(local ? { confirmerDoublon: z.boolean().optional().describe('Créer même si un dossier en cours porte déjà ce nom sur ce poste') } : {}),
    },
  }, run(args => creerSociete(server, store, args), { redactTokens: local }))

  if (local) server.registerTool('completer_dossier', {
    title: 'Poser les questions restantes du dossier',
    description: 'Relit le dossier, pose chaque groupe de questions manquantes au client par formulaire (elicitation MCP) et enregistre les réponses groupe par groupe ' +
      '(PATCH), jusqu\'à completeness.isComplete ou `max` groupes. Si le client MCP ne supporte pas les formulaires, renvoie questionsAPoser : ' +
      'les poser dans la conversation puis modifier_dossier.',
    inputSchema: {
      ...store.dossierParam,
      groupes: z.array(z.string()).optional().describe('Clés de questionGroups à poser (défaut : tous, dans l\'ordre de l\'API)'),
      max: z.number().int().min(1).max(20).optional().describe('Nombre maximal de groupes par appel (défaut 8)'),
    },
  }, run(args => completerDossier(server, store, args)))

  server.registerTool('statut_dossier', {
    title: 'État du dossier et prochaines actions',
    description: 'Relit le dossier sur ma-domiciliation.fr : statut, complétude (questions restantes), hypothèses prises, paiement, pièces (après paiement' +
      (local ? ', avec la pièce KYC locale disponible' : '') + '), liens et nextActions. detail=complet ajoute toutes les sections (récapitulatif). ' +
      (local
        ? 'attendre=paiement | mot_de_passe sonde l\'API toutes les 8 s jusqu\'à l\'événement (délai max delaiMaxSecondes, défaut 120) après ouvrir_paiement / ouvrir_mot_de_passe, '
        : 'attendre=paiement sonde l\'API toutes les 8 s jusqu\'au paiement (délai max delaiMaxSecondes, défaut 60) après ouvrir_paiement, ') +
      'au tour suivant seulement, quand le client dit avoir payé ou terminé : jamais dans le tour qui ouvre la page ou transmet le lien (le client ne le verrait pas), ' +
      'et pas de relance en boucle sans retour du client.',
    inputSchema: {
      ...store.dossierParam,
      detail: z.enum(['resume', 'complet']).optional().describe('complet = avec les 8 sections (défaut resume)'),
      attendre: (local ? z.enum(['paiement', 'mot_de_passe']) : z.enum(['paiement'])).optional()
        .describe('Sonder jusqu\'à cet événement. À appeler au tour suivant celui qui a transmis le lien ou ouvert la page, jamais dans le même tour.'),
      delaiMaxSecondes: z.number().int().min(5).max(local ? 180 : 120).optional(),
    },
  }, run(args => statutDossier(store, args)))

  server.registerTool('modifier_dossier', {
    title: 'Modifier le dossier',
    description: 'Envoie des modifications au dossier (PATCH, fusion champ par champ) : juridicForm, siege, dirigeant, associes, societe, objet, fiscalite, capital, capitalDeposit, ' +
      'account (avant paiement seulement) et partners { dougs: true | false } pour la réponse à la question Dougs. `null` efface un champ ; les listes (associes, coDirigeants, activities) ' +
      'remplacent entièrement la liste existante (renvoyer la liste complète). Après paiement, compte et siège sont figés. Les warnings (bascule de forme, champs remis à zéro) sont à relayer au client.',
    inputSchema: {
      modifications: z.record(z.any()).describe('Sections à modifier (voir schema_dossier)'),
      ...store.dossierParam,
    },
  }, run(args => modifierDossier(store, args)))
}

export { registerDossierTools, validerDossier, creerSociete, completerDossier, statutDossier, modifierDossier, localFileFor, suggestAlias }
