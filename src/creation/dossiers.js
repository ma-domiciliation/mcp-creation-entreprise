// Accès aux routes à jeton de l'API pour une entrée de dossier résolue par le store.
// Le jeton reste dans l'entrée ; les outils ne renvoient que sanitizeEntry(entry).

import { get, patch, post, postMultipart, isApiError } from './api.js'
import { LocalError } from './run.js'
import { sanitizeEntry } from '../app/registry.js'

const DEFAULT_MAX_SECONDS = 120
const DEFAULT_STEP_SECONDS = 8

// Enveloppe des appels à jeton : un 401 est signalé au store avant de remonter l'erreur.
const withToken = async (store, entry, fn) => {
  try {
    return await fn(entry.token)
  } catch (err) {
    if (isApiError(err) && err.status === 401) store.invalidate(entry, err)
    throw err
  }
}

const fetchDossier = (store, entry) => withToken(store, entry, token => get('/dossiers/me', { token }))
const patchDossier = (store, entry, body) => withToken(store, entry, token => patch('/dossiers/me', body, { token }))
const validateDossier = (store, entry, body) => withToken(store, entry, token => post('/dossiers/validate', body, { token }))
const fetchPayment = (store, entry) => withToken(store, entry, token => get('/dossiers/me/payment', { token }))
const uploadDocument = (store, entry, key, formData) =>
  withToken(store, entry, token => postMultipart(`/dossiers/me/documents/${encodeURIComponent(key)}`, formData, { token }))
const submitCapitalDeposit = (store, entry, choice) =>
  withToken(store, entry, token => post('/dossiers/me/capital-deposit', { choice }, { token }))

// Idem fetch/patch, avec mise à jour de l'entrée par le store.
const refreshDossier = async (store, entry) => {
  const dossier = await fetchDossier(store, entry)
  store.remember(entry, dossier)
  return dossier
}
const updateDossier = async (store, entry, body) => {
  const dossier = await patchDossier(store, entry, body)
  store.remember(entry, dossier)
  return dossier
}

const WAIT_TARGETS = {
  paiement: {
    probe: (store, entry) => fetchPayment(store, entry),
    reached: payment => payment?.status === 'paid',
  },
  mot_de_passe: {
    probe: (store, entry) => fetchDossier(store, entry),
    reached: dossier => dossier?.account?.hasPassword === true,
  },
}

// Veilles en cours : une seule sonde par dossier et par événement attendu, partagée entre la clôture
// d'elicitation (ouvrir_paiement, ouvrir_mot_de_passe) et statut_dossier attendre=… Un nouvel abonné
// prolonge la veille jusqu'à sa propre échéance et déclenche une sonde immédiate. Temporisations sans
// maintien du processus (unref). Une erreur de sonde (dont un 401, qui a déjà invalidé l'entrée via
// withToken) termine la veille pour tous ses abonnés.
const veilles = {} // `${until}:${token}` → veille

const creerVeille = (store, entry, until, { stepSeconds, maxSeconds }) => {
  const cle = `${until}:${entry.token}`
  const target = WAIT_TARGETS[until]
  const veille = { dernier: null, jusquA: Date.now() + maxSeconds * 1000, reveiller: () => {}, fin: null }
  veille.prolonger = maxSeconds => { veille.jusquA = Math.max(veille.jusquA, Date.now() + maxSeconds * 1000) }
  const pause = () => new Promise(resolve => {
    const timer = setTimeout(resolve, stepSeconds * 1000)
    timer.unref?.()
    veille.reveiller = () => { clearTimeout(timer); resolve() }
  })
  veille.fin = (async () => {
    try {
      veille.dernier = await target.probe(store, entry)
      while (!target.reached(veille.dernier) && Date.now() < veille.jusquA) {
        await pause()
        veille.dernier = await target.probe(store, entry)
      }
      return { atteint: target.reached(veille.dernier), dernier: veille.dernier }
    } finally {
      delete veilles[cle]
    }
  })()
  veilles[cle] = veille
  return veille
}

// waitForStatus(store, entry, { until: 'paiement' | 'mot_de_passe', maxSeconds, stepSeconds })
// → { atteint, dureeSecondes, dernier } ; `dernier` = dernière réponse de la sonde. Rejette sur erreur de sonde.
const waitForStatus = async (store, entry, { until, maxSeconds = DEFAULT_MAX_SECONDS, stepSeconds = DEFAULT_STEP_SECONDS } = {}) => {
  if (!WAIT_TARGETS[until]) throw new LocalError(`Attente inconnue « ${until} » : valeurs possibles paiement, mot_de_passe.`)
  const startedAt = Date.now()
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000)
  const cle = `${until}:${entry.token}`
  const existante = veilles[cle]
  const veille = existante || creerVeille(store, entry, until, { stepSeconds, maxSeconds })
  if (existante) { veille.prolonger(maxSeconds); veille.reveiller() }
  let echeance
  const expiree = new Promise(resolve => { echeance = setTimeout(() => resolve(null), maxSeconds * 1000); echeance.unref?.() })
  try {
    const result = await Promise.race([veille.fin, expiree])
    if (!result) return { atteint: false, dureeSecondes: elapsed(), dernier: veille.dernier }
    return { ...result, dureeSecondes: elapsed() }
  } finally {
    clearTimeout(echeance)
  }
}

export {
  sanitizeEntry,
  fetchDossier, patchDossier, validateDossier, fetchPayment, uploadDocument, submitCapitalDeposit,
  refreshDossier, updateDossier, waitForStatus, WAIT_TARGETS,
}
