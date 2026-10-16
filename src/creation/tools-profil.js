// Outils locaux : guide, profil fondateur, pièces KYC, registre des sociétés, prompt creer-ma-societe.

import { z } from 'zod'

import { post, isApiError } from './api.js'
import { run, LocalError } from './run.js'
import { buildGuide, buildPromptText } from './guide.js'
import { buildProfileValidationBody, FOUNDER_TO_DIRIGEANT, FISCALITE_KEYS } from './prefill.js'
import { readProfile, writeProfile, profilePath } from '../profile.js'
import { describeKinds, registerKycFile, listKycFiles } from '../app/kyc.js'
import { chercherPieces, DOSSIERS_PAR_DEFAUT, MOTIFS_PAR_DEFAUT } from '../app/recherche-pieces.js'
import { readRegistry, sanitizeEntry } from '../app/registry.js'

const FOUNDER_KEYS = [...Object.keys(FOUNDER_TO_DIRIGEANT), 'email', 'tel']
const PREFERENCE_KEYS = ['juridicForm', 'addressId', 'paymentInterval', 'socialCapital', 'nominalShareValue', 'ownerShareCapitalOrigins', 'capitalDepositary', 'bankName', ...FISCALITE_KEYS]
const LEGACY_PROFILE_KEYS = ['partners', 'commitment', 'representative']
// Erreurs de validate sans objet pour un profil seul (le compte, la société et le type de siège viennent du dossier).
const IRRELEVANT_SECTIONS = ['account', 'societe']

const merge = (base = {}, patch = {}) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else if (v !== undefined) out[k] = v
  }
  return out
}

const profileSummary = profile => (profile ? {
  fondateur: profile.founder ? `${profile.founder.firstname || ''} ${profile.founder.name || ''}`.trim() || null : null,
  email: profile.founder?.email ?? null,
  preferences: profile.preferences || {},
  emailAliasPerCompany: profile.emailAliasPerCompany !== false,
  updatedAt: profile.updatedAt ?? null,
} : null)

// Vérification des formats par l'API (dry-run anonyme) ; jamais bloquante pour la sauvegarde.
const verifyProfile = async profile => {
  try {
    const result = await post('/dossiers/validate', buildProfileValidationBody(profile))
    const erreursFormat = (result.errors || []).filter(e => !IRRELEVANT_SECTIONS.includes(e.section) && !(e.section === 'siege' && e.field === 'siegeType'))
    return { verification: erreursFormat.length ? 'erreurs' : 'ok', erreursFormat }
  } catch (err) {
    return { verification: 'indisponible', erreursFormat: [], detail: isApiError(err) ? `${err.error} : ${err.message}` : err.message }
  }
}

const enregistrerProfil = async ({ founder = {}, preferences = {}, emailAliasPerCompany }) => {
  const existing = readProfile() || {}
  const profile = {
    founder: merge(existing.founder, founder),
    preferences: merge(existing.preferences, preferences),
    emailAliasPerCompany: emailAliasPerCompany ?? existing.emailAliasPerCompany ?? true,
    updatedAt: new Date().toISOString(),
  }
  const path = writeProfile(profile)
  const champsIgnores = Object.keys(founder).filter(k => !FOUNDER_KEYS.includes(k))
  const preferencesIgnorees = Object.keys(preferences).filter(k => !PREFERENCE_KEYS.includes(k))
  const anciennesClesPurgees = LEGACY_PROFILE_KEYS.filter(k => existing[k] !== undefined)
  const check = await verifyProfile(profile)
  const out = { saved: true, path, ...check, profil: profile }
  if (champsIgnores.length) out.champsIgnores = { founder: champsIgnores, note: `Clés founder connues : ${FOUNDER_KEYS.join(', ')}` }
  if (preferencesIgnorees.length) out.preferencesIgnorees = { preferences: preferencesIgnorees, note: `Clés preferences connues : ${PREFERENCE_KEYS.join(', ')}` }
  if (anciennesClesPurgees.length) out.anciennesClesPurgees = anciennesClesPurgees
  if (check.verification === 'erreurs') out.consigne = 'Corriger les champs listés dans erreursFormat puis rappeler enregistrer_profil_fondateur avec ces champs seulement (fusion champ par champ ; null efface).'
  return out
}

