# madom-mcp — créez votre société depuis Claude Code

> **Serveur MCP pour créer une société en France (SASU, SAS, SARL, EURL, SCI) avec un siège chez
> [ma-domiciliation.fr](https://www.ma-domiciliation.fr), sans quitter votre assistant IA.**
> Client fin de l'API `/api/mcp-creation` du site : aucune règle métier, aucun montant, aucun secret dans ce dépôt.

```
Vous  : (dictée) On crée une SAS pour Pixie, une appli de coaching, avec Léa : 60/40.
Claude: Je peux chercher vos pièces d'identité et justificatifs de domicile sur votre disque ?
Vous  : Oui, vas-y.
Claude: Trouvés : 2 pièces d'identité, 2 justificatifs de domicile.
        Récapitulatif : SAS « Pixie », capital 1 000 € (600 / 400), IS, clôture au 31/12.
        On ajuste quelque chose ?
Vous  : C'est bon.
Claude: ✓ Dossier prêt, tout est pré-rempli.
        Réglez les frais légaux ici : ma-domiciliation.fr/creation-mcp/paiement/…
```

Le paiement, le choix du mot de passe, la vérification d'identité et la signature se font **sur le
site** : l'assistant ne saisit jamais une carte ni un mot de passe.

## Installation

Aucune clé, aucun compte préalable. Deux façons d'utiliser le serveur :

### 1. Serveur hébergé (recommandé) — rien à installer

```bash
claude mcp add --transport http ma-domiciliation https://mcp.ma-domiciliation.fr/mcp
```

Claude Desktop, Claude web ou ChatGPT : ajouter un connecteur MCP distant avec la même URL
`https://mcp.ma-domiciliation.fr/mcp`, sans authentification.

Le serveur hébergé est **sans état** : il ne stocke rien. Le jeton renvoyé à l'ouverture du dossier
identifie ce dossier pour la suite de la conversation ; l'assistant vous le donne une fois comme
**code de reprise** (gardez-le pour vous : il permet de reprendre le dossier dans une autre
conversation tant qu'il n'est pas payé). Après le paiement, vous terminez sur le site : mot de passe,
justificatifs, dépôt de capital, questionnaire et signature.

### 2. Serveur local (Node.js 20+) — fonctions complètes

```bash
claude mcp add ma-domiciliation -- npx -y @ma-domiciliation/mcp
```

Claude Desktop / Cursor / VS Code — `claude_desktop_config.json` (ou équivalent) :
```json
{
  "mcpServers": {
    "ma-domiciliation": { "command": "npx", "args": ["-y", "@ma-domiciliation/mcp"] }
  }
}
```

En local, le serveur tourne sur votre poste et garde un **profil fondateur** réutilisable
(`~/.madom/profil.json`), vos **pièces** (`~/.madom/kyc/`) et le registre de vos dossiers
(`~/.madom/societes.json`, jetons jamais affichés). Il envoie les pièces après paiement et choisit
le dépôt de capital ; il peut ouvrir les pages du site dans votre navigateur.

Dans les deux cas, le prompt `creer-ma-societe` lance le parcours guidé ; l'outil `guide_creation`
décrit le déroulé que suit l'assistant.
Le serveur transmet aussi, à l'initialisation, des instructions de posture : l'assistant s'adresse
à un client, sur un ton de conseiller, et ne fait jamais de remarque de QA, de test ou d'ordre
technique sur l'outil, l'API, le site ou la forme des réponses. Le guide et le prompt répètent cette règle.
Autre règle transmise de la même façon : tout ce que vous devez lire (lien de paiement, liens du site,
code de reprise) vous est donné dans un message complet qui termine le tour, jamais entre deux appels
d'outils (les clients MCP n'affichent pas ce texte de façon fiable). L'assistant ne sonde le paiement
qu'au tour suivant, quand vous dites avoir payé. En local, quand la page est ouverte par elicitation
URL (Claude Code), le serveur surveille lui-même le paiement ou le mot de passe en arrière-plan et clôt
l'elicitation dès qu'il le constate (`notifications/elicitation/complete`), ce qui libère l'attente
affichée par Claude Code ; l'assistant vérifie ensuite l'état avec `statut_dossier`. Cette surveillance
est unique par dossier et par événement : `statut_dossier attendre=…` et une nouvelle ouverture de la page
s'y rattachent au lieu de relancer une sonde.

## Le parcours

