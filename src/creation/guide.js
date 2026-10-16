// Guide d'intake suivi par l'agent du client (outil guide_creation) et texte du prompt creer-ma-societe.
// Principe : poser le minimum de questions, lire les documents, laisser l'API poser les défauts
// (applyDefaults → assumptions) et annoncer le devis réel (devis_creation) une fois le projet cerné, avec le
// détail des cadences (remise sur la première échéance). Aucun montant ni pourcentage ici.
// Deux variantes : 'local' (profil fondateur, pièces KYC, fin du tunnel dans le MCP) et 'distant'
// (serveur hébergé, sans état : jeton = code de reprise, tout se passe sur le site après paiement).

const PRINCIPE = 'Poser le minimum de questions. Tout ce qui peut être lu dans un document ou pris par défaut par l\'API ' +
  '(réponses de 90 % des créateurs, renvoyées dans assumptions) ne se demande pas : on l\'annonce dans le récapitulatif et le client corrige. ' +
  'Les statuts sont rédigés par les formalistes de ma-domiciliation.fr, jamais par l\'assistant.'

// Posture envers le client : texte unique, repris dans les instructions serveur, le guide (clé posture
// et interdits) et le prompt. Valable dans les deux modes : ne cite aucun outil réservé au mode local.
const POSTURE = 'L\'assistant s\'adresse à un client de ma-domiciliation.fr, jamais à l\'équipe technique : ton professionnel de conseiller, centré sur le projet du client. ' +
  'Aucune remarque de QA, de test, de relecture ou d\'ordre technique sur l\'outil, l\'API, le site ou la forme des réponses (ponctuation, libellé, format d\'un champ), ' +
  'ni en fin de message, ni en aparté, ni « au passage ». Un résultat imparfait sur la forme ne se commente pas ; une incohérence sur le fond donne lieu à une question au client, ' +
  'formulée sans parler de l\'outil. Sur une erreur bloquante, dire au client quoi faire (réessayer, terminer sur le site, contacter ma-domiciliation.fr), sans diagnostic ni jargon.'

// Remise au client : un client MCP n'affiche pas de façon fiable le texte écrit entre deux appels
// d'outils. Tout ce que le client doit lire se donne donc dans le message qui termine le tour, et le
// sondage (statut_dossier attendre=…) ne commence qu'au tour suivant. Texte repris dans les instructions
// serveur, le guide (clé remise_au_client), les résultats d'ouvrir_paiement et la consigne du jeton.
const REMISE_AU_CLIENT = 'Tout ce que le client doit lire (lien de paiement, liens passwordPage et customerArea, code de reprise) se donne dans un message final : ' +
  'terminer la réponse avec ce contenu exact et les étapes suivantes, sans appeler d\'autre outil dans le même tour, car le texte écrit entre deux appels d\'outils ' +
  'n\'est pas affiché de façon fiable au client. Ne jamais sonder (statut_dossier attendre=…) dans le tour qui transmet un lien : attendre le tour suivant, ' +
  'quand le client dit avoir payé ou être sur la page.'

const SERVER_INSTRUCTIONS = 'Serveur MCP de ma-domiciliation.fr : création de société pour un client. Appeler guide_creation en premier et suivre son déroulé. ' + POSTURE + ' ' + REMISE_AU_CLIENT

const QUESTION_NOM = 'Quel nom pour la société, et que fait-elle (une phrase) ? → rechercher_activites pour trouver la rédaction du catalogue ; chaque activité envoyée porte { redaction, custom, reglementee } (une activité libre sans reglementee reste une question ouverte).'
const QUESTION_ASSOCIES = 'Combien d\'associés en plus de vous ? Pour chacun : personne physique ou personne morale (société) ?'
const QUESTION_PROFIL = 'Avez-vous déjà un profil fondateur enregistré sur ce poste ? (voir_profil_fondateur ; sinon → étape 2)'
const QUESTION_SIEGE = 'Siège : chez ma-domiciliation (lister_centres pour choisir le centre ; cadence paymentInterval = month (mensuel), year (1 an), 2years ou 3years (engagement 2 ou 3 ans) : ' +
  'la cadence se choisit avec le prix, à l\'étape 3) ou à une autre adresse (étape 3).'

