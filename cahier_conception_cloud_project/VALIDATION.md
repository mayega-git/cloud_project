# Vérifications du cahier et du MVP local — version 0.2

## Module branches et versions — vérification du 25 octobre 2026

- `npm run build` et `npm test` ont réussi dans `application/backend`. Les tests calendaires couvrent les transitions d'heure à Paris et le fuseau d'Abidjan.
- L'image locale a été construite depuis Etherpad 3.3.6 (commit annoncé `0fc3dc0`) avec `ep_business` 0.1.8 et le patch de barrière ordonnée. Le plugin revérifie périodiquement les connexions après révocation. PostgreSQL 15 a démarré ; les migrations `001_business.sql` et `002_retry.sql` ont été appliquées.
- Deux tests d'intégration contre le vrai backend, Etherpad et PostgreSQL ont réussi : création idempotente, fermeture manuelle concurrente avec une seule V2, conservation des droits de branche, refus métier sur version figée, restauration indépendante d'une révision avec gras et italique, source inchangée après modification de la branche restaurée, absence des permissions du collaborateur sur la nouvelle branche, et rattrapage d'une échéance quotidienne avec un seul successeur, y compris après nouvelle tentative sur la même échéance.
- Dans le navigateur, un rédacteur autorisé a ouvert et modifié un pad métier. Après clôture, le client a affiché le texte local récupérable ; après rechargement, l'éditeur était non éditable et le panneau persistait. Un accès sans cookie a été refusé. Après révocation d'une connexion déjà ouverte, l'éditeur est devenu non éditable et le panneau « Accès à cette version interrompu » est apparu. La passerelle a refusé `/api/`.
- `latexmk -g -pdf -interaction=nonstopmode -halt-on-error main.tex` a produit le seul PDF du rapport, `main.pdf` (41 pages). Aucun avertissement de référence indéfinie, de label dupliqué ou de débordement n'apparaît dans le journal. Les pages du chapitre 4 contenant la description du code et le tableau de correspondance ont été inspectées visuellement.
- Ces essais ne prouvent pas encore la conservation de chaque écriture en transit lors d'une clôture, le comportement après une longue coupure, le couplage du crédit à la persistance, ni la tenue de charge. Aucun déploiement AWS n'a été effectué.

Date : 25 octobre 2026. Les contrôles ci-dessous concernent cette version locale ; ils ne valent ni qualification de charge ni validation des contraintes prioritaires.

## Document

