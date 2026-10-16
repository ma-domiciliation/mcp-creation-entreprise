// Recherche de justificatifs sur le poste du client (outil chercher_pieces, mode local), après son
// accord explicite. Parcours borné des dossiers usuels, filtre sur le format réel seulement (PDF, JPEG,
// PNG d'après les premiers octets) ; le nom de fichier ne fait que trier (motifs : `candidats` en tête,
// les autres dans `autres`). Aucun contenu n'est lu au-delà de ces octets, rien n'est copié ni envoyé :
// la reconnaissance de la pièce se fait ensuite par l'assistant, qui ouvre les fichiers listés.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { sniffFormat, kycDir } from './kyc.js'

const DOSSIERS_PAR_DEFAUT = ['Downloads', 'Téléchargements', 'Desktop', 'Bureau', 'Documents']

// Motifs de tri sur le nom du fichier (insensibles à la casse, accents tolérés par les classes).
const MOTIFS_PAR_DEFAUT = [
  'cni', 'carte.?d.?identit', 'identit', 'passeport', 'passport', 'titre.?de.?s[ée]jour',
  'justificatif', 'domicile', 'facture', 'quittance', 'edf', 'engie', 'free', 'orange', 'sfr', 'bouygues',
  'avis.?d.?imposition', 'attestation', 'kbis', 'statuts',
]

const DOSSIERS_IGNORES = ['node_modules', 'Library', '.Trash']
const PROFONDEUR_DEFAUT = 3
const LIMITE_DEFAUT = 20
const PLAFOND_ENTREES = 5000

const expand = p => path.resolve(String(p).replace(/^~(?=$|\/)/, homedir()))

// Format réel d'après les 8 premiers octets, sans lire le reste du fichier.
const formatReel = file => {
  let fd
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(8)
    const n = readSync(fd, buffer, 0, 8, 0)
    return sniffFormat(buffer.subarray(0, n))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Les motifs fournis par l'agent sont du texte simple (métacaractères échappés, longueur bornée) : aucune
// expression régulière venue de l'extérieur n'est compilée. Les motifs par défaut gardent leur syntaxe regex.
const echapper = s => String(s).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const compileMotifs = (motifs, { litteraux = false } = {}) => (motifs || []).map(m => {
  try { return { motif: m, re: new RegExp(litteraux ? echapper(m) : m, 'i') } } catch { return null }
}).filter(Boolean)

// chercherPieces({ dossiers?, motifs?, profondeur?, limite? })
// → { dossiers, dossiersEcartes: [{ chemin, raison }], candidats: [{ chemin, nom, format, taille, modifieLe, motif }], autres: [{ chemin, nom, format, taille, modifieLe }],
//     candidatsTronques, autresTronques (listes coupées à `limite`, les plus récents gardés), parcoursInterrompu, entreesVisitees }
const chercherPieces = ({ dossiers, motifs, profondeur = PROFONDEUR_DEFAUT, limite = LIMITE_DEFAUT } = {}) => {
  const exclus = [expand(kycDir()), path.join(homedir(), '.madom')]
  // Un dossier indiqué par le client est accepté tel quel (iCloud Drive sous ~/Library, dossier caché…) :
  // seules les exclusions de sécurité s'appliquent aux racines (racine du disque, ~/.madom et le store KYC,
  // même indiqués explicitement), chacune signalée dans dossiersEcartes. Un dossier absent ou illisible est écarté
  // sans raison détaillée. Les dossiers cachés et ignorés ne le sont que pendant le parcours des sous-dossiers.
  const sousExclu = d => exclus.some(x => d === x || d.startsWith(x + path.sep))
  const estDossier = d => { try { return statSync(d).isDirectory() } catch { return false } }
  const raisonRefus = d => {
    if (d === path.parse(d).root) return 'racine du disque : indiquer un dossier précis'
    if (sousExclu(d)) return 'dossier réservé à l\'assistant (pièces déjà enregistrées)'
    if (!estDossier(d)) return 'dossier introuvable ou illisible'
    return null
  }
  const explicites = dossiers?.length
  const racines = []
  const dossiersEcartes = []
  for (const d of (explicites ? dossiers.map(expand) : DOSSIERS_PAR_DEFAUT.map(d => path.join(homedir(), d)))) {
    if (racines.includes(d) || dossiersEcartes.some(e => e.chemin === d)) continue
    const raison = raisonRefus(d)
    if (!raison) racines.push(d)
    else if (explicites) dossiersEcartes.push({ chemin: d, raison })
  }
  const regles = motifs?.length ? compileMotifs(motifs, { litteraux: true }) : compileMotifs(MOTIFS_PAR_DEFAUT)
  const maxDepth = Math.max(1, Math.min(Number(profondeur) || PROFONDEUR_DEFAUT, 6))
  const candidats = []
  const autres = []
  let visitees = 0
  let plafondAtteint = false

  const ignorer = (dir, name) => name.startsWith('.') || DOSSIERS_IGNORES.includes(name) || exclus.includes(path.join(dir, name))

  const walk = (dir, depth) => {
    if (plafondAtteint) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (visitees >= PLAFOND_ENTREES) { plafondAtteint = true; return }
      visitees += 1
      if (ignorer(dir, e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const format = formatReel(full)
      if (!format) continue
      let st
      try { st = statSync(full) } catch { continue }
      const fiche = { chemin: full, nom: e.name, format, taille: st.size, modifieLe: st.mtime.toISOString() }
      const regle = regles.find(r => r.re.test(e.name))
      if (regle) candidats.push({ ...fiche, motif: regle.motif })
      else autres.push(fiche)
    }
  }

  for (const racine of racines) walk(racine, 1)
  const recentsDAbord = (a, b) => b.modifieLe.localeCompare(a.modifieLe)
  candidats.sort(recentsDAbord)
  autres.sort(recentsDAbord)
  const max = Math.max(1, Math.min(Number(limite) || LIMITE_DEFAUT, 100))
  return {
    dossiers: racines,
    dossiersEcartes,
    candidats: candidats.slice(0, max),
    autres: autres.slice(0, max),
    candidatsTronques: candidats.length > max,
    autresTronques: autres.length > max,
    parcoursInterrompu: plafondAtteint,
    entreesVisitees: visitees,
  }
}

export { chercherPieces, DOSSIERS_PAR_DEFAUT, MOTIFS_PAR_DEFAUT }