const REGLE_FORME = 'Seul → SASU (ou EURL si préférence). Plusieurs associés → SAS (ou SARL). SCI seulement pour un projet immobilier. ' +
  'Les formes possibles sont celles de l\'API (schema_dossier).'
// Prix : jamais dans les premiers échanges (tant que le projet n'est pas cerné), toujours avec le détail des cadences.
const PRIX_MOMENT = 'Ne pas parler du prix tant que le projet n\'est pas cerné (nom, activité, associés, forme, siège) : les premiers messages servent à comprendre le projet et à poser les questions initiales, sans montant. ' +
  'Le prix s\'annonce au moment de proposer le siège (étape 3), dans le récapitulatif, ou dès que le client le demande.'
const PRIX = 'Annoncer le prix réel avec devis_creation (juridicForm, product domiciliation | basic, paymentInterval month | year | 2years | 3years) : ' +
  'l\'accompagnement à la création est offert, le client paie les frais légaux et, s\'il prend le siège, la domiciliation ; montant dû aujourd\'hui, ' +
  'récurrence, mois offerts et remise sur la première échéance viennent du devis. ' +
  'En l\'annonçant pour une domiciliation, détailler les cadences d\'après `cadences` du devis : mensuel sans remise, puis annuel, 2 ans et 3 ans avec, pour chacun, ' +
  'le pourcentage de remise sur la première échéance et le montant de l\'échéance. Ne jamais citer un montant ni un pourcentage qui n\'en vient pas.'

// Recherche de pièces sur le poste : proposée au client, jamais faite sans son accord explicite.
const RECHERCHE_PIECES = 'Lire les fichiers que le client désigne (chemin ou pièce jointe). Si une pièce manque, PROPOSER au client de la chercher sur son poste ' +
  '(dossiers usuels : Téléchargements, Bureau, Documents, ou le dossier qu\'il indique) et ne chercher qu\'après son accord explicite dans la conversation. ' +
  'Avec son accord, ouvrir les fichiers PDF/JPEG/PNG de ces dossiers pour reconnaître la pièce, même si le nom du fichier ne dit rien (nom évocateur d\'abord, puis les plus récents), ' +
  'et s\'arrêter dès qu\'elle est trouvée. Dire au client ce qui a été trouvé (fichier, nature, date) et attendre sa confirmation courte avant de l\'utiliser. ' +
  'Jamais hors des dossiers convenus. Sans accord, ou sans résultat, demander la pièce dans la conversation.'
const FICHIERS_DESIGNES_LOCAL = RECHERCHE_PIECES + ' La liste des fichiers vient de chercher_pieces (accordDuClient: true), qui ne lit aucun fichier ; la reconnaissance se fait en ouvrant les fichiers listés.'
const FICHIERS_DESIGNES_DISTANT = RECHERCHE_PIECES + ' La recherche se fait avec les outils de fichiers de l\'assistant, s\'il en a, dans ces dossiers seulement, en ouvrant les fichiers pour les reconnaître.'

const PIECES = {
  dirigeant: ['CNI recto + verso, ou passeport (recto seul), ou titre de séjour', 'justificatif de domicile < 3 mois (toujours : exigé pour la vérification d\'identité du dossier domicilié comme pour un siège au domicile)'],
  associe_personne_physique: ['CNI recto + verso (ou passeport)'],
  associe_personne_morale: ['Kbis < 3 mois', 'statuts de la société associée (représentant légal, siège)', 'CNI du représentant légal'],
}