const voirProfil = () => {
  const profile = readProfile()
  if (!profile) return { profil: null, hint: `Aucun profil fondateur (${profilePath()}) : suivre guide_creation étape 2 puis enregistrer_profil_fondateur.` }
  return { profil: profile, path: profilePath() }
}

const enregistrerPiece = ({ kind, path, documentType }) => {
  const saved = registerKycFile(kind, path, { documentType })
  const out = { saved, pieces: listKycFiles() }
  if (/identite_recto$/.test(kind) && !saved.documentType) {
    out.conseil = 'documentType non renseigné : il sera demandé à l\'envoi d\'une pièce d\'identité vérifiée par Netheos (ID_CARD, PASSPORT, RESIDENCE_PERMIT… — options exactes dans documents.items de statut_dossier après paiement).'
  }
  return out
}

// Recherche de pièces sur le poste : seulement après l'accord explicite du client. L'outil liste sans
// lire aucun fichier ; l'assistant ouvre ensuite les fichiers listés pour reconnaître la pièce.

// Une liste `autres` coupée est le cas normal d'un dossier Téléchargements : les candidats restent complets,
// aucun aller-retour avec le client n'est imposé. Seuls des candidats coupés appellent à préciser le dossier.
const complementTroncature = ({ candidatsTronques, autresTronques, parcoursInterrompu }) => {
  const parts = []
  if (candidatsTronques) parts.push('Candidats au nom évocateur plus nombreux que la limite (les plus récents gardés) : demander au client de préciser le dossier, ou relancer avec une limite plus haute.')
  else if (autresTronques) parts.push('Les autres fichiers sont tronqués (les plus récents gardés) : commencer par les candidats ; demander au client de préciser le dossier seulement si la pièce n\'y est pas.')
  if (parcoursInterrompu) parts.push('Parcours arrêté avant la fin (dossiers volumineux) : si la pièce n\'est pas dans la liste, demander au client le sous-dossier et relancer chercher_pieces avec ce dossier.')
  return parts.length ? ` ${parts.join(' ')}` : ''
}
const chercherPiecesOutil = ({ accordDuClient, dossiers, motifs, profondeur, limite }) => {
  if (accordDuClient !== true) {
    throw new LocalError('Demander d\'abord au client s\'il accepte que l\'assistant cherche ses pièces sur ce poste, puis rappeler chercher_pieces avec accordDuClient: true. Sans accord, demander la pièce dans la conversation.')
  }
  const result = chercherPieces({ dossiers, motifs, profondeur, limite })
  const trouve = result.candidats.length + result.autres.length > 0
  const ecartes = result.dossiersEcartes.length ? ' Dossiers écartés (dossiersEcartes, avec la raison) : le dire au client et lui demander un autre dossier.' : ''
  return {
    ...result,
    consigne: (trouve
      ? 'Ouvrir les fichiers dans l\'ordre (candidats puis autres, du plus récent au plus ancien), dans ces dossiers seulement, jusqu\'à reconnaître la pièce, même si le nom du fichier ne dit rien ; ' +
        'dire au client quel fichier a été retenu (nom, dossier, nature, date du document) et attendre sa confirmation avant enregistrer_pieces_kyc (extraction des champs : guide_creation étape 2). ' +
        'Aucun fichier n\'a été lu ni copié par cette recherche.' +
        complementTroncature(result)
      : result.parcoursInterrompu
        ? 'Aucun fichier trouvé, mais le parcours s\'est arrêté avant la fin (dossiers trop volumineux) : demander au client de préciser le sous-dossier où se trouve la pièce, puis relancer chercher_pieces avec ce dossier.'
        : 'Aucun fichier candidat : demander la pièce au client dans la conversation (chemin ou pièce jointe), ou relancer avec d\'autres dossiers s\'il en indique.') + ecartes,
  }
}

