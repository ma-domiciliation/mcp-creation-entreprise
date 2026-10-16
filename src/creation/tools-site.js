// Outils « site » : ouvrir_paiement, ouvrir_mot_de_passe. Ouvrent la page puis rendent la main :
// l'assistant termine sa réponse (lien ou page ouverte, étapes suivantes) et l'attente se fait au tour
// suivant avec statut_dossier attendre=paiement | mot_de_passe, jamais dans le tour qui transmet le lien.
// En elicitation URL, le serveur sonde lui-même l'événement en arrière-plan et clôt l'elicitation
// (notifications/elicitation/complete) dès qu'il est constaté, ce qui libère l'attente du client MCP.
// La sonde est unique par dossier et par événement (dossiers.js) : un second appel ou un statut_dossier
// attendre=… rejoint la veille en cours, et chaque elicitation est close à la fin de la même veille.

import { run, LocalError } from './run.js'
import { summarizeQuote, dossierResponse } from './summary.js'
import { refreshDossier, fetchPayment, waitForStatus } from './dossiers.js'
import { openUrlElicitation } from './elicitation.js'

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
  const base = { societe: { socialDenomination: dossier.sections?.societe?.socialDenomination ?? entry.socialDenomination, publicToken: entry.publicToken } }
  if (dossier.payment?.status === 'paid' || dossier.phase === 'provisioned') {
    const suite = store.mode === 'local'
      ? (dossier.account?.hasPassword ? 'Déjà payé et mot de passe défini : statut_dossier pour les pièces.' : 'Déjà payé : ouvrir_mot_de_passe.')
      : 'Déjà payé : le client termine sur le site (links.passwordPage puis links.customerArea, à donner dans un message final).'
    return { ...base, status: 'paid', paidAt: dossier.payment?.paidAt ?? null, suite }
  }
  if (!dossier.completeness?.isComplete) {
    const n = (dossier.completeness?.missing || []).length
    throw new LocalError(`Le dossier n'est pas complet (${n} question(s) restante(s), groupes : ${(dossier.completeness?.questionGroups || []).map(g => g.key).join(', ') || '—'}) : ` +
      'completer_dossier (ou modifier_dossier) avant d\'ouvrir le paiement. Rappel : accord explicite du client sur le récapitulatif et le devis avant cet outil.')
  }
  const payment = await fetchPayment(store, entry)
  const quote = summarizeQuote(payment.quote)
  const url = payment.paymentUrl || dossier.links?.paymentPage
  const message = quote
    ? `Paiement de la création de ${base.societe.socialDenomination} : ${quote.resume}. Le client règle par carte sur cette page du site, puis choisit son mot de passe.`
    : `Paiement de la création de ${base.societe.socialDenomination} sur le site (devis indisponible pour l'instant).`
  const local = store.mode === 'local'
  const ouverture = await openUrlElicitation(server, {
    url, message, lienSeul: !local, attendre: local ? attenteCloture(store, entry, 'paiement', 'le paiement') : null,
  })
  return {
    ...base,
    status: payment.status,
    paymentUrl: url,
    quote: quote || 'indisponible (panne Stripe temporaire) : réessayer ouvrir_paiement dans quelques instants',
    ouverture,
    suite: local
      ? 'Le client paie sur la page (carte, 3-D Secure éventuel) ; l\'assistant ne saisit jamais la carte. ' +
        'TERMINER LA RÉPONSE MAINTENANT : dire au client que la page est ouverte (ou lui donner le lien exact paymentUrl si ouverture.mode = lien) et ce qu\'il doit faire, ' +
        'sans appeler d\'autre outil dans ce tour. statut_dossier attendre=paiement seulement au tour suivant, quand le client dit avoir payé ; ensuite ouvrir_mot_de_passe.'
      : 'Le client paie sur la page (carte, 3-D Secure éventuel) ; l\'assistant ne saisit jamais la carte. ' +
        'TERMINER LA RÉPONSE MAINTENANT avec le lien exact (paymentUrl) et les étapes suivantes, sans appeler d\'autre outil dans ce tour : ' +
        'le client ne voit pas un texte écrit entre deux appels d\'outils. statut_dossier attendre=paiement seulement au tour suivant, quand le client dit avoir payé ou être sur la page. ' +
        'Après le paiement, le client termine sur le site : mot de passe (links.passwordPage), puis justificatifs et dépôt de capital dans son espace client (links.customerArea).',
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
    suite: 'Le client choisit son mot de passe sur la page (jamais transmis à l\'assistant). TERMINER LA RÉPONSE MAINTENANT (page ouverte, ou lien exact passwordPage si ouverture.mode = lien), ' +
      'sans appeler d\'autre outil dans ce tour. statut_dossier attendre=mot_de_passe seulement au tour suivant, quand le client dit avoir terminé ; ensuite les pièces (envoyer_piece).',
    ...(dossier.nextActions?.length ? { nextActions: dossierResponse(entry, dossier).nextActions } : {}),
  }
}

const registerSiteTools = (server, store) => {
  const local = store.mode === 'local'
  server.registerTool('ouvrir_paiement', {
    title: local ? 'Ouvrir la page de paiement du dossier' : 'Obtenir le lien de paiement du dossier',
    description: 'Après l\'accord explicite du client sur le récapitulatif et le devis : ' +
      (local
        ? 'ouvre la page de paiement du site (elicitation URL, ou navigateur du poste, ou lien à transmettre) et rend la main. '
        : 'renvoie le lien de la page de paiement du site, à transmettre tel quel au client. ') +
      'Refuse si le dossier est incomplet. Le client règle par carte sur le site ; l\'assistant ne saisit jamais la carte. ' +
      'Ensuite, terminer la réponse avec ' + (local ? 'la page ouverte ou le lien exact' : 'le lien exact') + ' et les étapes suivantes, sans autre appel d\'outil dans ce tour. ' +
      (local
        ? 'statut_dossier attendre=paiement au tour suivant seulement (quand le client dit avoir payé), puis ouvrir_mot_de_passe.'
        : 'statut_dossier attendre=paiement au tour suivant seulement (quand le client dit avoir payé) ; après le paiement, le client termine sur le site.'),
    inputSchema: { ...store.dossierParam },
  }, run(args => ouvrirPaiement(server, store, args)))

  if (!local) return

  server.registerTool('ouvrir_mot_de_passe', {
    title: 'Ouvrir la page de choix du mot de passe',
    description: 'Après paiement : ouvre la page où le client choisit lui-même le mot de passe de son espace client (jamais transmis à l\'assistant) et rend la main : ' +
      'terminer la réponse sans autre appel d\'outil. statut_dossier attendre=mot_de_passe au tour suivant seulement, quand le client dit avoir terminé.',
    inputSchema: { ...store.dossierParam },
  }, run(args => ouvrirMotDePasse(server, store, args)))
}

export { registerSiteTools, ouvrirPaiement, ouvrirMotDePasse }
