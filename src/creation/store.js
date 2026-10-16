// Store : ce que les outils « dossier » savent de l'état hors API. Deux implémentations :
// - localStore()  : registre ~/.madom (jeton par dossier, jamais affiché) + profil fondateur ;
// - hostedStore() : serveur hébergé, sans état ; le jeton `mcc_` est l'identité, donné par l'agent
//                   dans le paramètre `jeton` de chaque outil (code de reprise remis au client).
// Interface commune :
//   mode                  'local' | 'distant'
//   dossierParam          fragment de inputSchema désignant le dossier (`societe` ou `jeton`)
//   optionalDossierParam  même chose, facultatif (valider_dossier)
//   hasRef(args)          → true si args désigne un dossier existant
//   resolve(args)         → entrée { token, publicToken, socialDenomination, … } (jamais de choix implicite)
//   remember(entry, d)    → met l'entrée à jour depuis une réponse dossier (mutation ; persistance en local)
//   invalidate(entry, err)→ réaction à un 401 (jeton refusé)
//   profile()             → profil fondateur ou null
//   clientIp              → IP du client final transmise à l'API (null en local)
//   limiter               → limites par IP du serveur hébergé (hit / peek), sans effet en local

import { z } from 'zod'

import { LocalError } from './run.js'
import { readProfile } from '../profile.js'
import {
  findSocietes, readRegistry, upsertSociete, entryFromDossier, markTokenInvalid, listing, TOKEN_PREFIX,
} from '../app/registry.js'

const TOKEN_REGEX = /^mcc_[A-Za-z0-9_-]{43}$/

const notBlank = value => typeof value === 'string' && value.trim() !== ''

const chooseMessage = societes =>
  `Plusieurs dossiers correspondent : préciser le paramètre societe (dénomination ou publicToken) parmi :\n${JSON.stringify(listing(societes), null, 2)}`

// Résolution par le registre local : publicToken exact, puis dénomination (slug).
const resolveFromRegistry = ref => {
  if (typeof ref === 'string' && ref.trim().startsWith(TOKEN_PREFIX)) {
    throw new LocalError('Ne transmettez jamais le jeton de dossier : désigner la société par sa dénomination ou son publicToken (voir mes_societes).')
  }
  const found = findSocietes(ref)
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new LocalError(chooseMessage(found))
  const { societes, ignored } = readRegistry()
  if (!societes.length) {
    throw new LocalError('Aucun dossier de création connu sur ce poste : commencer par creer_societe.' +
      (ignored.length ? ` (${ignored.length} entrée(s) d'une ancienne version ignorée(s).)` : ''))
  }
  throw new LocalError(`Aucun dossier ne correspond à « ${ref} ». Dossiers connus :\n${JSON.stringify(listing(societes), null, 2)}`)
}

// Champs d'une entrée recalculés depuis une réponse dossier (sans écraser par null).
const freshFields = (entry, dossier) => {
  const fresh = entryFromDossier(entry.token, dossier)
  const update = {}
  for (const [key, value] of Object.entries(fresh)) {
    if (key !== 'token' && value !== null && value !== undefined) update[key] = value
  }
  return update
}

const societeSchema = z.string().optional().describe('Dénomination ou publicToken du dossier (mes_societes) ; facultatif s\'il n\'y a qu\'un dossier sur ce poste')

const localStore = () => ({
  mode: 'local',
  dossierParam: { societe: societeSchema },
  optionalDossierParam: { societe: societeSchema },
  hasRef: ({ societe } = {}) => notBlank(societe),
  resolve: ({ societe } = {}) => resolveFromRegistry(societe),
  remember: (entry, dossier) => {
    const update = freshFields(entry, dossier)
    Object.assign(entry, update)
    return upsertSociete({ token: entry.token, ...update })
  },
  invalidate: entry => markTokenInvalid(entry.token),
  profile: () => readProfile(),
  clientIp: null,
  limiter: null,
})

// Limiteur neutre (serveur hébergé sans limites configurées, ou vérifications à la main).
const unlimited = { hit: () => ({ allowed: true, retryAfter: 0 }), peek: () => ({ allowed: true, retryAfter: 0 }) }

const retryText = seconds => (seconds ? `${Math.ceil(seconds / 60)} min` : 'quelques minutes')

const jetonSchema = z.string().describe('Jeton du dossier (mcc_…) renvoyé par creer_societe : identifie le dossier pour tous les outils')

const hostedStore = ({ clientIp = null, limiter = unlimited } = {}) => ({
  mode: 'distant',
  dossierParam: { jeton: jetonSchema },
  optionalDossierParam: { jeton: jetonSchema.optional() },
  hasRef: ({ jeton } = {}) => notBlank(jeton),
  resolve: ({ jeton } = {}) => {
    if (!notBlank(jeton) || !TOKEN_REGEX.test(jeton.trim())) {
      throw new LocalError('Jeton de dossier manquant ou mal formé : passer dans `jeton` la valeur exacte renvoyée par creer_societe (ou le code de reprise conservé par le client).')
    }
    const gate = limiter.peek('unauthorized', clientIp)
    if (!gate.allowed) {
      throw new LocalError(`Trop de jetons inconnus depuis cette adresse : réessayer dans ${retryText(gate.retryAfter)}.`, { error: 'RATE_LIMITED_LOCAL', retryAfter: gate.retryAfter })
    }
    return { token: jeton.trim(), publicToken: null, socialDenomination: null }
  },
  remember: (entry, dossier) => Object.assign(entry, freshFields(entry, dossier)),
  invalidate: (entry, err) => {
    limiter.hit('unauthorized', clientIp)
    if (err) err.hint = 'Jeton de dossier inconnu ou révoqué. Vérifier la valeur de `jeton` (renvoyée par creer_societe, ou code de reprise du client) ; sinon recommencer avec creer_societe.'
  },
  profile: () => null,
  clientIp,
  limiter,
})

export { localStore, hostedStore, resolveFromRegistry, freshFields, unlimited, TOKEN_REGEX }
