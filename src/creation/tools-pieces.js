// Outils « pièces » après paiement : envoyer_piece (multipart vers l'API) et deposer_capital.

import { z } from 'zod'

import { run, LocalError, ECRITURE } from './run.js'
import { dossierResponse } from './summary.js'
import { refreshDossier, uploadDocument, submitCapitalDeposit } from './dossiers.js'
import { openUrlElicitation } from './elicitation.js'
import { isValidKind, kycFileForKind, readDocument, prepareUpload, describeKinds } from '../app/kyc.js'
import { localFileFor } from './tools-dossier.js'

const SUBMISSION_HINTS = {
  awaiting_pair: 'Recto reçu, en attente du verso : envoyer_piece sur la clé verso (owner_id_justif_file_2 ou shareholder:<i>:id_justif_file_2) pour déclencher la vérification.',
  success: 'Pièce transmise à la vérification d\'identité (Netheos). Suivre verification.status dans documents.items (statut_dossier).',
  validation_failure: 'Pièce refusée par la vérification d\'identité : voir domiciliation.identity / address (statut, tentatives) et redéposer une pièce lisible (nouvelle tentative).',
}

// Résout `fichier` : un kind KYC local ou un chemin de fichier.
const resolveSource = fichier => {
  if (isValidKind(fichier)) {
    const local = kycFileForKind(fichier)
    if (!local) throw new LocalError(`Aucune pièce KYC locale « ${fichier} » : enregistrer_pieces_kyc d'abord, ou indiquer un chemin de fichier.`)
    return { doc: local, origine: `pièce KYC ${fichier}`, documentType: local.documentType }
  }
  if (/^associe_\d+_|^identite_|^justificatif_/.test(fichier) && !/[/\\.]/.test(fichier)) {
    throw new LocalError(`Kind KYC inconnu « ${fichier} ». Kinds : ${describeKinds().join(' ; ')}.`)
  }
  const doc = readDocument(fichier)
  return { doc, origine: `fichier ${doc.path}`, documentType: undefined }
}

const envoyerPiece = async (store, args) => {
  const { key, fichier, documentType } = args
  const entry = store.resolve(args)
  const dossier = await refreshDossier(store, entry)
  if (dossier.phase === 'pending') {
    throw new LocalError('Les pièces s\'envoient après paiement (ouvrir_paiement, statut_dossier attendre=paiement) : la liste des pièces demandées n\'est fiable qu\'à ce moment.')
  }
  const items = dossier.documents?.items || []
  const item = items.find(i => i.key === key)
  if (!item) {
    const deposables = items.filter(i => i.status !== 'auto').map(i => `${i.key} (${i.status}${i.required ? ', requise' : ''})`)
    throw new LocalError(`Pièce « ${key} » non demandée pour ce dossier. Clés : ${deposables.join(', ') || 'aucune'}.`)
  }
  const source = resolveSource(fichier)
  const type = documentType ?? source.documentType
  const typeOptions = item.documentType && typeof item.documentType === 'object' ? item.documentType.options : null
  if (typeOptions?.length && !type) {
    throw new LocalError(`documentType obligatoire pour « ${key} ». Options : ${typeOptions.map(o => (typeof o === 'string' ? o : `${o.value}${o.title ? ` (${o.title})` : ''}`)).join(', ')}.`)
  }
  // documentType envoyé si donné explicitement, ou repris de la pièce KYC quand l'item en accepte un
  // (une pièce « pdf seul » sans Netheos refuserait un type : DOCUMENT_TYPE_NOT_APPLICABLE).
  const sentType = documentType || (typeOptions ? source.documentType : undefined) || undefined
  const upload = await prepareUpload(source.doc, item.formats)
  const form = new FormData()
  if (sentType) form.append('documentType', String(sentType))
  form.append('file', new Blob([upload.buffer], { type: upload.contentType }), upload.filename)
  const result = await uploadDocument(store, entry, key, form)
  store.remember(entry, result)
  const piece = (result.documents?.items || []).find(i => i.key === key) || null
  const submission = result.submission?.result ?? result.submission ?? null
  const out = {
    key,
    envoye: { origine: source.origine, filename: upload.filename, contentType: upload.contentType, convertiEnPdf: upload.converted, documentType: sentType ?? null },
    submission,
    piece: piece ? { status: piece.status, verification: piece.verification ?? null, documentType: piece.documentType?.value ?? piece.documentType ?? null } : null,
    ...dossierResponse(entry, result, { localFileFor }),
  }
  if (typeof submission === 'string' && SUBMISSION_HINTS[submission]) out.suite = SUBMISSION_HINTS[submission]
  else if (result.documents?.isComplete) out.suite = 'Toutes les pièces requises sont reçues : deposer_capital (qonto | banque) si nextActions le propose, sinon suivre nextActions.'
  else out.suite = 'Continuer avec les pièces manquantes (documents.items status=missing) puis deposer_capital.'
  return out
}

