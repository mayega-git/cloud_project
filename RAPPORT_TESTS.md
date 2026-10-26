# Rapport de tests

Projet : éditeur de documents partagé.
Mesures réalisées le 26 octobre 2026.

## 1. Objet et objectifs

Ce rapport décrit comment l'application a été testée, ce qui a été mesuré et ce qui ne l'a pas été. L'objectif fixé au départ était d'implémenter l'ensemble des contraintes du sujet. Il n'a pas été atteint en totalité : pour chaque contrainte, le rapport indique si elle est respectée, partiellement respectée ou non implémentée, et donne les résultats bruts qui permettent d'en juger.

Les six contraintes du sujet, dans l'ordre de ce rapport :

| Repère | Contrainte |
|---|---|
| C1 | Un lien donne exactement le nombre de téléchargements autorisé à sa création, jamais un de plus, quel que soit le nombre de visiteurs simultanés |
| C2 | Aucune modification acceptée n'est perdue et tous les participants finissent avec le même document, y compris pour des écritures au même endroit |
| C3 | Un lien créé à l'instant T et utilisé à l'instant T1 donne le document tel qu'il est à T1, sans changer de lien |
| C4 | Un rédacteur n'écrit jamais plus que son crédit du jour (10 000 caractères), même depuis plusieurs appareils |
| C5 | Un pic de 15 000 visiteurs, dont 80 % dans la première minute, pendant que 300 rédacteurs écrivent, sans panne ni perte, chaque visiteur obtenant une réponse |
| C6 | Une fois le dernier exemplaire distribué, les visiteurs encore présents l'apprennent vite, sans que l'application continue de rendre un service qu'elle ne doit plus |

Le sujet précise que C1 et C2 sont les plus importantes.

## 2. Synthèse

| Contrainte | État | Preuve fournie |
|---|---|---|
| C1 | Respectée pour un document en texte brut | Oui : plafond exact mesuré sous 250 requêtes simultanées, sur AWS et en test d'intégration |
| C2 | Partiellement respectée | Essais à deux rédacteurs sans perte ni divergence ; pas de preuve sous panne, sous charge ni avec plusieurs instances d'éditeur |
| C3 | Respectée pour un document en texte brut | Oui : test d'intégration (texte modifié après la création du lien) |
| C4 | Appliquée par le serveur, interface incomplète | Oui pour le plafond (mesure sur AWS) ; le rédacteur n'est pas averti à l'écran d'un refus |
| C5 | Non démontrée | Aucun essai à 15 000 visiteurs ni à 300 rédacteurs |
| C6 | Partiellement respectée | Réponse immédiate « épuisé » sans génération de PDF ; aucune notification, aucun e-mail |

Fonctions du sujet non implémentées : e-mail au créateur au dernier téléchargement, détection et blocage des abus, supervision (documents ouverts, liens actifs et restants, personnes bloquées), curseurs des autres rédacteurs. La présence est partielle : le nombre de participants s'affiche, pas leur nom.

## 3. Méthode

### 3.1 Environnements

| Environnement | Composition | Usage |
|---|---|---|
| Local | Docker Compose : PostgreSQL 15, Etherpad 3.3.6 avec son plugin, backend Fastify, passerelle Nginx | Développement, tests unitaires et d'intégration |
| Intégration continue | GitHub Actions, pile reconstruite à neuf à chaque exécution (environ 2 minutes) | Rejeu des tests unitaires et d'intégration sur chaque modification |
| AWS (eu-north-1) | Deux instances EC2 dans deux zones derrière un équilibreur de charge, base RDS PostgreSQL 15 dans une zone, bucket S3 privé | Mesures de bout en bout |

### 3.2 Outils

Tests automatisés avec `node:test` (unitaires et intégration), requêtes avec `curl` et avec des scripts Node (`fetch`), navigateur Chrome piloté par Playwright pour l'éditeur. Les mesures sur AWS ont été lancées depuis un poste unique, à travers Internet.

### 3.3 Données de test

Chaque essai crée ses propres rédacteurs, documents et liens, avec des identifiants aléatoires et des adresses en `example.test`. Aucun état n'est partagé d'un essai à l'autre. L'identité repose sur le mode local de l'application (nom et adresse déclarés).

### 3.4 Principe de mesure

Pour chaque essai, on compte les codes de réponse HTTP reçus, puis on relit l'état conservé par le serveur : l'état du lien (`/status`) pour les téléchargements, le texte enregistré (`/content`) pour l'écriture. Une garantie n'est retenue que si le compte observé et l'état conservé concordent avec la valeur attendue.

