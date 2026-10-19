// Outils « site » : ouvrir_paiement et ouvrir_mot_de_passe (local), lien_paiement (hébergé). Ouvrent la
// page, ou donnent le lien, puis rendent la main : l'assistant termine sa réponse (lien ou page ouverte,
// étapes suivantes) et l'attente se fait au tour suivant avec statut_dossier attendre=paiement |
// mot_de_passe, jamais dans le tour qui transmet le lien.
// En elicitation URL (local), le serveur sonde lui-même l'événement en arrière-plan et clôt l'elicitation
// (notifications/elicitation/complete) dès qu'il est constaté, ce qui libère l'attente du client MCP.
// La sonde est unique par dossier et par événement (dossiers.js) : un second appel ou un statut_dossier
// attendre=… rejoint la veille en cours, et chaque elicitation est close à la fin de la même veille.
// En hébergé, lien_paiement ne fait que lire (dossier, devis) et renvoyer le lien : annoté lecture seule,
// nom sans verbe d'action, et le même lien (links.paymentPage, paiement.lien) figure dans toute réponse
// dossier complète non payée (tools-dossier.js) pour que le client le reçoive même si le client MCP
// refuse l'appel (ChatGPT, « blocked by OpenAI's safety checks », constaté le 2026-10-16).

import { run, LocalError, LECTURE } from './run.js'
import { summarizeQuote, dossierResponse } from './summary.js'
import { refreshDossier, fetchPayment, waitForStatus } from './dossiers.js'
import { openUrlElicitation, CONSIGNE_LIEN } from './elicitation.js'

// Nom de l'outil qui mène au paiement selon le mode : ouvre la page en local, donne le lien en hébergé.
const nomOutilPaiement = store => (store.mode === 'local' ? 'ouvrir_paiement' : 'lien_paiement')

// La page a-t-elle été ouverte pour le client (elicitation acceptée ou navigateur du poste) ? Sinon le lien se donne.
const pageOuverte = ouverture => ouverture?.mode === 'elicitation' || ouverture?.mode === 'navigateur'

const TERMINER = 'TERMINER LA RÉPONSE MAINTENANT : '
const consigneFin = (ouverture, lienLabel) => TERMINER + (pageOuverte(ouverture)
  ? 'dire au client que la page est ouverte et ce qu\'il doit faire'
  : `donner au client le lien exact ${lienLabel} (la page n'a pas été ouverte pour lui) et ce qu'il doit faire, sans parler d'un échec d'ouverture`) +
  ', sans appeler d\'autre outil dans ce tour. '

// Sonde en arrière-plan après une elicitation URL : 10 min au plus (3-D Secure, hésitation du client).
const CLOTURE_MAX_SECONDS = 600
const attenteCloture = (store, entry, until, libelle) => ({
  fn: () => waitForStatus(store, entry, { until, maxSeconds: CLOTURE_MAX_SECONDS }),
  cloture: `Le client MCP est prévenu de la fin de cette page (elicitation close) dès que ${libelle} est constaté par le serveur, ` +
    `ou au plus tard après ${CLOTURE_MAX_SECONDS / 60} min. Ce signal ne remplace pas la vérification : statut_dossier attendre=${until} au tour suivant.`,
})

const ouvrirPaiement = async (server, store, args) => {
  const entry = store.resolve(args)
  const dossier = await refreshDossier(store, entry)
  const local = store.mode === 'local'
  const outil = nomOutilPaiement(store)
  const base = { societe: { socialDenomination: dossier.sections?.societe?.socialDenomination ?? entry.socialDenomination, publicToken: entry.publicToken } }
  if (dossier.payment?.status === 'paid' || dossier.phase === 'provisioned') {
    const suite = local
      ? (dossier.account?.hasPassword ? 'Déjà payé et mot de passe défini : statut_dossier pour les pièces.' : 'Déjà payé : ouvrir_mot_de_passe.')
      : 'Déjà payé : le client termine sur le site (links.passwordPage puis links.customerArea, à donner dans un message final).'
    return { ...base, status: 'paid', paidAt: dossier.payment?.paidAt ?? null, suite }
  }
  if (!dossier.completeness?.isComplete) {
    const n = (dossier.completeness?.missing || []).length
    throw new LocalError(`Le dossier n'est pas complet (${n} question(s) restante(s), groupes : ${(dossier.completeness?.questionGroups || []).map(g => g.key).join(', ') || '—'}) : ` +
      `${local ? 'completer_dossier (ou modifier_dossier)' : 'modifier_dossier'} avant ${outil}. Rappel : accord explicite du client sur le récapitulatif et le devis avant cet outil.`)
  }
  const payment = await fetchPayment(store, entry)
  const quote = summarizeQuote(payment.quote)
  const url = payment.paymentUrl || dossier.links?.paymentPage
  const out = { ...base, status: payment.status, paymentUrl: url, quote: quote || `indisponible (panne Stripe temporaire) : réessayer ${outil} dans quelques instants` }
  const carte = 'Le client paie sur la page (carte, 3-D Secure éventuel) ; l\'assistant ne saisit jamais la carte. '
  if (!local) {
    return {
      ...out,
      consigne: CONSIGNE_LIEN,
      suite: carte + 'TERMINER LA RÉPONSE MAINTENANT avec le lien exact (paymentUrl) et les étapes suivantes, sans appeler d\'autre outil dans ce tour : ' +
        'le client ne voit pas un texte écrit entre deux appels d\'outils. statut_dossier attendre=paiement seulement au tour suivant, quand le client dit avoir payé ou être sur la page. ' +
        'Après le paiement, le client termine sur le site : mot de passe (links.passwordPage), puis justificatifs et dépôt de capital dans son espace client (links.customerArea). ' +
        'Le même lien est links.paymentPage (paiement.lien) dans toute réponse de statut_dossier : si cet outil ne répond pas, le donner de là.',
    }
  }
  const message = quote
    ? `Paiement de la création de ${base.societe.socialDenomination} : ${quote.resume}. Le client règle par carte sur cette page du site, puis choisit son mot de passe.`
    : `Paiement de la création de ${base.societe.socialDenomination} sur le site (devis indisponible pour l'instant).`
  const ouverture = await openUrlElicitation(server, { url, message, attendre: attenteCloture(store, entry, 'paiement', 'le paiement') })
  return {
    ...out,
    ouverture,
    suite: carte + consigneFin(ouverture, 'paymentUrl') +
      'statut_dossier attendre=paiement seulement au tour suivant, quand le client dit avoir payé ; ensuite ouvrir_mot_de_passe.',
  }
}

