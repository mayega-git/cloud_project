# Éditeur de documents partagé

Application web d'écriture à plusieurs : documents partagés, édition simultanée, historique et restauration des versions, liens de téléchargement en PDF limités en nombre, crédit d'écriture quotidien. Elle est déployée sur AWS (région eu-north-1). Cette branche rassemble la documentation du projet ; le code et l'infrastructure sont sur la branche `main`.

## Application en ligne

| Accès | Adresse |
|---|---|
| **Interface web** | http://cloud--loadb-kr3maitxz1zu-365289723.eu-north-1.elb.amazonaws.com:3001 |
| API (point de santé) | http://cloud--loadb-kr3maitxz1zu-365289723.eu-north-1.elb.amazonaws.com/health |
| Éditeur | s'ouvre depuis l'interface (port 9001 du même hôte) |

Ces adresses ne répondent que tant que le déploiement existe. L'équilibreur de charge n'accepte que les adresses IP autorisées par le paramètre `AllowedCidr` de la pile (voir « Déployer sur AWS »). Pour qu'un évaluateur puisse l'utiliser, ce paramètre doit autoriser son adresse pendant l'évaluation.

Pour essayer l'interface : saisir un nom et une adresse, cliquer sur « Connexion rapide (mode local) » (aucun e-mail n'est envoyé), créer un projet, ouvrir sa branche, puis « Ouvrir l'éditeur » dans un nouvel onglet. La section « Liens de téléchargement » de la page de branche crée un lien limité.

Deux remarques sur l'instance actuellement en ligne :

- Le lien de téléchargement affiché par l'interface contient `:3001`. Tant que la mise à jour de pile décrite plus bas n'est pas appliquée, il faut retirer ce port de l'adresse (`http://<hôte>/d/<jeton>`) pour l'ouvrir.
- Le crédit d'écriture est appliqué par le serveur, mais l'écran de l'éditeur ne prévient pas d'un refus : recharger la page montre le texte réellement sauvegardé.

## Organisation du dépôt

| Branche | Contenu |
|---|---|
| `main` | Code (`application/` : backend, frontend, plugin Etherpad), infrastructure (`application/infra/aws.yaml`), intégration continue (`.github/workflows/`) |
| `documentation` | Ce dossier : README, description de l'API, rapport de tests, scripts de test, cahier de conception LaTeX |

## Contenu de cette branche

| Fichier | Rôle |
|---|---|
| `API.md` | Description précise de l'API implémentée, pour écrire ses propres tests |
| `RAPPORT_TESTS.md` | Rapport de tests : méthode, objectifs, résultats par contrainte, ce qui n'est pas implémenté |
| `tests/c1-download-limit.mjs` | Mesure du plafond de téléchargements (limite 1 puis 500, requêtes simultanées) |
| `tests/credit-paste.mjs` | Mesure du crédit d'écriture dans un éditeur réel |
| `cahier_conception_cloud_project/` | Dossier de conception (LaTeX, `main.pdf`), avec son propre README pour le compiler |

## Déployer sur AWS

Le déploiement utilise un seul modèle CloudFormation, `application/infra/aws.yaml`, qui décrit : un équilibreur de charge, deux instances EC2 dans deux zones, une base RDS PostgreSQL non publique, un bucket S3 privé, des secrets générés par AWS et un rôle IAM minimal. Aucune clé d'accès AWS n'est nécessaire dans le dépôt ni sur les instances. Le guide détaillé est `application/infra/README.md`.

Prérequis : un compte AWS, le VPC par défaut de la région avec deux sous-réseaux publics dans deux zones différentes, un dépôt GitHub avec les Actions activées.

1. **Publier les images.** Sur GitHub, onglet Actions, workflow « Publish images », « Run workflow » sur `main`. Il publie `backend`, `etherpad` et `frontend` sur GHCR. Relever, pour chacune, la référence `ghcr.io/<propriétaire>/cloud_project/<image>:<sha>@sha256:<empreinte>` affichée dans le résumé de l'exécution. Rendre les trois paquets publics (paramètres du paquet, visibilité), sinon les instances ne peuvent pas les télécharger.
2. **Créer la pile.** Console AWS, région eu-north-1, CloudFormation, « Create stack », charger `aws.yaml`. Renseigner :

   | Paramètre | Valeur |
   |---|---|
   | `VpcId` | identifiant du VPC par défaut (liste déroulante) |
   | `SubnetAId`, `SubnetBId` | deux sous-réseaux de ce VPC dans deux zones différentes (listes déroulantes) |
   | `AllowedCidr` | adresses autorisées à joindre l'équilibreur, par exemple `x.x.x.x/32` ; `0.0.0.0/0` pour ouvrir à tous |
   | `BackendImage`, `EtherpadImage`, `FrontendImage` | les trois références relevées à l'étape 1 |
   | `KeyPairName`, `SshCidr` | facultatifs, pour un accès SSH de secours |

   Cocher la case d'acceptation des ressources IAM. La création dure plusieurs minutes (la base est la ressource la plus lente).