### 3.5 Rejouer les mesures

Les scripts du dossier `tests/` rejouent les deux mesures principales (voir l'annexe). Chaque mesure a été exécutée au moins deux fois sur AWS pour C1 et C4, avec le même résultat.

### 3.6 Limites de la méthode

La charge la plus forte générée est de 250 requêtes simultanées depuis un seul poste. Aucune panne n'a été injectée pendant les écritures. Les essais d'édition concernent deux rédacteurs, pas des centaines. Le coût d'exploitation n'a pas été relevé.

## 4. Résultats par contrainte

### 4.1 C1 : plafond de téléchargements

Mesures sur AWS, depuis l'adresse de l'équilibreur, avec des visiteurs sans identité :

| Lien | Requêtes | Simultanées | Durée | Réponses 200 (PDF) | Réponses 410 | État du lien ensuite |
|---|---|---|---|---|---|---|
| Limite 1 | 200 | 100 | 2,0 s | 1 | 199 | épuisé, 0 restant |
| Limite 500 | 2000 | 250 | 3,7 s | 500 | 1500 | épuisé, 0 restant |

Les 500 réponses 200 sont des PDF valides contenant le texte du document. Le total livré plus le restant égale la limite dans les deux cas. Les deux mesures ont été reproduites par une seconde exécution indépendante (script `tests/c1-download-limit.mjs`) avec les mêmes décomptes. Un scénario `curl` avec une limite de 3 et 50 requêtes (25 simultanées) a donné 3 réponses 200 et 47 réponses 410.

Les tests d'intégration vérifient le même plafond avec 40 visiteurs simultanés pour une limite de 1 et 60 pour une limite de 5.

Ce que la preuve ne couvre pas : le scénario complet du sujet (15 000 visiteurs) n'a pas été exécuté. Le téléchargement est compté au moment de la réservation, pas à la réception complète du fichier : un navigateur qui interrompt le transfert consomme quand même un exemplaire. Les limites ci-dessus portent sur un document en texte brut.

### 4.2 C2 : aucune modification perdue, convergence

Essais à deux rédacteurs écrivant au même endroit en même temps, en local et à travers l'équilibreur AWS (WebSocket) :

| Essai | Texte chez le premier | Texte chez le second | Résultat |
|---|---|---|---|
| Local | `BOB-BBB ALICE-AAA` | `BOB-BBB ALICE-AAA` | identiques |
| AWS | `BAOB-BBB LICE-AAA` | `BAOB-BBB LICE-AAA` | identiques, les 17 caractères attendus présents |

Dans l'essai AWS, les lettres des deux saisies sont entrelacées, ce qui est le comportement attendu pour deux frappes simultanées au même endroit. Le recomptage caractère par caractère confirme que rien n'a été perdu (4 `A`, 5 `B`, 2 tirets, un `O`, un `L`, un `I`, un `C`, un `E`).

Les tests d'intégration vérifient aussi : deux demandes de clôture simultanées produisent une seule version suivante, la restauration crée une branche indépendante sans modifier la source, le contenu enrichi (gras, italique) est conservé, une échéance quotidienne dépassée n'est traitée qu'une fois.

Ce que la preuve ne couvre pas : écritures en vol à chaque frontière du gel, pannes injectées après chaque étape, reconnexion après une longue coupure, plusieurs instances d'éditeur, 300 rédacteurs. Etherpad n'existe qu'en un exemplaire (sur une seule instance), choix volontaire : deux moteurs sur le même document mettraient la contrainte en péril. **C2 n'est donc pas démontrée complètement.**

### 4.3 C3 : document à jour au téléchargement

Test d'intégration : un lien est créé avant toute modification du document, le texte est écrit, le document est téléchargé ; le texte est ensuite corrigé et le même lien est utilisé de nouveau. Le premier PDF contient le premier texte, le second contient le texte corrigé et ne contient plus le premier ; l'état du lien indique un exemplaire restant sur trois, ce qui est correct. Le contenu est celui de la version active au moment de la requête, c'est-à-dire les modifications déjà acceptées par l'éditeur.

Limite : le PDF est du texte brut (police Helvetica, A4). La mise en forme (gras, listes) n'est pas reproduite, et les caractères hors du jeu Latin-1 sont remplacés par `?`.

### 4.4 C4 : crédit d'écriture

Règle appliquée : une modification coûte le nombre de caractères qu'elle insère, les suppressions et la mise en forme ne coûtent rien, une modification qui dépasserait le crédit est refusée en entier, le jour est le jour UTC.

| Essai | Résultat |
|---|---|
| Intégration : 20 débits simultanés de 600 caractères depuis deux sessions du même rédacteur | 16 acceptés, 4 refusés (16 x 600 = 9 600 tient dans 10 000) |
| Intégration : débit suivant de 401 | refusé |
| Intégration : débit suivant de 400 | accepté (reste exactement 400) |
| Intégration : débit de 1 puis de 0 | 1 refusé, 0 accepté (une suppression ne coûte rien) |
| AWS, éditeur réel : collage de 9 000 caractères | accepté, 9 000 conservés |
| AWS, éditeur réel : collage de 2 000 caractères de plus (11 000 au total) | refusé, relecture du texte : 9 000 caractères, aucun des 2 000 nouveaux |

La mesure sur AWS a été exécutée deux fois (script `tests/credit-paste.mjs` pour la seconde) avec le même résultat. Le plafond est donc respecté, y compris quand deux appareils écrivent en même temps.

Défaut constaté : après le refus, aucun message n'apparaît à l'écran du rédacteur et l'éditeur continue d'afficher le texte refusé, que le serveur n'a pas enregistré. Le rédacteur peut croire que son texte est sauvegardé. Le panneau d'avertissement prévu n'est pas déclenché par ce cas. La copie initiale d'une version ou d'une restauration n'est pas débitée, ce qui reste une décision à valider.

### 4.5 C5 : pic de 15 000 visiteurs et 300 rédacteurs

Non exécuté. La mesure la plus forte réalisée est de 250 requêtes simultanées sur un lien de téléchargement, avec deux rédacteurs actifs. La capacité des machines n'a pas été mesurée. Les types d'instance demandés par le modèle sont de petite taille (une `t3.small` pour l'instance qui porte l'éditeur, une `t3.micro` pour l'autre, d'après les paramètres par défaut) et l'éditeur est un processus unique. Aucune affirmation de capacité n'est faite.

### 4.6 C6 : information après le dernier exemplaire

Dans la mesure à 500 exemplaires, les 1 500 requêtes arrivées après l'épuisement ont reçu `410 LINK_EXHAUSTED` pendant la même salve de 3,7 secondes. Aucune génération de PDF n'est lancée pour ces requêtes : la réservation échoue avant la conversion. La route `GET /d/{token}/status` indique `EXHAUSTED` sans rien consommer.

Non implémenté : aucune notification n'est poussée aux visiteurs déjà présents sur une page, et aucun e-mail n'est envoyé au créateur au dernier exemplaire.

## 5. Autres fonctions du sujet

| Fonction | État | Vérification |
|---|---|---|
| Identification par nom et adresse | Respectée en mode local | `POST /dev/sessions` ; le parcours par code e-mail existe mais n'est pas utilisable sur AWS faute de SMTP |
| Création d'un document | Respectée | Tests d'intégration, essais sur AWS |
| Partage et ouverture | Respecté | Droits `READ` et `WRITE` par branche, invitations ; propriétaire 200, sans droit 401, sans session 401 |
| Écriture simultanée et diffusion | Respectée pour deux rédacteurs | Voir 4.2 |
| Présence | Partielle | Compteur de participants, sans noms |
| Position des autres rédacteurs | Non implémentée | Aucun curseur distant |
| Conservation, consultation, restauration des versions | Respectées | Tests d'intégration : versions figées, lecture d'une révision, restauration dans une nouvelle branche |
| Blocage après abus | Non implémenté | |
| Supervision | Non implémentée | Seule la liste des liens d'une branche existe |
| E-mail au dernier téléchargement | Non implémenté | |

## 6. Vérifications sur l'infrastructure AWS

| Contrôle | Résultat |
|---|---|
| `/health` via l'équilibreur, 20 requêtes | 20 réponses 200 |
| Une session, 30 requêtes authentifiées ensuite | 30 réponses 200 (les sessions sont partagées par la base) |
| Passerelle de l'éditeur : `/health` | 200 |
| Passerelle : `/api/1/listAllPads`, `/admin`, `/business-internal/x` | 403 |
| Ports 3000, 9002 et 5432 de l'équilibreur depuis Internet | expirent |
| Ports 3000, 9001 et 9002 directs d'une instance | expirent |
| Bucket S3 sans identifiants | 403 `AccessDenied` |
| Accès au pad : propriétaire, sans droit, sans session | 200, 401, 401 |
| Interface web, page d'accueil, 20 requêtes | 20 réponses 200 |

Arrêt du backend de la seconde instance (essai de disponibilité) :

| Point d'entrée | Résultat |
|---|---|
| API (port 80), 40 requêtes authentifiées | 40 réponses 200 |
| `/health` (port 80), 40 requêtes | 40 réponses 200 |
| Éditeur (port 9001), 10 requêtes | 200 à chaque requête |
| Interface web, page d'accueil, 40 requêtes | 40 réponses 200 |
| Interface web, appels API, deux essais de 40 requêtes | 19 erreurs 502 la première fois, puis 18 erreurs 502 et un dépassement de délai |

La redondance des backends fonctionne pour l'API. L'interface web, elle, dépendait du backend de sa propre instance et son contrôle de santé ne testait que la page d'accueil : l'équilibreur continuait donc d'y envoyer la moitié du trafic. Une correction (routage par chemin sur l'équilibreur, contrôles de santé plus rapides) est écrite dans le modèle d'infrastructure et validée localement, mais elle n'a pas été appliquée à la pile déployée ni mesurée. En l'état, une instance dont le backend s'arrête dégrade l'interface web pendant toute la panne. La panne de l'instance qui porte l'éditeur coupe l'édition et la génération des PDF, par construction.

