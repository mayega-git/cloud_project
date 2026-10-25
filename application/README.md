# Application locale : branches et versions métier

Ce MVP utilise Etherpad 3.3.6, PostgreSQL 15, un backend TypeScript/Fastify et un plugin Etherpad local. Il crée des branches et des versions métier, ferme une version manuellement ou à la fin de la journée du propriétaire, et restaure une révision vers une branche indépendante. La vérification de l'adresse par code à usage unique (OTP e-mail, Better Auth) et le partage par invitation de branche sont intégrés en local. Le quota, les PDF, les liens de téléchargement limités, les notifications et AWS restent à développer.

## Démarrer

Prérequis : Docker Compose, Node.js 20 ou plus, npm, OpenSSL et ports locaux 5432, 3000 et 9001 libres. Depuis `application/` :

```sh
bash setup-local.sh
cd backend && npm ci && npm run build && cd ..
docker compose --env-file .env -f deployment/compose.yaml build
docker compose --env-file .env -f deployment/compose.yaml up -d postgres
docker compose --env-file .env -f deployment/compose.yaml run --rm --no-deps backend node dist/database.js
docker compose --env-file .env -f deployment/compose.yaml up -d
curl http://127.0.0.1:3000/health
```

Exécuter les migrations avant le backend ; elles sont idempotentes. `setup-local.sh` préserve les secrets existants et crée ceux qui manquent dans `.env` et `.secrets/`, exclus de Git. La passerelle de l'éditeur écoute sur `127.0.0.1:9001` et refuse les API administratives aux navigateurs. Les anciens pads locaux restent stockés mais sont isolés du nouveau parcours métier.

## Essayer

L'identité de développement est **réservée au mode local** : nom et e-mail déclarés, sans vérification de possession. Elle crée un cookie opaque dont seul le hachage est stocké. Cet adaptateur ne convient pas à un déploiement public.

```sh
curl -c /tmp/cloud-session-cookie -H 'content-type: application/json' \
  -d '{"name":"Alice","email":"alice@example.test"}' \
  http://127.0.0.1:3000/dev/sessions
curl -b /tmp/cloud-session-cookie -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-document-001' \
  -d '{"title":"Journal","ownerTimeZone":"Africa/Abidjan"}' \
  http://127.0.0.1:3000/documents
```

La réponse contient `branchId`, `versionId`, `padId` et `editorUrl`. Pour ouvrir l'éditeur dans le navigateur, créer aussi une session dans ce navigateur depuis la console sur `http://127.0.0.1:3000/health` :

```js
await fetch('/dev/sessions', {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({name: 'Alice', email: 'alice@example.test'})});
```

Ouvrir ensuite `editorUrl`. Le cookie créé par `curl` n'est pas partagé avec le navigateur. Un accès direct au pad sans session autorisée échoue. Pour attribuer un droit local à un autre rédacteur, créer sa session puis appeler `PUT /branches/{branchId}/permissions/{userId}` avec `{"access":"READ"}` ou `{"access":"WRITE"}`.

## Vérification d'adresse et invitations

- Better Auth 1.7.13 (Email OTP, adaptateur PostgreSQL) répond sous `/api/auth/*`. Une fois l'adresse vérifiée, `POST /auth/complete` crée la session métier (cookie opaque). La configuration est dans `backend/src/better-auth.ts`.
- `GET /app` sert une interface locale de base (`backend/public/app.html`). Seul son rendu de base a été observé ; elle n'est pas validée de bout en bout dans un navigateur.
- En mode local (`APP_ENV=local`), les messages ne sont pas envoyés : ils restent dans une boîte mémoire lisible via `GET /dev/mailbox?email=...` avec l'en-tête `x-internal-key`. Ils disparaissent au redémarrage. Un SMTP (`SMTP_*`) n'est pas vérifié, et l'envoi n'est ni une file durable ni exactement-une-fois.
- Le propriétaire invite une adresse, même inconnue, avec un droit `READ` ou `WRITE` sur une branche. Le destinataire vérifie la même adresse puis accepte explicitement : ouvrir le lien n'accorde aucun droit. Renvoyer invalide l'ancien lien ; expiration ou révocation interdit l'acceptation. Seul le propriétaire invite.

## Interfaces disponibles

Toutes les routes métier exigent le cookie, sauf `/health`, `/dev/sessions`, `/api/auth/*`, `/auth/complete` (session Better Auth requise) et `/app`. Les créations exigent `Idempotency-Key` (8 à 128 caractères). Les erreurs JSON utilisent `error.code` et `error.message` en anglais.

