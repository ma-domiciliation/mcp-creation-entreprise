import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Profil fondateur + préférences, stockés LOCALEMENT (jamais envoyés ailleurs qu'à
// ma-domiciliation, et seulement au moment d'ouvrir un dossier).
// Chemin : $MADOM_PROFILE_PATH ou ~/.madom/profil.json

const profilePath = () => process.env.MADOM_PROFILE_PATH || path.join(homedir(), '.madom', 'profil.json')

const readProfile = () => {
  const p = profilePath()
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

const writeProfile = profile => {
  const p = profilePath()
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(profile, null, 2), { mode: 0o600 })
  return p
}

const slugify = value => String(value || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)

// Une société = un compte ma-domiciliation (email unique). Pour créer plusieurs sociétés
// depuis un seul profil, l'email de chaque dossier est dérivé par alias : prenom+slug@domaine.
const aliasEmail = (email, socialDenomination) => {
  const [local, domain] = String(email).split('@')
  if (!domain) return email
  const base = local.split('+')[0]
  return `${base}+${slugify(socialDenomination)}@${domain}`
}

// Complète un dossier avec le profil : représentant, préférences, email alias par société.
const applyProfile = (args, profile) => {
  if (!profile) return args
  const filled = { ...args }
  const prefs = profile.preferences || {}

  if (!filled.representative && profile.representative) {
    filled.representative = { ...profile.representative }
  }
  if (filled.representative && profile.emailAliasPerCompany && filled.socialDenomination) {
    filled.representative = { ...filled.representative, email: aliasEmail(filled.representative.email, filled.socialDenomination) }
  }
  for (const key of ['addressId', 'juridicForm', 'paymentInterval', 'expeditionFrequency', 'expeditionAddress', 'socialCapital', 'nbEmployees']) {
    if (filled[key] === undefined && prefs[key] !== undefined) filled[key] = prefs[key]
  }
  return filled
}

export { profilePath, readProfile, writeProfile, applyProfile, aliasEmail, slugify }