## 7. Défauts et incidents relevés

- La base RDS refusait les connexions non chiffrées, ce qui a fait échouer le premier démarrage ; corrigé par un groupe de paramètres qui désactive l'obligation de TLS. La connexion à la base n'est donc pas chiffrée à l'intérieur du réseau privé.
- Couplage entre l'interface web et le backend de la même instance (voir section 6) : correction écrite, non déployée.
- Aucun avertissement à l'écran quand un refus de crédit intervient (voir 4.4).
- La génération des clés d'idempotence par `crypto.randomUUID` échouait en HTTP simple ; remplacée.
- L'éditeur ne fonctionne pas dans une iframe d'une autre origine en HTTP (cookie de préférences refusé) : il s'ouvre dans un onglet.
- Une exécution de l'intégration continue d'une branche a échoué sans cause relevée, puis le même contenu a réussi sur la branche principale ; non reproduit en local. À surveiller : un test de concurrence peut être sensible au timing.
- Aucun SMTP n'est configuré : la vérification d'adresse par code n'est pas utilisable sur AWS.

## 8. Non implémenté ou non démontré

- E-mail au dernier téléchargement.
- Détection et blocage des abus.
- Supervision de l'état de l'application.
- Curseurs des autres rédacteurs ; noms dans la liste de présence.
- PDF avec mise en forme.
- Scénario de 15 000 visiteurs et de 300 rédacteurs (C5).
- Preuve de C2 sous panne, sous charge et avec plusieurs instances.
- Avertissement du rédacteur en cas de refus de crédit.