const ouvrirMotDePasse = async (server, store, args) => {
  const entry = store.resolve(args)
  const dossier = await refreshDossier(store, entry)
  const base = { societe: { socialDenomination: dossier.sections?.societe?.socialDenomination ?? entry.socialDenomination, publicToken: entry.publicToken } }
  if (dossier.phase === 'pending' || dossier.payment?.status !== 'paid') {
    throw new LocalError('Le dossier n\'est pas encore payé : ouvrir_paiement puis statut_dossier attendre=paiement avant de choisir le mot de passe.')
  }
  if (dossier.account?.hasPassword) {
    return { ...base, dejaDefini: true, suite: 'Mot de passe déjà défini : statut_dossier pour les pièces (envoyer_piece) puis deposer_capital.' }
  }
  const url = dossier.links?.passwordPage
  const ouverture = await openUrlElicitation(server, {
    url,
    message: `Choix du mot de passe de l'espace client ma-domiciliation.fr pour ${base.societe.socialDenomination}. Le client le choisit lui-même sur cette page ; ne jamais le demander ni le noter.`,
    attendre: attenteCloture(store, entry, 'mot_de_passe', 'le mot de passe'),
  })
  return {
    ...base,
    passwordPage: url,
    ouverture,
    suite: 'Le client choisit son mot de passe sur la page (jamais transmis à l\'assistant). ' + consigneFin(ouverture, 'passwordPage') +
      'statut_dossier attendre=mot_de_passe seulement au tour suivant, quand le client dit avoir terminé ; ensuite les pièces (envoyer_piece).',
    ...(dossier.nextActions?.length ? { nextActions: dossierResponse(entry, dossier).nextActions } : {}),
  }
}

const registerSiteTools = (server, store) => {
  if (store.mode !== 'local') {
    server.registerTool('lien_paiement', {
      title: 'Lien de paiement du dossier',
      description: 'Lecture seule : relit le dossier et le devis, et renvoie le lien de la page de paiement du site (paymentUrl), à transmettre tel quel au client. ' +
        'Ne déclenche aucun paiement ni aucune écriture : le client règle lui-même par carte sur le site ; l\'assistant ne saisit jamais la carte. ' +
        'À appeler après l\'accord explicite du client sur le récapitulatif et le devis ; refuse un dossier incomplet. ' +
        'Ensuite, terminer la réponse avec le lien exact et les étapes suivantes, sans autre appel d\'outil dans ce tour ; ' +
        'statut_dossier attendre=paiement au tour suivant seulement (quand le client dit avoir payé) ; après le paiement, le client termine sur le site. ' +
        'Le même lien figure dans toute réponse de statut_dossier (links.paymentPage, paiement.lien).',
      inputSchema: { ...store.dossierParam },
      annotations: LECTURE,
    }, run(args => ouvrirPaiement(server, store, args)))
    return
  }

  server.registerTool('ouvrir_paiement', {
    title: 'Ouvrir la page de paiement du dossier',
    description: 'Après l\'accord explicite du client sur le récapitulatif et le devis : ouvre la page de paiement du site (elicitation URL, ou navigateur du poste, ' +
      'ou lien à transmettre) et rend la main. Refuse si le dossier est incomplet. Le client règle par carte sur le site ; l\'assistant ne saisit jamais la carte. ' +
      'Ensuite, terminer la réponse avec la page ouverte, ou le lien exact si ouverture.mode = lien (sans parler d\'un échec d\'ouverture), et les étapes suivantes, ' +
      'sans autre appel d\'outil dans ce tour. statut_dossier attendre=paiement au tour suivant seulement (quand le client dit avoir payé), puis ouvrir_mot_de_passe. ' +
      'Le même lien est links.paymentPage dans statut_dossier.',
    inputSchema: { ...store.dossierParam },
    annotations: LECTURE,
  }, run(args => ouvrirPaiement(server, store, args)))

  server.registerTool('ouvrir_mot_de_passe', {
    title: 'Ouvrir la page de choix du mot de passe',
    description: 'Après paiement : ouvre la page où le client choisit lui-même le mot de passe de son espace client (jamais transmis à l\'assistant) et rend la main : ' +
      'terminer la réponse (page ouverte, ou lien exact passwordPage si ouverture.mode = lien) sans autre appel d\'outil. ' +
      'statut_dossier attendre=mot_de_passe au tour suivant seulement, quand le client dit avoir terminé.',
    inputSchema: { ...store.dossierParam },
    annotations: LECTURE,
  }, run(args => ouvrirMotDePasse(server, store, args)))
}

export { registerSiteTools, ouvrirPaiement, ouvrirMotDePasse, nomOutilPaiement }