const mesSocietes = () => {
  const { societes, ignored } = readRegistry()
  return {
    profil: profileSummary(readProfile()),
    pieces_kyc: listKycFiles().map(p => ({ kind: p.kind, ext: p.ext, documentType: p.documentType, registeredAt: p.registeredAt })),
    societes: societes.map(sanitizeEntry),
    entreesIgnorees: ignored,
    note: 'Désigner un dossier par sa dénomination ou son publicToken dans le paramètre societe des autres outils. Le jeton de dossier n\'est jamais affiché.',
  }
}

const registerProfilTools = (server, store) => {
  const local = store.mode === 'local'
  const guide = buildGuide(store.mode)
  server.registerTool('guide_creation', {
    title: 'Guide de création de société (à appeler en premier)',
    description: 'Déroulé complet à suivre par l\'assistant pour créer une société avec ma-domiciliation.fr : questions initiales, ' +
      'pièces à lire et champs à extraire, siège, création du dossier et questions restantes, récapitulatif avec devis et hypothèses, ' +
      (local
        ? 'question Dougs, paiement et mot de passe sur le site, pièces, dépôt de capital, suivi, posture envers le client, interdits.'
        : 'question Dougs, paiement sur le site, puis fin du parcours sur le site (mot de passe, justificatifs, dépôt de capital), posture envers le client, interdits.'),
    inputSchema: {},
  }, run(() => guide))

  server.registerPrompt('creer-ma-societe', {
    title: 'Créer ma société',
    description: 'Lance le parcours guidé de création de société avec ma-domiciliation.fr.',
    argsSchema: {},
  }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: buildPromptText(store.mode) } }] }))

  if (!local) return

  server.registerTool('enregistrer_profil_fondateur', {
    title: 'Enregistrer mon profil fondateur (une fois pour toutes les sociétés)',
    description: 'Enregistre LOCALEMENT (~/.madom/profil.json) l\'identité du dirigeant et ses préférences, fusionnées champ par champ ' +
      'avec le profil existant (null efface). Les formats sont vérifiés par l\'API (dry-run) : erreursFormat liste ce qui est à corriger ; ' +
      'le profil est sauvegardé même en cas d\'erreur. Une société = un compte : chaque dossier reçoit un alias email prenom+nom-de-la-societe@domaine ' +
      '(emailAliasPerCompany, défaut true). Les offres partenaires ne font pas partie du profil (question Dougs posée par dossier).',
    inputSchema: {
      founder: z.record(z.any()).describe('Champs dirigeant : gender (MR | MME), name, firstname, otherFirstnames?, usageName?, email, tel, ' +
        'birthdate (JJ/MM/AAAA), birthCity, birthPostalCode, birthCountry?, nationality, maritalStatus, fatherName, fatherFirstname, motherName, motherFirstname, ' +
        'address (adresse personnelle complète), socialSecurityNumber? (SARL/EURL/SCI), healthInsuranceOrganism? (ex. « Régime général »), hadPreviousNonSalariedActivity?. ' +
        'Valeurs possibles : schema_dossier section=dirigeant.'),
      preferences: z.record(z.any()).optional().describe('juridicForm?, addressId? (lister_centres), paymentInterval? (month | year | 2years | 3years), socialCapital?, nominalShareValue?, ' +
        'ownerShareCapitalOrigins? (origine des fonds de l\'apport, liste : personal_savings, employment_or_business_income, dividends, shareholder_current_account, holding_company_contribution, donation, real_estate_sale, disposal_of_securities, business_sale, insurance_payout, other_origins), ' +
        'capitalDepositary? (neobanque | banque), bankName?, regimeFiscalImpots?, regimeFiscalImpotsDetail?, regimeFiscalTva?, tvaSurOption?, tvaTrimestrielle?, regimeMicroSocial?, exerciceMois?, exerciceAnnee?. ' +
        'Valeurs possibles par forme : schema_dossier (juridicFormsDetail).'),
      emailAliasPerCompany: z.boolean().optional().describe('Alias email par société (défaut true)'),
    },
  }, run(enregistrerProfil))

  server.registerTool('voir_profil_fondateur', {
    title: 'Voir le profil fondateur enregistré',
    description: 'Affiche le profil fondateur local (identité, préférences) ou indique qu\'il n\'existe pas.',
    inputSchema: {},
  }, run(voirProfil))

  server.registerTool('enregistrer_pieces_kyc', {
    title: 'Enregistrer une pièce justificative (dirigeant ou associé)',
    description: 'Copie LOCALEMENT (~/.madom/kyc/) une pièce dans son format d\'origine (PDF, JPEG ou PNG) avec son type de document, ' +
      'pour l\'envoyer ensuite à chaque dossier avec envoyer_piece (conversion en PDF automatique si la pièce l\'exige). ' +
      'AVANT d\'appeler cet outil, LIRE le document et en extraire les informations (guide_creation étape 2). Types : ' + describeKinds().join(' ; ') + '.',
    inputSchema: {
      kind: z.string().describe('identite_recto, identite_verso, justificatif_domicile, statuts_signes, diplome_ou_agrement, ou associe_<n>_identite_recto / associe_<n>_identite_verso / associe_<n>_kbis'),
      path: z.string().describe('Chemin du fichier (PDF, JPEG ou PNG)'),
      documentType: z.string().optional().describe('Type de document pour la vérification d\'identité : ID_CARD, PASSPORT, RESIDENCE_PERMIT… pour une pièce d\'identité ; PROVIDER_INVOICE_OR_SCHEDULE… pour un justificatif de domicile'),
    },
  }, run(enregistrerPiece))

  server.registerTool('chercher_pieces', {
    title: 'Chercher des justificatifs sur ce poste (après accord du client)',
    description: 'À n\'appeler qu\'après l\'accord explicite du client, quand une pièce manque et qu\'il accepte que l\'assistant la cherche sur son poste : ' +
      `liste tous les fichiers PDF, JPEG ou PNG (d'après leur contenu) de ses dossiers usuels (${DOSSIERS_PAR_DEFAUT.join(', ')}) ou des dossiers qu'il indique, ` +
      'ceux dont le nom évoque une pièce en tête (candidats), les autres dans autres. Ne lit, ne copie et n\'envoie aucun fichier. ' +
      'L\'assistant ouvre ensuite ces fichiers, dans ces dossiers seulement, pour reconnaître la pièce (même si le nom ne dit rien), ' +
      'annonce ce qu\'il a trouvé et demande une confirmation courte au client avant enregistrer_pieces_kyc.',
    inputSchema: {
      accordDuClient: z.boolean().describe('true seulement si le client a explicitement accepté la recherche sur son poste'),
      dossiers: z.array(z.string()).optional().describe('Dossiers à parcourir (défaut : dossiers usuels du compte)'),
      motifs: z.array(z.string()).optional().describe(`Mots ou fragments du nom de fichier (texte simple, insensible à la casse), indices de tri et non filtre ; défaut : ${MOTIFS_PAR_DEFAUT.join(', ')}`),
      profondeur: z.number().int().min(1).max(6).optional().describe('Profondeur de sous-dossiers (défaut 3)'),
      limite: z.number().int().min(1).max(100).optional().describe('Nombre maximal de fichiers par liste (défaut 20, les plus récents)'),
    },
  }, run(chercherPiecesOutil))

  server.registerTool('mes_societes', {
    title: 'Mes dossiers de création connus sur ce poste',
    description: 'Liste le profil (résumé), les pièces KYC enregistrées et les dossiers de création ouverts depuis ce poste ' +
      '(dénomination, publicToken, statut, liens), sans aucun secret.',
    inputSchema: {},
  }, run(mesSocietes))
}

export { registerProfilTools, enregistrerProfil, voirProfil, enregistrerPiece, chercherPiecesOutil, mesSocietes, FOUNDER_KEYS, PREFERENCE_KEYS }
