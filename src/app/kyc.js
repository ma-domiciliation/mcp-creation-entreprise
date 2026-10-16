import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

// Dossier KYC local : ~/.madom/kyc/ (0700). Chaque pièce est conservée dans son format d'origine
// (`<kind>.<pdf|jpeg|png>`, 0600) avec son type de document dans `index.json`
// ({ kind: { file, ext, documentType?, registeredAt } }). La conversion en PDF ne se fait qu'à
// l'envoi, si la pièce demandée par l'API n'accepte que le PDF (prepareUpload). Les pièces sont
// réutilisables d'une société à l'autre et ne sortent du poste qu'avec envoyer_piece.
//
// Deux familles : le dirigeant (`identite_recto`, …) et les associés (`associe_<n>_identite_recto`,
// `associe_<n>_kbis`, …), n = rang de l'associé dans `associes` (1, 2, …).
const FOUNDER_KINDS = {
  identite_recto: { label: 'Pièce d\'identité du dirigeant — recto (CNI, passeport ou titre de séjour) ; documentType conseillé (ID_CARD, PASSPORT…)', justifKeys: ['owner_id_justif_file'] },
  identite_verso: { label: 'Pièce d\'identité du dirigeant — verso (CNI ou titre de séjour ; inutile pour un passeport)', justifKeys: ['owner_id_justif_file_2'] },
  justificatif_domicile: { label: 'Justificatif de domicile du dirigeant (< 3 mois) ; documentType conseillé (ex. PROVIDER_INVOICE_OR_SCHEDULE)', justifKeys: ['owner_address_justif_file', 'siege_current_address_justif'] },
  statuts_signes: { label: 'Statuts signés — seulement si vous fournissez vos propres statuts', justifKeys: ['statuts_file'] },
  diplome_ou_agrement: { label: 'Diplôme / carte pro / agrément — seulement si activité réglementée', justifKeys: ['regulated_activity_proof_file'] },
}
const ASSOCIE_KINDS = {
  identite_recto: { label: 'Pièce d\'identité de l\'associé — recto (ou du représentant légal si personne morale)', column: 'id_justif_file' },
  identite_verso: { label: 'Pièce d\'identité de l\'associé — verso', column: 'id_justif_file_2' },
  kbis: { label: 'Kbis < 3 mois de la société associée (personne morale)', column: 'kbis_file' },
}
const ASSOCIE_RE = /^associe_(\d+)_(identite_recto|identite_verso|kbis)$/
const MAX_BYTES = 20 * 1024 * 1024
const INDEX_FILE = 'index.json'
const CONTENT_TYPES = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png' }

const kycDir = () => process.env.MADOM_KYC_DIR || path.join(homedir(), '.madom', 'kyc')

const describeKinds = () => [
  ...Object.entries(FOUNDER_KINDS).map(([k, v]) => `${k} = ${v.label}`),
  ...Object.entries(ASSOCIE_KINDS).map(([k, v]) => `associe_<n>_${k} = ${v.label}`),
]

const isValidKind = kind => !!FOUNDER_KINDS[kind] || ASSOCIE_RE.test(kind)

// Format réel d'après les premiers octets (l'extension du fichier ne fait pas foi).
const sniffFormat = buffer => {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  return null
}

// Lit et valide un fichier à envoyer : { path, ext ('pdf' | 'jpeg' | 'png'), buffer }.
const readDocument = sourcePath => {
  const resolved = path.resolve(String(sourcePath).replace(/^~(?=$|\/)/, homedir()))
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`Fichier introuvable : ${sourcePath}`)
  if (statSync(resolved).size > MAX_BYTES) throw new Error('Fichier trop volumineux (20 Mo maximum)')
  const buffer = readFileSync(resolved)
  const ext = sniffFormat(buffer)
  if (!ext) throw new Error('Format non reconnu : seuls PDF, JPEG et PNG sont acceptés (une photo HEIC ou WebP doit être convertie avant)')
  return { path: resolved, ext, buffer }
}

// Photo → PDF une page (JPEG/PNG), sans dépendance native.
const imageToPdf = async (buffer, ext) => {
  const pdf = await PDFDocument.create()
  const image = ext === 'png' ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer)
  const page = pdf.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  return Buffer.from(await pdf.save())
}

const indexPath = () => path.join(kycDir(), INDEX_FILE)

const readIndex = () => {
  const p = indexPath()
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) || {} } catch { return {} }
}

const writeIndex = index => {
  mkdirSync(kycDir(), { recursive: true, mode: 0o700 })
  writeFileSync(indexPath(), JSON.stringify(index, null, 2), { mode: 0o600 })
  try { chmodSync(indexPath(), 0o600) } catch { /* Windows : sans effet */ }
}