## 9. Coût

Aucune mesure de coût n'a été relevée à la date de ce rapport. L'infrastructure déployée comprend deux instances EC2 et leurs volumes, un équilibreur de charge, une base RDS, des adresses IPv4 publiques, des secrets et le trafic sortant. La preuve de coût est à joindre : capture du service Cost Explorer de la console AWS après quelques heures d'exploitation, accompagnée du budget d'alerte et du coût résiduel observé après suppression de la pile.

## 10. Conclusion

Les deux contraintes les plus importantes se répartissent ainsi. C1 est respectée pour un document en texte brut et démontrée par des mesures sous concurrence, sur l'infrastructure déployée. C2 est respectée dans les essais réalisés (deux rédacteurs, convergence et absence de perte) mais n'est pas démontrée sous panne ni sous charge. C3 et C4 sont appliquées et mesurées, avec un défaut d'interface pour C4. C5 n'a pas été éprouvée et C6 n'est que partiellement traitée. Plusieurs fonctions du sujet restent à développer, listées en section 8.

## Annexe : rejouer les mesures

```sh
# C1 : plafond de téléchargements (limite 1 puis 500)
BASE_URL=http://<hôte> node tests/c1-download-limit.mjs

# C4 : crédit d'écriture (9 000 caractères acceptés, 2 000 refusés)
npm install playwright-core
BASE_URL=http://<hôte> CHROME_PATH=/usr/bin/google-chrome node tests/credit-paste.mjs

# Tests unitaires et d'intégration (branche main, dossier application/)
bash ci-local.sh
```

Les descriptions des routes utilisées sont dans `API.md`.
