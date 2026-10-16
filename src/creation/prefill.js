// Pré-remplissage d'un dossier depuis le profil fondateur local (~/.madom/profil.json).
// Aucune valeur par défaut métier ici : les défauts viennent de l'API (applyDefaults → assumptions).
// Jamais `partners` depuis le profil (la question Dougs se pose au client, une fois, après le récap).

import { aliasEmail } from '../profile.js'

const isBlank = v => v === undefined || v === null || v === ''
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => !isBlank(v)))
const asAmount = v => (isBlank(v) ? undefined : String(v).replace(/\s/g, ''))

// Champs du profil `founder` → section `dirigeant` (renommages : address → ownerAddress,
// socialSecurityNumber → ownerScNumber ; email / tel repris de account).
const FOUNDER_TO_DIRIGEANT = {
  gender: 'gender', name: 'name', firstname: 'firstname', otherFirstnames: 'otherFirstnames', usageName: 'usageName',
  birthdate: 'birthdate', birthCity: 'birthCity', birthPostalCode: 'birthPostalCode', birthCountry: 'birthCountry',
  nationality: 'nationality', maritalStatus: 'maritalStatus',
  fatherName: 'fatherName', fatherFirstname: 'fatherFirstname', motherName: 'motherName', motherFirstname: 'motherFirstname',
  address: 'ownerAddress', socialSecurityNumber: 'ownerScNumber',
  healthInsuranceOrganism: 'healthInsuranceOrganism', hadPreviousNonSalariedActivity: 'hadPreviousNonSalariedActivity',
}

const FISCALITE_KEYS = ['exerciceMois', 'exerciceAnnee', 'regimeFiscalImpots', 'regimeFiscalImpotsDetail', 'regimeFiscalTva', 'tvaSurOption', 'tvaTrimestrielle', 'regimeMicroSocial']

// Email du compte pour une société : alias local+slug@domaine sauf emailAliasPerCompany: false.
const accountFor = (profile, socialDenomination, overrides = {}) => {
  const founder = profile?.founder || {}
  let email = overrides.email
  if (isBlank(email) && !isBlank(founder.email)) {
    email = profile.emailAliasPerCompany === false || isBlank(socialDenomination) ? founder.email : aliasEmail(founder.email, socialDenomination)
  }
  return compact({ email, tel: overrides.tel ?? founder.tel })
}

// Sections dérivées du profil (sans account ni societe) : dirigeant, siege, fiscalite, capital.
const profileToSections = (profile, { email, tel } = {}) => {
  const founder = profile?.founder || {}
  const prefs = profile?.preferences || {}
  const dirigeant = {}
  for (const [from, to] of Object.entries(FOUNDER_TO_DIRIGEANT)) {
    if (!isBlank(founder[from])) dirigeant[to] = founder[from]
  }
  if (!isBlank(email)) dirigeant.email = email
  if (!isBlank(tel ?? founder.tel)) dirigeant.tel = tel ?? founder.tel
  const siege = prefs.addressId
    ? compact({ siegeType: 'madomiciliation', domiciliationAddressId: prefs.addressId, paymentInterval: prefs.paymentInterval })
    : {}
  const fiscalite = compact(Object.fromEntries(FISCALITE_KEYS.map(k => [k, prefs[k]])))
  const capital = compact({
    ownerContributionAmount: asAmount(prefs.socialCapital),
    nominalShareValue: asAmount(prefs.nominalShareValue),
    ownerShareCapitalOrigins: Array.isArray(prefs.ownerShareCapitalOrigins) && prefs.ownerShareCapitalOrigins.length ? prefs.ownerShareCapitalOrigins : undefined,
    capitalDepositary: prefs.capitalDepositary,
    bankName: prefs.bankName,
  })
  const sections = {}
  if (Object.keys(dirigeant).length) sections.dirigeant = dirigeant
  if (Object.keys(siege).length) sections.siege = siege
  if (Object.keys(fiscalite).length) sections.fiscalite = fiscalite
  if (Object.keys(capital).length) sections.capital = capital
  return sections
}

// Fusion champ par champ : la valeur fournie prime sur le profil ; les listes sont prises telles quelles.
const mergeSection = (base = {}, override = {}) => {
  if (Array.isArray(override) || Array.isArray(base)) return override ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) if (v !== undefined) out[k] = v
  return out
}

// Corps de POST /dossiers : `dossier` (sections fournies par l'agent) complété par le profil.
// `utiliserProfil: false` ignore le profil (sauf pour rien : le dossier doit alors être autonome).
const buildCreateBody = (profile, dossier = {}, { utiliserProfil = true, applyDefaults = true } = {}) => {
  // `partners` est ignoré à la création : la question Dougs se pose après le récapitulatif (modifier_dossier).
  const { juridicForm, applyDefaults: _ignored, partners: _partners, attribution, account: accountOverride, ...sections } = dossier
  const prof = utiliserProfil ? profile : null
  const denomination = sections.societe?.socialDenomination
  const account = prof ? accountFor(prof, denomination, accountOverride || {}) : compact(accountOverride || {})
  const fromProfile = prof ? profileToSections(prof, { email: account.email, tel: account.tel }) : {}
  const body = { juridicForm: juridicForm ?? prof?.preferences?.juridicForm, applyDefaults: applyDefaults === true }
  if (Object.keys(account).length) body.account = account
  const keys = [...Object.keys(fromProfile), ...Object.keys(sections).filter(k => !(k in fromProfile))]
  for (const key of keys) {
    const merged = mergeSection(fromProfile[key], sections[key])
    if (merged !== undefined && (Array.isArray(merged) || Object.keys(merged).length)) body[key] = merged
  }
  // Le dirigeant d'un dossier sans profil garde email/tel du compte si l'agent ne les a pas donnés.
  if (body.dirigeant && account.email && isBlank(body.dirigeant.email)) body.dirigeant.email = account.email
  if (body.dirigeant && account.tel && isBlank(body.dirigeant.tel)) body.dirigeant.tel = account.tel
  if (attribution) body.attribution = { ...attribution }
  body.attribution = { utm_source: 'mcp', ...(body.attribution || {}) }
  return compact(body)
}

// Corps de POST /dossiers/validate pour vérifier les formats du profil seul.
const buildProfileValidationBody = profile => ({
  juridicForm: profile?.preferences?.juridicForm || 'SASU',
  ...profileToSections(profile, { email: profile?.founder?.email, tel: profile?.founder?.tel }),
})

export { accountFor, profileToSections, buildCreateBody, buildProfileValidationBody, mergeSection, FOUNDER_TO_DIRIGEANT, FISCALITE_KEYS }
