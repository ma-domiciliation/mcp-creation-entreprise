// Montage des outils de création de société (client de l'API /api/mcp-creation du site).

import { registerProfilTools } from './tools-profil.js'
import { registerReferenceTools } from './tools-reference.js'
import { registerDossierTools } from './tools-dossier.js'
import { registerSiteTools } from './tools-site.js'
import { registerPiecesTools } from './tools-pieces.js'

// registerCreationTools(server, store) : le store (src/creation/store.js) porte l'état hors API.
const registerCreationTools = (server, store) => {
  registerProfilTools(server, store)
  registerReferenceTools(server)
  registerDossierTools(server, store)
  registerSiteTools(server, store)
  // Pièces et dépôt de capital : mode local seulement (fichiers du poste) ; en hébergé, la fin du
  // tunnel après paiement se fait sur le site.
  if (store.mode === 'local') registerPiecesTools(server, store)
}

export { registerCreationTools }