const EXTRACTION = {
  cni_ou_passeport: { gender: 'MR si sexe M, MME si F', name: 'NOM (nom de naissance ; si « usage » indiqué → usageName)', firstname: 'premier prénom', otherFirstnames: 'autres prénoms séparés par des virgules', birthdate: 'JJ/MM/AAAA', birthCity: 'lieu de naissance (ville)', birthPostalCode: 'code postal de la ville de naissance — déduire du département/ville si absent du document', birthCountry: 'France sauf mention contraire', nationality: 'ex. Française', address: 'adresse au verso de la CNI si présente, sinon depuis le justificatif de domicile' },
  justificatif_domicile: { address: 'adresse complète : rue, code postal, ville' },
  kbis: { socialDenomination: 'dénomination', juridicForm: 'forme juridique', siren: '9 chiffres', socialSiege: 'adresse du siège', representativeName: 'nom du représentant légal', representativeFirstname: 'prénom du représentant légal', registrationCountry: 'France' },
  statuts: { socialDenomination: 'article 2/3', socialSiege: 'article siège', representant_legal: 'président/gérant nommé, avec date et lieu de naissance s\'ils figurent', capital: 'montant et répartition (utile si la société associée détient une part)' },
  a_demander_oralement: ['situation matrimoniale', 'nom et prénom du père et de la mère (nom de naissance)', 'email et téléphone de chaque associé', 'numéro de sécurité sociale SEULEMENT pour SARL/EURL/SCI', 'régime d\'assurance maladie seulement s\'il n\'est pas le régime général : non salarié (SSI), MSA, ENIM, autre', 'origine des fonds de l\'apport au capital, pour le dirigeant (capital.ownerShareCapitalOrigins, le plus souvent personal_savings = épargne personnelle) et pour chaque associé personne physique (associes[].shareCapitalOrigins) : exigée par l\'API, liste des valeurs dans schema_dossier section=capital'],
}

const SIEGE = {
  argumentaire: [
    'Adresse personnelle protégée : le domicile du dirigeant n\'apparaît ni au Kbis ni sur Internet.',
    'CFE souvent réduite : la cotisation foncière est calculée sur l\'adresse du siège, pas sur le logement.',
    'Courrier numérisé le jour de sa réception, consultable depuis son espace ; recyclage ou réexpédition.',
    'Adresse professionnelle (Paris, Champs-Élysées ou centres en région) pour Apple, Stripe, banques et clients.',
    'Une société par app : toutes domiciliées au même endroit, un seul espace pour tout le courrier.',
  ],
  alternatives: 'Si le client refuse : siege.siegeType = domicile-dirigeant (justificatif de domicile requis), local-pro (bail) ou centre-tiers ; product basic (création seule : frais légaux seuls, paiement unique, accompagnement toujours offert).',
}

const REGLES_DOSSIER = [
  'Les listes (associes, coDirigeants, activities) envoyées à modifier_dossier remplacent entièrement la liste existante.',
  'Après paiement, le compte (email, téléphone) et le siège (centre, cadence) sont figés.',
  'Un seul dossier non payé par email : creer_societe avec l\'email d\'un dossier non payé REMPLACE ce dossier (son jeton et son lien de paiement cessent de fonctionner ; warning PENDING_SUPERSEDED à annoncer au client, surtout si previous.paymentStarted). ' +
  'C\'est la voie de reprise quand le jeton est perdu. modifier_dossier ne peut pas prendre l\'email d\'un autre dossier non payé (EMAIL_EXISTS kind=pending) : proposer un autre alias.',
]
const RECAP = 'statut_dossier detail=complet : récapitulatif au client, avec les assumptions annoncées (« j\'ai pris les réponses les plus courantes : … ») et le devis ; corrections par modifier_dossier.'
const DOUGS = 'Question Dougs, une fois par dossier, après le récapitulatif, jamais déduite du profil : libellé et explication du descripteur partners.dougs (schema_dossier section=partners) ; réponse par modifier_dossier { partners: { dougs: true | false } }.'

const INTERDITS = [
  'Saisir une carte bancaire, choisir ou saisir un mot de passe, signer, passer la vérification d\'identité : ces actes restent personnels (réglementation anti-blanchiment) et se font sur le site.',
  'Inventer un montant, une valeur par défaut ou une règle : tout vient de l\'API (devis_creation, assumptions, schema_dossier).',
  'Parler du prix dans les premiers échanges, avant que le projet soit cerné et sans que le client le demande.',
  'Explorer le poste du client sans son accord explicite, ouvrir un fichier hors des dossiers convenus, ou utiliser une pièce trouvée sans l\'avoir annoncée au client et obtenu sa confirmation : ' +
  'la recherche se propose, n\'a lieu qu\'après son oui, et reste dans les dossiers convenus.',
  'Faire une remarque de QA, de test ou d\'ordre technique sur l\'outil, l\'API, le site ou la forme des réponses : l\'interlocuteur est un client.',
]