3. **Relever les sorties** de la pile : `PublicUrl` (API), `EditorUrl`, `FrontendUrl` (interface web), le nom du bucket et les identifiants des instances.
4. **Vérifier.** Console EC2, groupes cibles : les deux instances doivent passer à `healthy` pour chaque groupe. Puis `GET <PublicUrl>/health` doit répondre `{"status":"ok","quota":"DAILY_WRITE_CREDIT","authentication":"LOCAL_ONLY"}`.
5. **Ouvrir l'accès à l'évaluation.** Pour changer les adresses autorisées après coup : console EC2, groupes de sécurité, celui de l'équilibreur, modifier les règles entrantes des ports 80, 3001 et 9001 (ou mettre à jour le paramètre `AllowedCidr` de la pile). Refermer l'accès après l'évaluation.

Administration des instances : AWS Systems Manager (Session Manager), sans port ouvert. Aucun port SSH n'est ouvert si `SshCidr` est vide.

État de vérification : le modèle a été éprouvé par une création puis des mises à jour successives. Un déploiement à neuf de bout en bout avec la version actuelle du modèle n'a pas été rejoué. La version actuelle du modèle ajoute aussi le routage par chemin sur le port 3001 (les chemins `/backend/*` et `/d/*` vont directement aux backends) ainsi que des contrôles de santé plus rapides : cette mise à jour n'a pas été appliquée à l'instance en ligne. Elle redémarre les deux instances pendant quelques minutes.

## Tester

- **Tests de la branche `main`** : depuis `application/`, `bash ci-local.sh` installe, compile, joue les tests unitaires, construit les images, applique les migrations deux fois et rejoue les tests d'intégration sur une pile jetable. Options : `--skip-docker`, `--no-build`, `--local-db`. Ce script est aussi celui de l'intégration continue GitHub.
- **Mesures de ce dossier** : depuis la racine de cette branche, avec `BASE_URL` égal à l'adresse de l'API.

  ```sh
  BASE_URL=http://<hôte> node tests/c1-download-limit.mjs
  npm install playwright-core
  BASE_URL=http://<hôte> CHROME_PATH=/usr/bin/google-chrome node tests/credit-paste.mjs
  ```

  Le premier script attend Node 20 ou plus et n'a aucune dépendance. Le second pilote un navigateur Chrome ou Chromium. Chaque script se termine par un code différent de zéro si la garantie testée n'est pas respectée.
- **Tests écrits par l'évaluateur** : `API.md` décrit chaque route, ses paramètres, ses réponses et des scénarios `curl` prêts à rejouer.
- **Résultats** : `RAPPORT_TESTS.md`.

## Supprimer l'ensemble

1. **Vider le bucket S3.** Console S3, ouvrir le bucket indiqué par la sortie `ExportsBucketName`, « Empty ». CloudFormation ne supprime pas un bucket qui contient des objets.
2. **Supprimer la pile.** Console CloudFormation, sélectionner la pile, « Delete ». Elle supprime les instances et leurs volumes, l'équilibreur, la base (sans instantané final), le bucket, le rôle IAM et les groupes de sécurité. Attendre `DELETE_COMPLETE`.
3. **Vérifier qu'il ne reste rien** : plus d'instance EC2, d'équilibreur, de groupe cible ni de base RDS ; aucun volume orphelin. Les secrets de Secrets Manager peuvent rester planifiés pour suppression pendant leur délai de récupération : le contrôler dans la console.
4. **Contrôler le coût** le lendemain dans Cost Explorer, et conserver une capture comme preuve de coût.
Les paquets d'images publiés sur GHCR sont indépendants de la pile : les supprimer depuis les paramètres des paquets GitHub si nécessaire.

## Limites connues

- L'identité fonctionne en mode local : un nom et une adresse suffisent, sans preuve que l'adresse appartient à la personne. Le déploiement ne doit être ouvert que le temps de l'évaluation.
- Le déploiement est en HTTP simple, faute de nom de domaine.
- La connexion à la base n'est pas chiffrée à l'intérieur du réseau privé.
- Il n'y a qu'un exemplaire d'Etherpad, sur la première instance : si cette instance s'arrête, l'édition et la génération des PDF s'arrêtent, l'API et l'interface continuent.
- Aucun SMTP n'est configuré : la vérification d'adresse par code ne fonctionne pas sur AWS.
- Les contraintes non démontrées, les fonctions absentes et les défauts relevés sont détaillés dans `RAPPORT_TESTS.md`.
