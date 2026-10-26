# Éditeur de documents partagé

Application web d'écriture à plusieurs, conçue et déployée sur AWS dans le cadre d'un projet d'évaluation. Plusieurs rédacteurs travaillent en même temps sur un même texte, consultent et restaurent les versions précédentes, et diffusent le document par des liens de téléchargement en PDF limités en nombre. Chaque rédacteur dispose d'un crédit d'écriture de 10 000 caractères par jour.

**Toute la documentation se trouve sur la branche [`documentation`](https://github.com/mayega-git/cloud_project/tree/documentation)** : comment déployer, tester et supprimer l'ensemble, description de l'API pour le jury, rapport de tests, dossier de conception. L'adresse de l'application en ligne figure dans le README de cette branche. La présente branche ne contient que le code et l'infrastructure.

## Ce que fait l'application

- Identification d'un rédacteur par un nom et une adresse e-mail.
- Création de documents et partage par branche, avec des droits de lecture ou d'écriture et des invitations.
- Écriture simultanée, y compris au même endroit, sur Etherpad.
- Versions : clôture manuelle ou quotidienne, historique consultable, restauration dans une nouvelle branche.
- Liens de téléchargement en PDF dont le nombre d'exemplaires est fixé à la création. Le lien donne le document tel qu'il est au moment du téléchargement et ne change pas quand il est corrigé.
- Crédit d'écriture quotidien appliqué par le serveur, commun à tous les appareils d'un rédacteur.

Ne sont pas réalisés : l'e-mail au créateur au dernier téléchargement, le blocage des abus, la supervision et l'affichage des curseurs des autres rédacteurs. Le scénario de 15 000 visiteurs avec 300 rédacteurs n'a pas été exécuté. Le détail, avec les mesures, est dans le rapport de tests de la branche `documentation`.

## Architecture

- **Édition** : Etherpad 3.3.6 avec un plugin local (`ep_business`) qui contrôle l'accès, le gel des versions et le crédit d'écriture.
- **Backend** : Node.js et TypeScript (Fastify), base PostgreSQL.
- **Interface web** : Next.js.
- **Déploiement AWS** (région eu-north-1), décrit par un modèle CloudFormation : un équilibreur de charge, deux instances EC2 dans deux zones, une base RDS PostgreSQL, un bucket S3 privé, des secrets générés par AWS et un rôle IAM minimal. Un seul exemplaire d'Etherpad tourne, sur la première instance.

## Contenu de cette branche

| Chemin | Rôle |
|---|---|
| `application/backend/` | API, migrations SQL, tests unitaires et d'intégration |
| `application/frontend/` | Interface web Next.js |
| `application/plugins/` | Plugin Etherpad et correctif d'Etherpad |
| `application/deployment/` | Dockerfiles, Compose, configuration Nginx |
| `application/infra/` | Modèle CloudFormation `aws.yaml` et son guide |
| `application/ci-local.sh` | Tests reproductibles : installation, compilation, tests, images, migrations, intégration |
| `.github/workflows/` | `ci.yml` (à chaque pull request et sur `main`), `cd.yml` (publication manuelle des images) |

## Tester le code

Prérequis : Docker avec Compose, Node.js 20 ou plus. Depuis la racine du dépôt :

```sh
bash application/ci-local.sh
```

Le script monte une pile jetable, applique les migrations deux fois et rejoue les tests d'intégration. C'est aussi lui que GitHub exécute à chaque modification.

## Limites

L'identité fonctionne en mode local (un nom et une adresse suffisent, sans preuve de possession de l'adresse), le déploiement est en HTTP simple et la connexion à la base n'est pas chiffrée dans le réseau privé. Ces limites et les autres sont détaillées dans la documentation.