const deposerCapital = async (server, store, args) => {
  const { choice } = args
  const entry = store.resolve(args)
  const result = await submitCapitalDeposit(store, entry, choice)
  store.remember(entry, result)
  const out = { choice, ...dossierResponse(entry, result, { localFileFor }) }
  const link = result.qonto?.redirectionLink
  if (link) {
    out.qonto = { redirectionLink: link, status: result.qonto?.status ?? null }
    out.ouverture = await openUrlElicitation(server, { url: link, message: 'Inscription Qonto pour le dépôt du capital : le client ouvre son compte lui-même sur cette page.' })
    out.suite = 'Dossier transmis. Le client finalise l\'ouverture de son compte Qonto via le lien (inscription à faire par lui-même), puis questionnaire et signature de domiciliation sur le site (links.customerArea) s\'il y a une domiciliation. Suivi : statut_dossier et emails.'
  } else {
    out.suite = choice === 'banque'
      ? 'Dossier transmis aux formalistes. Le client dépose le capital auprès de sa banque et transmet l\'attestation dans son espace client (links.customerArea) ; questionnaire et signature de domiciliation sur le site s\'il y a une domiciliation. Suivi : statut_dossier et emails.'
      : 'Dossier transmis. Suivre nextActions et links.customerArea pour la suite (questionnaire, signature). Suivi : statut_dossier et emails.'
  }
  return out
}

const registerPiecesTools = (server, store) => {
  server.registerTool('envoyer_piece', {
    annotations: ECRITURE,
    title: 'Envoyer une pièce justificative au dossier',
    description: 'Après paiement : envoie une pièce sur une clé de documents.items (statut_dossier) : owner_id_justif_file (recto, documentType ID_CARD / PASSPORT…), ' +
      'owner_id_justif_file_2 (verso), owner_address_justif_file (justificatif de domicile, documentType), siege_current_address_justif, shareholder:<i>:id_justif_file, statuts_file… ' +
      '`fichier` = kind KYC local (identite_recto, justificatif_domicile, associe_1_identite_recto…) ou chemin d\'un fichier PDF/JPEG/PNG ; ' +
      'conversion en PDF automatique si la pièce n\'accepte que le PDF. documentType pris de la pièce KYC si absent. ' +
      'Renvoie submission (awaiting_pair = envoyer le verso ; validation_failure = pièce refusée) et l\'état du dossier.',
    inputSchema: {
      key: z.string().describe('Clé de la pièce dans documents.items'),
      fichier: z.string().describe('Kind KYC local ou chemin du fichier'),
      documentType: z.string().optional().describe('Type de document (options dans documents.items[].documentType.options)'),
      ...store.dossierParam,
    },
  }, run(args => envoyerPiece(store, args)))

  server.registerTool('deposer_capital', {
    annotations: ECRITURE,
    title: 'Choisir le dépôt de capital et transmettre le dossier',
    description: 'Après les pièces : choix du dépôt de capital — qonto (ouverture d\'un compte Qonto via le lien renvoyé, à faire par le client) ou banque (banque du client) — ' +
      'et transmission du dossier aux formalistes (statut submitted). Rejouer le même appel sur SALESFORCE_SYNC_FAILED. Les pièces manquantes ou non validées (DOCUMENTS_MISSING, NETHEOS_PIECES_PENDING) sont expliquées dans l\'erreur.',
    inputSchema: {
      choice: z.enum(['qonto', 'banque']),
      ...store.dossierParam,
    },
  }, run(args => deposerCapital(server, store, args)))
}

export { registerPiecesTools, envoyerPiece, deposerCapital, resolveSource }