const buildGuide = (mode = 'local') => {
  const local = mode === 'local'
  return {
    principe: PRINCIPE + (local ? '' : ' Ce serveur est hébergé et sans état : le jeton renvoyé par creer_societe identifie le dossier à chaque appel (paramètre jeton).'),
    posture: POSTURE,
    remise_au_client: REMISE_AU_CLIENT,
    etapes: [
      {
        n: 1, titre: 'Questions initiales',
        questions: local ? [QUESTION_NOM, QUESTION_ASSOCIES, QUESTION_PROFIL, QUESTION_SIEGE] : [QUESTION_NOM, QUESTION_ASSOCIES, QUESTION_SIEGE],
        regle_forme: REGLE_FORME + (local ? ' Ne pas poser la question de la forme si la préférence du profil existe.' : ''),
        prix: PRIX_MOMENT,
      },
      {
        n: 2, titre: 'Demander les pièces, puis LIRE chaque document et extraire les informations',
        pieces: PIECES,
        lecture: local
          ? 'Lire chaque fichier (image ou PDF) fourni par le client et en extraire les champs ci-dessous. ' + FICHIERS_DESIGNES_LOCAL
          : 'Lire chaque fichier (image ou PDF) que le client fournit à l\'assistant sur son poste et en extraire les champs ci-dessous. Le fichier lui-même n\'est jamais transmis au serveur ni au dossier. Sans fichier, demander les champs dans la conversation. ' + FICHIERS_DESIGNES_DISTANT,
        extraction: EXTRACTION,
        ensuite: local
          ? 'enregistrer_profil_fondateur avec les champs extraits + demandés (l\'API vérifie les formats : corriger erreursFormat), ' +
            'puis enregistrer_pieces_kyc pour chaque fichier avec son documentType (identite_recto : ID_CARD, PASSPORT… ; justificatif_domicile : type de justificatif). ' +
            'Les associés sont passés à creer_societe dans `associes` (type physic | moral + champs extraits).'
          : 'Passer les champs extraits + demandés à creer_societe dans `dossier` : dirigeant (identité, adresse, filiation, email, tel), associes (type physic | moral + champs), ' +
            'siege, capital.ownerShareCapitalOrigins. Prévenir le client que les MÊMES pièces (identité, justificatif de domicile…) seront à déposer sur le site après le paiement : les garder sous la main.',
      },
      { n: 3, titre: 'Proposer le siège chez ma-domiciliation (par défaut), puis annoncer le prix', ...SIEGE, prix: PRIX },
      {
        n: 4, titre: 'Créer le dossier, compléter, récapituler, payer',
        ordre_des_outils: local
          ? [
              'creer_societe dès que forme, dénomination, email, téléphone et siège sont connus (applyDefaults : l\'API pose les réponses les plus courantes).',
              'completer_dossier jusqu\'à completeness.isComplete (formulaires d\'elicitation si le client MCP les supporte ; sinon poser les questionsAPoser dans la conversation puis modifier_dossier).',
              RECAP, DOUGS,
              'Accord explicite du client sur le récapitulatif et le montant du devis, puis ouvrir_paiement (ouvre la page ; ne jamais faire recopier le lien à la main). ' +
              'Terminer la réponse là : dire au client que la page est ouverte (ou lui donner le lien exact si ouverture.mode = lien) et ce qu\'il doit faire, sans appeler d\'autre outil dans ce tour.',
              'Au tour suivant, quand le client dit avoir payé ou être sur la page, ou quand le client MCP signale la fin de la page (le serveur clôt l\'elicitation URL dès qu\'il constate le paiement) : ' +
              'statut_dossier attendre=paiement, puis ouvrir_mot_de_passe (même règle : terminer la réponse), puis, au tour d\'après ou au signal de fin, statut_dossier attendre=mot_de_passe. ' +
              'Jamais de sondage dans le tour qui ouvre une page ou transmet un lien.',
            ]
          : [
              'creer_societe dès que forme, dénomination, email, téléphone, siège et dirigeant sont connus (applyDefaults : l\'API pose les réponses les plus courantes). Conserver le `jeton` renvoyé : il est requis par tous les outils suivants.',
              'Poser dans la conversation les questionsAPoser renvoyées (ou completeness.questionGroups de statut_dossier), puis modifier_dossier (section par section, listes complètes) jusqu\'à completeness.isComplete.',
              RECAP, DOUGS,
              'Accord explicite du client sur le récapitulatif et le montant du devis, puis ouvrir_paiement : terminer la réponse avec le lien exact (jamais recopié à la main) ' +
              'et les étapes suivantes, sans appeler d\'autre outil dans ce tour. Le client doit lire ce message avant tout sondage.',
              'Au tour suivant, quand le client dit avoir payé ou être sur la page : statut_dossier attendre=paiement (sonde jusqu\'au paiement, 60 s par appel). ' +
              'Si le paiement n\'est pas constaté, terminer la réponse en demandant au client où il en est, sans relancer en boucle. Jamais de sondage dans le tour qui transmet le lien.',
            ],
        regles: local
          ? ['Une société = un compte : l\'email du dossier est un alias prenom+nom-de-la-societe@domaine (profil emailAliasPerCompany) ; sur EMAIL_EXISTS proposer un autre alias.', ...REGLES_DOSSIER]
          : ['Une société = un compte ma-domiciliation : sur EMAIL_EXISTS proposer un alias prenom+nom-de-la-societe@domaine via dossier.account.email.', ...REGLES_DOSSIER,
             'Reprise : si la conversation s\'arrête avant le paiement, le client reprend dans une autre conversation avec son code de reprise (le jeton, donné une fois par l\'assistant, dans un message final).'],
      },
      local
        ? {
            n: 5, titre: 'Après paiement : pièces, dépôt de capital, suivi',
            pieces: [
              'Relire documents.items de statut_dossier : cette liste fait foi (pièces Netheos avec documentType pour un dossier domicilié).',
              'envoyer_piece par clé : CNI recto (documentType ID_CARD) puis verso (owner_id_justif_file_2) ; passeport = recto seul ; justificatif de domicile avec son type. Les pièces KYC locales sont reprises par leur kind.',
              'Une pièce demandée (missing) sans pièce KYC ni fichier désigné par le client : proposer de la chercher sur le poste (chercher_pieces après son accord explicite, fichiers des dossiers convenus ouverts pour la reconnaître, confirmation du client avant envoyer_piece) ou la demander dans la conversation.',
              'Suivre nextActions : upload par motif (missing à transmettre, rejected refusée par Netheos à redéposer, not_submitted à redéposer après une panne), complete_on_site = opérateur Netheos ou suspension, rien à redéposer.',
            ],
            capital: 'deposer_capital choice=qonto (ouverture du compte Qonto via le lien renvoyé, à faire par le client) ou banque. Sur SALESFORCE_SYNC_FAILED, rejouer le même appel.',
            suivi: [
              'Le questionnaire et la signature de domiciliation se font sur le site (links.customerArea).',
              'Emails reçus à l\'adresse du dossier : facture, accès à l\'espace client, puis une notification à chaque étape (vérification d\'identité, signature des statuts, dépôt de capital, immatriculation, Kbis).',
              'Le suivi se fait ici avec statut_dossier (état + nextActions) ou dans l\'espace client.',
              'Délai indicatif après dépôt de capital et pièces : statuts sous 24 h, Kbis en quelques jours selon le greffe.',
            ],
          }
        : {
            n: 5, titre: 'Après le paiement : tout se passe sur le site',
            parcours: [
              'Après le paiement, le client est redirigé vers la page de choix du mot de passe (links.passwordPage) : il le choisit lui-même, jamais l\'assistant.',
              'Il arrive ensuite dans son espace client (links.customerArea) : dépôt des justificatifs (identité recto/verso ou passeport, justificatif de domicile, pièces des associés), choix du dépôt de capital (Qonto ou banque), questionnaire et signature de domiciliation.',
              'Emails reçus à l\'adresse du dossier : facture, accès à l\'espace client, puis une notification à chaque étape (vérification d\'identité, signature des statuts, dépôt de capital, immatriculation, Kbis).',
            ],
            role_de_l_assistant: 'Expliquer ces étapes et donner les liens (passwordPage, customerArea) dans un message final, sans appel d\'outil après. statut_dossier (avec le jeton) reste disponible pour informer le client de l\'état et des nextActions ; l\'assistant n\'envoie aucune pièce et ne fait rien d\'autre après le paiement.',
            delais: 'Délai indicatif après dépôt de capital et pièces : statuts sous 24 h, Kbis en quelques jours selon le greffe.',
          },
      {
        n: 6, titre: 'Ce que l\'assistant ne fait jamais',
        interdits: local
          ? [INTERDITS[0], 'Afficher ou demander le jeton de dossier ou tout secret : les dossiers se désignent par leur dénomination ou leur publicToken (mes_societes).', INTERDITS[1], INTERDITS[2], INTERDITS[3], INTERDITS[4]]
          : [INTERDITS[0], 'Publier le jeton ou le mettre dans un message partagé : il se donne au client une seule fois, comme code de reprise, et se redonne dans le paramètre jeton de chaque outil. Jamais de mot de passe ni de carte.', INTERDITS[1], INTERDITS[2], INTERDITS[3], INTERDITS[4]],
      },
    ],
  }
}