- `make diagrams PLANTUML_JAR=/home/mayega/Downloads/NetworkGandal/plantuml.jar` a régénéré les huit images UML avec PlantUML 1.2026.8 et Java 21. Les diagrammes d'analyse modifiés sont le contexte et les packages ; leurs libellés ne nomment plus de technologie.
- `make pdf` produit uniquement `main.pdf` : 35 pages A4 avec pdfLaTeX et latexmk. Le journal final ne contient pas d'avertissement LaTeX, de référence indéfinie ou de débordement de boîte.
- Les pages physiques 19 et 20 (contexte et packages), 28 (nouveau titre du chapitre 3) et 31 et 32 (tableau de stack et suite de l'implémentation) ont été inspectées visuellement. Le diagramme de contexte contient le rectangle « Système ». Le tableau reste lisible lors de son passage à la page suivante.
- L'extraction du PDF montre uniquement les figures 2.1 à 2.3 au chapitre 2 : l'inclusion de l'ancienne figure 2.4 a été retirée. Sa source et son image restent conservées hors du rapport. Le chapitre 3 porte le titre « Conception » et la section 3.1 expose le modèle du crédit. Les identifiants des exigences du chapitre 2 n'ont pas été renumérotés.

## Application locale

- `docker compose --env-file .env -f deployment/compose.yaml config --quiet` s'est terminé sans erreur.
- `npm install` puis `npm run build` ont réussi pour le backend TypeScript. L'installation a signalé que la dépendance transitive `cookie@2.0.1` déclare Node.js 22 ou supérieur, tandis que l'hôte utilise Node.js 20.19.2 ; le démarrage et les requêtes ci-dessous ont néanmoins réussi. La compatibilité complète de cette combinaison n'est pas démontrée.
- Les conteneurs Etherpad 3.3.6 et PostgreSQL 15 ont démarré. La page d'accueil Etherpad et l'URL du pad de vérification ont répondu HTTP 200.
- Le backend a répondu à `GET /health` avec `status: ok` et `quota: non_implémenté`.
- `POST /documents` a créé un pad via l'API Etherpad. `GET /documents/:id` a relu son texte ; après une modification de test par l'API Etherpad, le backend a relu exactement `Test MVP : écriture persistante` suivi d'un retour à la ligne.
- Un identifiant invalide a reçu HTTP 400 ; un identifiant bien formé mais absent d'Etherpad a reçu HTTP 404.
- Après `docker compose restart etherpad`, le backend a retrouvé le même texte. Cela vérifie une reprise locale simple ; cela ne prouve ni l'absence de perte de toutes les écritures concurrentes ni l'atomicité du crédit.
- Le script de préparation a créé `.env` et `.secrets/APIKEY.txt` avec des permissions locales restrictives. Ces chemins sont exclus par `.gitignore`. Un contrôle de 13 fichiers texte ajoutés ou modifiés dans `application/` et de `.gitignore` n'a trouvé ni ces secrets locaux ni motif de clé AWS apparente.

## Limites des vérifications

Le registre npm consulté indique `ep_cursortrace` 3.1.65 et Node.js 18 ou supérieur, sans contrainte de version Etherpad explicite. Le plugin n'a pas été installé et son comportement avec Etherpad 3.3.6 reste à tester. L'affichage simultané de plusieurs curseurs dans un navigateur n'a pas été vérifié.

Aucune identité métier persistante, session multiappareil, opération de crédit, distribution de PDF, notification e-mail, charge à 300 rédacteurs ou 15 000 visiteurs, ressource AWS ou preuve de coût AWS n'a été testée dans cette étape.

## Révision documentaire v0.3 — 25 octobre 2026

Cette entrée consigne uniquement les contrôles de la présente révision. Les résultats de la version 0.2 ci-dessus restent un historique ; les essais de l'application n'ont pas été relancés.

- Les sources du tag Etherpad `v3.3.6` ont été examinées : API des pads et des révisions, traitement des messages et file par pad, ajout de révision avant `ACCEPT_COMMIT`, comportement du client lors d'une reconnexion et export du texte local. Ces lectures fondent les limites décrites au chapitre 4 ; elles ne prouvent pas encore les garanties de gel ou de crédit.
- `make diagrams PLANTUML_JAR=/home/mayega/Downloads/NetworkGandal/plantuml.jar` a régénéré les figures, dont le diagramme de packages révisé et le nouveau cycle UML d'une version métier. La commande s'est terminée sans erreur avec PlantUML 1.2026.8.
- `make pdf` a produit `main.pdf`, 41 pages. Le journal final ne contient pas d'avertissement LaTeX, de référence indéfinie ni de débordement de boîte. Un contrôle des sources ne relève aucun label dupliqué, aucune référence ou citation indéfinie.
- Les pages physiques 20 (packages), 32 (règles et autorisations), 33 (cycle de clôture) et 37 (correspondance avec Etherpad) ont été inspectées visuellement. La matrice des autorisations a été espacée après un premier rendu trop serré, puis inspectée de nouveau.
- `git diff --check` s'est terminé sans erreur. Les diagrammes d'analyse contrôlés ne contiennent aucun nom de technologie ; le seul PDF du cahier est `main.pdf`.

Aucun mécanisme métier supplémentaire n'a été codé ou exécuté, aucune ressource AWS n'a été déployée et aucun test de charge n'a été effectué pour cette révision.
