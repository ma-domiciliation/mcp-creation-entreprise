// Limites par IP du serveur hébergé : fenêtres glissantes en mémoire (un conteneur, comme le site).
// Trois compteurs : requests (HTTP, par minute), creations (creer_societe abouties, par heure),
// unauthorized (jetons refusés par l'API, par 10 min). Interface utilisée par le store hébergé :
//   peek(bucket, key) → { allowed, retryAfter }   (sans enregistrer)
//   hit(bucket, key)  → { allowed, retryAfter }   (enregistre si autorisé)
// Map : clés dynamiques (bucket:ip) créées et purgées en continu.

const WINDOWS_MS = { requests: 60_000, creations: 3_600_000, unauthorized: 600_000 }
const DEFAULT_LIMITS = { requests: 120, creations: 10, unauthorized: 20 }
const CLEANUP_EVERY_MS = 60_000

const envInt = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

// Seuils depuis l'environnement (0 = bloqué d'office, utile seulement en test).
const limitsFromEnv = () => ({
  requests: envInt('MADOM_LIMIT_REQUESTS_PER_MINUTE', DEFAULT_LIMITS.requests),
  creations: envInt('MADOM_LIMIT_CREATIONS_PER_HOUR', DEFAULT_LIMITS.creations),
  unauthorized: envInt('MADOM_LIMIT_UNAUTHORIZED_PER_10MIN', DEFAULT_LIMITS.unauthorized),
})

const createLimiter = (limits = limitsFromEnv(), { now = Date.now } = {}) => {
  const entries = new Map() // `${bucket}:${key}` → tableau d'horodatages (ms)

  const window = bucket => {
    const ms = WINDOWS_MS[bucket]
    if (!ms) throw new Error(`Compteur inconnu « ${bucket} »`)
    return ms
  }

  const recent = (bucket, key) => {
    const id = `${bucket}:${key ?? 'inconnu'}`
    const floor = now() - window(bucket)
    const kept = (entries.get(id) || []).filter(t => t > floor)
    if (kept.length) entries.set(id, kept)
    else entries.delete(id)
    return { id, kept }
  }

  const status = (bucket, kept) => {
    const limit = limits[bucket] ?? DEFAULT_LIMITS[bucket]
    if (kept.length < limit) return { allowed: true, retryAfter: 0 }
    const retryAfter = Math.max(1, Math.ceil((kept[0] + window(bucket) - now()) / 1000))
    return { allowed: false, retryAfter }
  }

  const peek = (bucket, key) => status(bucket, recent(bucket, key).kept)

  const hit = (bucket, key) => {
    const { id, kept } = recent(bucket, key)
    const result = status(bucket, kept)
    if (result.allowed) entries.set(id, [...kept, now()])
    return result
  }

  const cleanup = () => {
    for (const id of entries.keys()) {
      const [bucket] = id.split(':')
      if (WINDOWS_MS[bucket]) recent(bucket, id.slice(bucket.length + 1))
    }
  }
  const timer = setInterval(cleanup, CLEANUP_EVERY_MS)
  timer.unref?.()

  return { peek, hit, cleanup, limits, stop: () => clearInterval(timer), size: () => entries.size }
}

export { createLimiter, limitsFromEnv, DEFAULT_LIMITS, WINDOWS_MS }