const buildPromptText = (mode = 'local') => (mode === 'local'
  ? 'Je veux créer ma société avec ma-domiciliation.fr. ' +
    'Commence par appeler guide_creation et suis son déroulé : questions initiales, lecture de mes pièces, profil fondateur et pièces KYC, ' +
    'siège (centre de domiciliation par défaut), création du dossier et questions restantes, récapitulatif avec devis réel et hypothèses, ' +
    'question Dougs, mon accord explicite, paiement puis mot de passe sur le site, envoi des pièces et dépôt de capital, suivi. ' +
    'Lis les fichiers que je te désigne ; si une pièce manque, propose-moi de la chercher sur mon poste et attends mon accord avant de chercher ; avec mon accord, ouvre les fichiers de ces dossiers pour reconnaître la pièce et montre-moi ce que tu as trouvé avant de l\'utiliser. Ne me demande jamais mon jeton de dossier ni mes identifiants. ' +
    'Quand tu ouvres une page (paiement, mot de passe), termine ta réponse et attends que je te dise où j\'en suis avant de vérifier. ' +
    'Adresse-toi à moi comme à un client : aucune remarque technique, de test ou de QA sur l\'outil ou ses réponses.'
  : 'Je veux créer ma société avec ma-domiciliation.fr. ' +
    'Commence par appeler guide_creation et suis son déroulé : questions initiales, lecture de mes pièces sur mon poste, ' +
    'siège (centre de domiciliation par défaut), création du dossier et questions restantes, récapitulatif avec devis réel et hypothèses, ' +
    'question Dougs, mon accord explicite, paiement sur le site ; ensuite je termine sur le site (mot de passe, justificatifs, dépôt de capital). ' +
    'Lis les fichiers que je te désigne ; si une pièce manque, propose-moi de la chercher sur mon poste et attends mon accord avant de chercher ; avec mon accord, ouvre les fichiers de ces dossiers pour reconnaître la pièce et montre-moi ce que tu as trouvé avant de l\'utiliser. Garde le jeton du dossier pour tes appels et donne-le-moi une fois comme code de reprise. Ne me demande jamais mon mot de passe ni ma carte. ' +
    'Donne-moi le lien de paiement dans un message complet, puis attends que je te dise que j\'ai payé avant de vérifier. ' +
    'Adresse-toi à moi comme à un client : aucune remarque technique, de test ou de QA sur l\'outil ou ses réponses.')

const GUIDE = buildGuide('local')
const PROMPT_TEXT = buildPromptText('local')

export { GUIDE, PROMPT_TEXT, POSTURE, REMISE_AU_CLIENT, SERVER_INSTRUCTIONS, buildGuide, buildPromptText }