// Enregistre une pièce : copie dans son format d'origine, type de document mémorisé.
const registerKycFile = (kind, sourcePath, { documentType } = {}) => {
  if (!isValidKind(kind)) throw new Error(`Type de pièce inconnu : ${kind}. Types : ${describeKinds().join(' ; ')}`)
  const { buffer, ext } = readDocument(sourcePath)
  mkdirSync(kycDir(), { recursive: true, mode: 0o700 })
  const file = `${kind}.${ext}`
  const dest = path.join(kycDir(), file)
  writeFileSync(dest, buffer, { mode: 0o600 })
  try { chmodSync(dest, 0o600) } catch { /* Windows */ }
  // Une version précédente dans un autre format est retirée.
  for (const other of Object.keys(CONTENT_TYPES).filter(e => e !== ext)) {
    const stale = path.join(kycDir(), `${kind}.${other}`)
    if (existsSync(stale)) unlinkSync(stale)
  }
  const index = readIndex()
  const previous = index[kind] || {}
  index[kind] = { file, ext, registeredAt: new Date().toISOString() }
  const type = documentType === undefined ? previous.documentType : documentType
  if (type) index[kind].documentType = type
  writeIndex(index)
  return { kind, path: dest, ...index[kind] }
}

// Liste des pièces : index.json, complété par d'éventuels `<kind>.pdf` d'une ancienne version.
const listKycFiles = () => {
  const dir = kycDir()
  if (!existsSync(dir)) return []
  const index = readIndex()
  const entries = Object.entries(index)
    .filter(([, v]) => v?.file && existsSync(path.join(dir, v.file)))
    .map(([kind, v]) => ({ kind, path: path.join(dir, v.file), ext: v.ext, documentType: v.documentType ?? null, registeredAt: v.registeredAt ?? null }))
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.pdf$/.exec(f)
    if (m && isValidKind(m[1]) && !index[m[1]]) entries.push({ kind: m[1], path: path.join(dir, f), ext: 'pdf', documentType: null, registeredAt: null })
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind))
}

const kycFileForKind = kind => listKycFiles().find(e => e.kind === kind) || null

// Kind local pour une clé de pièce de l'API : `owner_id_justif_file`, `siege_current_address_justif`,
// ou `shareholder:<i>:<colonne>` (i 0-based côté site = associé n° i+1 côté MCP).
const kindForJustifKey = justifKey => {
  const sh = /^shareholder:(\d+):(id_justif_file|id_justif_file_2|kbis_file)$/.exec(justifKey)
  if (sh) {
    const suffix = Object.entries(ASSOCIE_KINDS).find(([, v]) => v.column === sh[2])?.[0]
    return suffix ? `associe_${Number(sh[1]) + 1}_${suffix}` : null
  }
  return Object.entries(FOUNDER_KINDS).find(([, v]) => v.justifKeys.includes(justifKey))?.[0] || null
}

const kycFileForJustifKey = justifKey => {
  const kind = kindForJustifKey(justifKey)
  return kind ? kycFileForKind(kind) : null
}

// Prépare l'envoi d'une pièce ({ path, ext } ou { buffer, ext }) selon les formats acceptés par l'item :
// une image est convertie en PDF seulement si l'item n'accepte pas son format.
// → { buffer, filename, contentType, converted }
const prepareUpload = async (doc, formats) => {
  const accepted = Array.isArray(formats) && formats.length ? formats.map(f => String(f).toLowerCase().replace(/^jpg$/, 'jpeg')) : ['pdf']
  const buffer = doc.buffer || readFileSync(doc.path)
  const ext = doc.ext || sniffFormat(buffer)
  const base = doc.kind || (doc.path ? path.basename(doc.path, path.extname(doc.path)) : 'piece')
  if (accepted.includes(ext)) return { buffer, filename: `${base}.${ext}`, contentType: CONTENT_TYPES[ext], converted: false }
  if (ext !== 'pdf' && accepted.includes('pdf')) {
    return { buffer: await imageToPdf(buffer, ext), filename: `${base}.pdf`, contentType: CONTENT_TYPES.pdf, converted: true }
  }
  throw new Error(`Format ${ext} refusé pour cette pièce (formats acceptés : ${accepted.join(', ')})`)
}

export {
  FOUNDER_KINDS, ASSOCIE_KINDS, kycDir, describeKinds, isValidKind, sniffFormat, readDocument, imageToPdf,
  registerKycFile, listKycFiles, kycFileForKind, kindForJustifKey, kycFileForJustifKey, prepareUpload,
}