1. **`guide_creation`** — le déroulé : questions initiales, pièces à lire, siège, création, récapitulatif, paiement, suivi.
2. **Vos pièces** — l'assistant lit votre CNI ou passeport et votre justificatif de domicile **sur votre poste** et en extrait les champs ; le fichier n'est jamais transmis au serveur. Il lit les fichiers que vous lui désignez ; si une pièce manque, il vous **propose** de la chercher dans vos dossiers usuels (Téléchargements, Bureau, Documents, ou le dossier que vous indiquez) et ne le fait qu'avec votre accord : il ouvre alors les fichiers de ces dossiers pour reconnaître la pièce (même si le nom du fichier ne dit rien), vous dit ce qu'il a trouvé et attend votre confirmation avant de l'utiliser. En local, **`chercher_pieces`** liste ces fichiers sans en lire aucun. En local, **`enregistrer_profil_fondateur`** (une fois) et **`enregistrer_pieces_kyc`** les conservent pour toutes vos sociétés.
3. **`lister_centres`**, **`rechercher_activites`**, **`schema_dossier`**, **`devis_creation`** — référentiels et devis réel de l'API (lignes, montant du jour, récurrence, mois offerts). L'accompagnement à la création est offert : vous payez les frais légaux et, si vous prenez le siège, la domiciliation — mensuelle, annuelle, ou avec engagement 2 ou 3 ans (`paymentInterval` `month`, `year`, `2years`, `3years`), les cadences annuelles étant remisées sur la première échéance. Pour une domiciliation, `devis_creation` renvoie aussi `cadences`, le comparatif des quatre cadences (échéance et remise sur la première échéance), que l'agent détaille au client quand il annonce le prix. Le prix n'est pas annoncé dans les premiers échanges : il vient avec la proposition de siège, dans le récapitulatif, ou dès que le client le demande.
4. **`creer_societe`** — ouvre le dossier dès que forme, nom, email, téléphone et siège sont connus ; l'API complète avec les réponses les plus courantes (`assumptions`, annoncées au client). Les questions restantes sont posées dans la conversation (ou par formulaire avec **`completer_dossier`** en local) ; **`modifier_dossier`** envoie les corrections et la réponse à la question Dougs ; **`valider_dossier`** fait un essai à blanc ; **`statut_dossier`** donne l'état, le récapitulatif complet et les prochaines actions.
5. **`ouvrir_paiement`** : l'assistant termine sa réponse avec le lien exact (ou la page ouverte, en local) et attend votre retour ; `statut_dossier attendre=paiement` au tour suivant, quand vous dites avoir payé ou quand Claude Code signale la fin de la page. En local : **`ouvrir_mot_de_passe`**, puis **`envoyer_piece`** pour chaque pièce demandée (vérifiée par Netheos pour un dossier domicilié) et **`deposer_capital`** (Qonto ou banque). En hébergé : la suite se fait sur le site.
6. En local, **`mes_societes`** liste les dossiers ouverts depuis ce poste (nom, `publicToken`, statut, liens), sans secret.

Une société = un compte ma-domiciliation : chaque dossier reçoit un alias `prenom+nom-de-la-societe@…`. Un seul dossier non payé par email : un nouveau `creer_societe` sur l'email d'un dossier non payé le remplace (ancien jeton révoqué, ancien lien de paiement mort, warning `PENDING_SUPERSEDED`) ; c'est la voie de reprise quand le code est perdu.

### Outils par mode

| Outil | Hébergé | Local |
|---|---|---|
| `guide_creation`, `lister_centres`, `rechercher_activites`, `schema_dossier`, `devis_creation` | oui | oui |
| `valider_dossier`, `creer_societe`, `statut_dossier`, `modifier_dossier`, `ouvrir_paiement` | oui (paramètre `jeton`) | oui (paramètre `societe`) |
| `completer_dossier` (formulaires d'elicitation) | — | oui |
| `enregistrer_profil_fondateur`, `voir_profil_fondateur`, `enregistrer_pieces_kyc`, `chercher_pieces`, `mes_societes` | — | oui |
| `ouvrir_mot_de_passe`, `envoyer_piece`, `deposer_capital` | — (sur le site) | oui |

## Ce que ce serveur ne fait pas — volontairement

- Il **ne paie pas, ne choisit pas de mot de passe, ne signe pas, ne passe pas la vérification d'identité** à votre place. La domiciliation est une activité réglementée (agrément préfectoral, LCB-FT) : ces actes restent les vôtres, sur les pages sécurisées du site.
- Il ne crée **rien de définitif** avant votre paiement.
- Il **n'explore pas votre poste sans votre accord** : la recherche d'une pièce manquante vous est proposée, ne commence qu'après votre oui, reste dans les dossiers convenus, et rien n'est utilisé sans vous l'avoir montré.
- Il n'embarque **aucun montant, aucun catalogue, aucune règle métier** : tout vient de l'API.
- Le serveur hébergé ne journalise ni les jetons ni le contenu des dossiers.
- La micro-entreprise et le transfert de siège ne sont pas couverts.

## Variables d'environnement

Aucune n'est nécessaire : les valeurs par défaut conviennent.

| Variable | Rôle | Défaut |
|---|---|---|
| `MADOM_API_BASE_URL` | Base de l'API de création | `https://www.ma-domiciliation.fr/api/mcp-creation` |
| `MADOM_PROFILE_PATH` / `MADOM_KYC_DIR` / `MADOM_REGISTRY_PATH` | Fichiers locaux (mode local) | `~/.madom/profil.json`, `~/.madom/kyc/`, `~/.madom/societes.json` |
| `MADOM_NO_BROWSER` | `1` : ne jamais ouvrir le navigateur (mode local, tests) | — |

Elles se posent dans la configuration du client MCP (option `-e` de `claude mcp add`, ou le champ `env`
du bloc `mcpServers`), pas dans le shell.

Licence MIT — © SOURCE SAS. Le nom et le logo ma-domiciliation sont des marques de SOURCE SAS et ne sont
pas couverts par cette licence.