| Requête | Effet |
|---|---|
| `POST /documents` | Créer document, branche 1 et version 1 ; corps `title`, `ownerTimeZone` IANA. |
| `GET /documents/{id}/branches` | Lister les branches visibles. |
| `GET /branches/{id}/versions` | Lister les versions. |
| `GET /versions/{id}/content?revision=n` | Lire texte et HTML d'une révision autorisée. |
| `PUT/DELETE /branches/{id}/permissions/{userId}` | Accorder ou retirer le droit de branche ; propriétaire seulement. |
| `POST /branches/{id}/closures` | Demander une clôture manuelle ; propriétaire seulement. |
| `GET /closures/{operationId}` | Suivre la clôture et retrouver le successeur. |
| `POST /versions/{id}/restorations` | Restaurer `{"revision": n}` vers une nouvelle branche. |
| `GET /restorations/{operationId}` | Suivre la restauration et retrouver la nouvelle branche. |

Routes de projet et de partage (corps exacts dans `backend/src/server.ts`) :

| Requête | Effet |
|---|---|
| `POST /projects`, `GET /projects`, `GET /projects/{id}`, `GET /projects/{id}/branches` | Créer (adresse vérifiée exigée) et consulter les projets. |
| `POST /branches/{id}/invitations` | Inviter `{"email", "access": "READ"\|"WRITE"}`, avec `Idempotency-Key`. |
| `GET /branches/{id}/invitations`, `GET /branches/{id}/collaborators` | Lister invitations et collaborateurs. |
| `PUT/DELETE /branches/{id}/collaborators/{userId}` | Modifier ou retirer un droit. |
| `POST /invitations/{id}/resend`, `DELETE /invitations/{id}` | Renvoyer (ancien lien invalidé) ou révoquer. |
| `POST /invitations/preview`, `POST /invitations/accept` | Aperçu puis acceptation explicite avec `{"token"}`. |

Les deux demandes longues retournent `202` et un `operationId` : la clôture ou la restauration n'est pas encore terminée. Le worker reprend les traitements après redémarrage. Il recherche les échéances quotidiennes toutes les secondes ; la journée suit le fuseau IANA déclaré à la création et peut durer 23 ou 25 heures. Après plusieurs jours d'arrêt, une seule transition est lancée par branche. À titre provisoire, elle est effectuée même sans modification, et le fuseau n'est pas modifiable.

## Organisation et limites

- `backend/migrations/` crée le schéma `business`, distinct des tables Etherpad. `backend/src/domain/` contient le service, les permissions, les sessions et le calendrier.
- `plugins/ep_business/` contrôle les connexions et écritures. `plugins/patch-etherpad.py` ajoute une décision d'admission et une barrière **dans la file ordonnée du pad**. L'image est construite par `deployment/Dockerfile.etherpad` ; aucune modification manuelle du conteneur n'est nécessaire.
- `deployment/nginx.conf` bloque l'API administrative du navigateur. Les clés restent dans `.secrets/`.
- Le client conserve localement un texte récupérable lors de l'arrêt de l'édition. Il peut contenir le document complet et des contributions déjà enregistrées ; il n'est jamais réinséré automatiquement.

Une opération reçue est arrivée au serveur ; admise signifie que le contrôle dans la file l'autorise avant l'échéance ; enregistrée signifie qu'Etherpad a ajouté sa révision ; acquittée signifie que le client a reçu `ACCEPT_COMMIT`. Les trois secondes bornent l'admission, non la fin de tous les traitements.

Le quota de 10 000 caractères est **non implémenté**. La copie structurelle n'est actuellement pas facturée ; sa politique définitive reste à valider. Les pannes à chaque étape critique, la concurrence entre plusieurs instances backend, la reconnexion après une longue coupure, 300 rédacteurs et 15 000 visiteurs ne sont pas qualifiés. Un pad créé mais non référencé après un échec peut demander un inventaire manuel ; aucun nettoyage destructif automatique n'est lancé.

## Vérifier

Le chemin reproductible est `bash ci-local.sh` (installation verrouillée, build, tests unitaires, validation Compose, construction des images, migrations rejouées, tests d'intégration sur une pile jetable de projet `ci-local`). Options : `--skip-docker`, `--keep`, `--no-build` (réutilise les images locales), `--local-db` (utilise le PostgreSQL de développement déjà démarré, dans une base `ci_test` créée puis supprimée). Le même script est exécuté par `.github/workflows/ci.yml` sur les pull requests, sans secret ni déploiement.

Pas à pas :

```sh
cd backend && npm run build && npm test && cd ..
docker compose --env-file .env -f deployment/compose.yaml run --rm --no-deps \
  -e RUN_INTEGRATION=1 -e BUSINESS_BASE_URL=http://backend:3000 \
  backend node --test dist/domain/business.integration.test.js dist/domain/invitation.integration.test.js
docker compose --env-file .env -f deployment/compose.yaml logs --tail=100 etherpad backend
```

Les tests d'intégration exigent les conteneurs démarrés et les migrations exécutées. Aucun service AWS n'est déployé.
