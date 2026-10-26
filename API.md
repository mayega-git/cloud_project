# Description de l'API

Ce document décrit les routes implémentées et testées, avec ce qu'un test doit envoyer et ce qu'il doit recevoir. Il suffit pour écrire un test sans lire le code. La référence exacte est `application/backend/src/server.ts`, sur la branche `main`. Une route absente de ce document n'est pas destinée aux tests.

## 1. Points d'entrée

| Entrée | Adresse | Rôle |
|---|---|---|
| API | `http://<hôte>/` (port 80) | Toutes les routes décrites ici, servies par l'un des deux backends |
| Éditeur | `http://<hôte>:9001/` | Etherpad, protégé par le même cookie de session |
| Interface web | `http://<hôte>:3001/` | Interface Next.js, inutile pour tester l'API |

Le backend sert aussi `GET /app`, une ancienne page de test en HTML, qui n'est pas destinée aux tests. En local, l'API écoute sur `http://127.0.0.1:3000` et l'éditeur sur `http://127.0.0.1:9001`. Dans les exemples, `$BASE_URL` désigne l'adresse de l'API, par exemple `http://<hôte>`.

Le déploiement fonctionne en **mode d'identité local** (`APP_ENV=local`). Les routes `/dev/sessions`, `/documents`, `/branches/{id}/permissions/...` et `/dev/mailbox` n'existent que dans ce mode et répondent 404 ailleurs. Le sujet demande qu'un nom et une adresse suffisent à identifier un rédacteur : ce mode le fait sans prouver que l'adresse appartient à la personne.

## 2. Conventions

- Les corps de requête et de réponse sont du JSON (`content-type: application/json`), sauf le PDF de `GET /d/{token}`.
- La session est portée par le cookie `business_session` (`HttpOnly`, `SameSite=Lax`, durée 12 heures). Un client HTTP doit le renvoyer à chaque requête. Un cookie posé pour un hôte vaut pour tous les ports de cet hôte : la session ouverte sur l'API est donc valable sur l'éditeur (port 9001).
- Les créations (`POST /documents`, `POST /projects`, invitations, clôtures, restaurations) exigent l'en-tête `Idempotency-Key` de 8 à 128 caractères. Rejouer la même clé avec les mêmes paramètres désigne la même ressource ; avec des paramètres différents, la réponse est `409 IDEMPOTENCY_CONFLICT`.
- Les identifiants (`documentId`, `branchId`, `versionId`, `userId`, `operationId`) sont des UUID. Un identifiant mal formé donne `400 INVALID_ID`.
- Les opérations longues (clôture, restauration) répondent `202` avec un `operationId` : ce n'est pas une confirmation de fin. Il faut interroger l'opération jusqu'à `COMPLETED` ou `FAILED`.
- Toute erreur a la forme `{"error": {"code": "...", "message": "..."}}`. Les codes et messages sont en anglais.

## 3. Codes d'erreur

| Statut | Code | Signification |
|---|---|---|
| 400 | `INVALID_BODY` | Un objet JSON est attendu |
| 400 | `INVALID_IDENTITY` | Nom ou adresse invalide (`/dev/sessions`) |
| 400 | `INVALID_DOCUMENT`, `INVALID_PROJECT` | Titre absent ou trop long (200 caractères), fuseau manquant |
| 400 | `INVALID_TIME_ZONE` | Le fuseau n'est pas un identifiant IANA |
| 400 | `INVALID_IDEMPOTENCY_KEY` | Clé absente ou hors de 8 à 128 caractères |
| 400 | `INVALID_ID` | Identifiant qui n'est pas un UUID |
| 400 | `INVALID_ACCESS` | Le droit doit valoir `READ` ou `WRITE` |
| 400 | `OWNER_PERMISSION` | Le droit du propriétaire ne se modifie pas |
| 400 | `INVALID_REVISION` | Révision non entière, négative ou hors de l'historique |
| 400 | `INVALID_LIMIT` | `maxDownloads` n'est pas un entier entre 1 et 1 000 000 |
| 400 | `INVALID_COST` | Coût d'écriture invalide (route interne de l'éditeur, section 8) |
| 400 | `INVALID_INVITATION`, `INVALID_TOKEN`, `INVALID_EMAIL` | Invitation, jeton ou adresse mal formés |
| 401 | `UNAUTHENTICATED` | Session absente ou expirée |
| 401 | `VERIFIED_SESSION_REQUIRED` | La route exige une session vérifiée |
| 401 | `EMAIL_NOT_VERIFIED` | Aucune adresse vérifiée (`/auth/complete`) |
| 403 | `FORBIDDEN` | Droit insuffisant sur la ressource |
| 403 | `EMAIL_MISMATCH` | L'adresse vérifiée n'est pas celle de l'invitation |
| 403 | `CREDIT_EXHAUSTED` | Crédit du jour épuisé (voir section 8, route interne à l'éditeur) |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND`, `INVITATION_NOT_FOUND`, `COLLABORATOR_NOT_FOUND` | Ressource inconnue ou inaccessible |
| 409 | `VERSION_NOT_OPEN` | Aucune version ouverte à écrire ou à clore |
| 409 | `IDEMPOTENCY_CONFLICT` | La clé appartient à une autre requête |
| 409 | `PENDING_INVITATION_EXISTS`, `ACCESS_ALREADY_GRANTED`, `INVITATION_NOT_PENDING`, `INVITATION_ALREADY_ACCEPTED`, `INVITATION_REVOKED` | États d'invitation incompatibles |
| 410 | `LINK_EXHAUSTED` | Le lien de téléchargement n'a plus d'exemplaire |
| 410 | `INVITATION_EXPIRED` | Invitation expirée |
| 502 | `DEPENDENCY_FAILURE` | Etherpad ou un autre service est indisponible |

## 4. Identification

### `POST /dev/sessions` (mode local)

Ouvre une session à partir d'un nom et d'une adresse. Aucune authentification préalable.

| Champ | Type | Règle |
|---|---|---|
| `name` | texte | 1 à 100 caractères |
| `email` | texte | adresse de forme valide |
| `verified` | booléen, facultatif | `true` pose une session dite vérifiée, sans code (voir plus bas) |

Réponse `201` : `{"userId": "<uuid>"}` et l'en-tête `Set-Cookie: business_session=...`. Erreur `400 INVALID_IDENTITY`.

Deux appels avec la même adresse désignent le **même rédacteur** (même `userId`) avec deux sessions distinctes, ce qui représente deux appareils. L'adresse est normalisée en minuscules.

```sh
curl -s -c alice.jar -H 'content-type: application/json' \
  -d '{"name":"Alice","email":"alice@example.test"}' $BASE_URL/dev/sessions
```

Une session ordinaire suffit pour les documents, les versions, les clôtures, les restaurations, les liens de téléchargement et les droits. Une session **vérifiée** est exigée pour `POST /projects`, les invitations et les collaborateurs (section 10). Avec `"verified": true`, ce raccourci du mode local la fournit sans prouver la possession de l'adresse.

### Code par e-mail (comptes vérifiés)

Le parcours normal passe par Better Auth : `POST /api/auth/email-otp/send-verification-otp` (corps `email`, `type: "sign-in"`), puis `POST /api/auth/sign-in/email-otp` (corps `email`, `otp`, `name`), puis `POST /auth/complete` qui renvoie le cookie de session vérifiée. Ces requêtes portent un en-tête `Origin` égal à l'adresse de base du backend. En mode local, le message n'est pas envoyé : il reste dans une boîte mémoire propre à chaque instance backend (`GET /dev/mailbox?email=...`, protégé par une clé interne). Aucun SMTP n'est configuré sur le déploiement AWS : ce parcours n'y est pas utilisable par un test. Utiliser `verified: true`.

## 5. Documents, branches et droits

### `POST /documents` (mode local, session)

Crée un document, sa branche initiale, sa version V1 ouverte et son pad.

Corps : `{"title": "texte, 1 à 200 caractères", "ownerTimeZone": "Europe/Paris"}`, plus `Idempotency-Key`.

Réponse `201` :

```json
{"id": "<documentId>", "title": "...", "ownerId": "<userId>", "ownerTimeZone": "Europe/Paris",
 "branchId": "<branchId>", "versionId": "<versionId>", "padId": "business-<uuid>",
 "state": "OPEN", "editorUrl": "http://<hôte>:9001/p/business-<uuid>"}
```

Erreurs : `400 INVALID_DOCUMENT`, `INVALID_TIME_ZONE`, `INVALID_IDEMPOTENCY_KEY`, `401 UNAUTHENTICATED`, `409 IDEMPOTENCY_CONFLICT`. L'identité du propriétaire est celle de la session. Le fuseau fixe l'heure de la clôture quotidienne ; il ne se modifie pas.

### `GET /documents/{documentId}/branches` et `GET /projects/{documentId}/branches` (session)

Liste les branches visibles par le rédacteur (propriétaire ou titulaire d'un droit). Réponse `200` : tableau d'objets

```json
{"id": "<branchId>", "number": 1, "activeVersionId": "<versionId>",
 "sourceBranchId": null, "sourceVersionId": null, "sourceRevision": null}
```

Les trois champs `source...` sont renseignés pour une branche créée par restauration.

### `PUT /branches/{branchId}/permissions/{userId}` (mode local, propriétaire)

Corps : `{"access": "READ"}` ou `{"access": "WRITE"}`. Réponse `204`. `READ` permet de lire la branche et son historique. `WRITE` inclut `READ` et permet d'écrire dans la seule version active ouverte. Les droits sont attachés à la branche et suivent le passage de V1 à V2. Erreurs : `403 FORBIDDEN` (non propriétaire), `400 OWNER_PERMISSION`, `404 USER_NOT_FOUND`.

`DELETE /branches/{branchId}/permissions/{userId}` retire le droit (réponse `204`). L'identifiant à fournir est le `userId` renvoyé par `POST /dev/sessions` du rédacteur concerné.

## 6. Versions, historique, clôture et restauration

États d'une version : `OPEN` (modifiable), `CLOSING` (fermeture en cours), `FROZEN` (figée, lecture seule). Chaque version a son pad distinct.

### `GET /branches/{branchId}/versions` (session, droit `READ`)

Réponse `200` : tableau trié par numéro, objets `{"id", "number", "padId", "state", "finalRevision"}`. `finalRevision` vaut `null` tant que la version n'est pas figée.

### `GET /versions/{versionId}/content?revision=n` (session, droit `READ`)

Sans `revision`, lit la révision courante. Réponse `200` :

```json
{"versionId": "<uuid>", "revision": 12, "text": "texte brut", "html": "<html>...</html>"}
```

Erreurs : `400 INVALID_REVISION` (révision négative, non entière ou au-delà de la révision finale), `403 FORBIDDEN`, `404 NOT_FOUND`. C'est la route à utiliser pour lire ce que le serveur a réellement conservé.

### `POST /branches/{branchId}/closures` (session, propriétaire)

Demande la clôture de la version active, avec `Idempotency-Key`. Réponse `202` : `{"operationId", "state", "admissionDeadline"}`. Les écritures déjà admises dans les trois secondes suivant la demande (horloge du serveur) sont traitées, puis la version est figée et la suivante est créée avec le même contenu. Erreurs : `403 FORBIDDEN`, `409 VERSION_NOT_OPEN`. Demander une clôture alors qu'une est en cours renvoie la clôture existante.

`GET /closures/{operationId}` (droit `READ`) : `{"operationId", "state", "finalRevision", "successorVersionId", "error"}`, avec `state` parmi `WAITING`, `DRAINING`, `COPYING`, `COMPLETED`, `FAILED`.

### `POST /versions/{versionId}/restorations` (session, propriétaire)

Corps : `{"revision": 3}` (entier positif ou nul), plus `Idempotency-Key`. Crée une **nouvelle branche** avec son pad, à partir de cette révision. La source n'est pas modifiée et les droits des collaborateurs ne sont pas copiés. Réponse `202` : `{"operationId", "state"}`.

`GET /restorations/{operationId}` (propriétaire) : `{"operationId", "state", "destinationBranchId", "error"}`, avec `state` parmi `COPYING`, `COMPLETED`, `FAILED`.

## 7. Liens de téléchargement (C1, C3, C6)

Un lien donne le document au format PDF, tel qu'il est au moment du téléchargement, un nombre de fois choisi à la création. Le lien ne change pas quand le document est corrigé. Il désigne une branche : après une clôture, il suit la version active.

### `POST /branches/{branchId}/download-links` (session, propriétaire)

Corps : `{"maxDownloads": 500}` (entier de 1 à 1 000 000). Réponse `201` :

```json
{"linkId": "<uuid>", "url": "http://<hôte>/d/<64 caractères hexadécimaux>", "maxDownloads": 500}
```

L'adresse complète n'est renvoyée **qu'une fois** ; seule son empreinte est conservée. Pour un test, ne retenir que le chemin `/d/<jeton>` et le faire suivre de `$BASE_URL` : l'hôte et le port figurant dans `url` dépendent de la configuration du backend. Erreurs : `400 INVALID_LIMIT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` (non propriétaire).

### `GET /branches/{branchId}/download-links` (session, propriétaire)

Réponse `200` : tableau `{"id", "maxDownloads", "remaining", "createdAt"}`. Les jetons n'y figurent pas.

### `GET /d/{token}` (public, sans session)

Les visiteurs n'ont aucune identité. Réponses :

| Statut | Cas | Contenu |
|---|---|---|
| 200 | Un exemplaire est servi | PDF (`content-type: application/pdf`, `content-disposition: attachment; filename="document.pdf"`, `cache-control: no-store`), en-tête `x-remaining-downloads` : nombre restant après celui-ci |
| 410 | Plus d'exemplaire | `{"error": {"code": "LINK_EXHAUSTED", ...}}` |
| 404 | Jeton inconnu ou mal formé | `NOT_FOUND` |
| 502 | Etherpad indisponible | `DEPENDENCY_FAILURE`, l'exemplaire réservé est rendu |

### `GET /d/{token}/status` (public)

Réponse `200` : `{"state": "AVAILABLE" | "EXHAUSTED", "remaining": 3}`. Ne consomme rien. `404` si le jeton est inconnu.

### Comportement garanti et limites

- Un exemplaire est **réservé** par une seule mise à jour conditionnelle en base (`remaining` décrémenté seulement s'il est positif) avant toute génération de PDF. Un lien épuisé ne déclenche donc aucun travail de génération. Si la production du PDF échoue, l'exemplaire est rendu.
- Le téléchargement est compté à la réservation, pas à la réception complète du fichier par le navigateur.
- Le contenu est le texte de la version active au moment de la requête, c'est-à-dire les modifications déjà acceptées et enregistrées par l'éditeur.
- Le PDF est du texte brut en Helvetica, format A4, environ 50 lignes par page. Les accents du jeu Latin-1 sont conservés ; les autres caractères sont remplacés par `?`. La mise en forme (gras, listes) n'est pas reproduite.
- Aucun e-mail n'est envoyé au créateur au dernier exemplaire.

## 8. Crédit d'écriture (C4)

Chaque rédacteur dispose de 10 000 caractères par jour, commun à tous ses appareils, documents et branches. Règle appliquée :

- une modification coûte le nombre de caractères qu'elle **insère** ; les suppressions et la mise en forme ne coûtent rien ;
- une modification qui dépasserait le crédit est refusée en entier et n'est pas enregistrée ;
- le jour du crédit est le jour UTC, indépendant de la clôture quotidienne des versions ;
- la copie initiale d'une version ou d'une restauration n'est pas débitée ;
- le débit précède l'écriture : si Etherpad échoue après un débit, le crédit est perdu, jamais dépassé.

Il n'existe **pas de route publique** pour le crédit. Le contrôle s'exerce dans l'éditeur, à chaque modification, par un appel interne (`POST /internal/editor-access`, protégé par une clé interne, non accessible depuis l'extérieur). Pour tester : écrire dans le pad depuis un navigateur, puis relire le texte conservé avec `GET /versions/{versionId}/content`. Le script `tests/credit-paste.mjs` le fait : 9 000 caractères sont conservés, les 2 000 suivants sont refusés et absents du texte relu.

Limite connue : l'écran de l'éditeur ne prévient pas le rédacteur d'un refus et continue d'afficher le texte refusé, que le serveur n'a pas enregistré. Recharger la page montre ce qui est réellement sauvegardé.

## 9. Édition simultanée, présence

Le pad s'ouvre à l'`editorUrl` renvoyé par `POST /documents`. L'accès exige le cookie de session de l'hôte : le propriétaire et les titulaires de `WRITE` écrivent dans la version active ouverte, les titulaires de `READ` lisent, un rédacteur sans droit ou sans session reçoit `401`. Les échanges temps réel passent par Socket.IO (`/socket.io/`, WebSocket) sur le port 9001.

Pour tester l'écriture simultanée, il faut piloter un vrai navigateur (Playwright, Chrome) avec deux contextes, un par rédacteur, chacun ayant ouvert sa session par `POST /dev/sessions`. Le texte se lit dans les cadres imbriqués `iframe[name="ace_outer"]` puis `iframe[name="ace_inner"]`. Deux rédacteurs qui tapent au même endroit voient le même document final, avec les caractères entrelacés.

Ce que l'éditeur n'expose pas : les curseurs des autres rédacteurs ne s'affichent pas, et la liste des participants indique un compteur sans nom.

## 10. Projets, invitations et collaborateurs (sessions vérifiées)

| Route | Corps | Réponse |
|---|---|---|
| `POST /projects` | `title`, `ownerTimeZone`, `Idempotency-Key` | `201`, objet du document plus `projectId` et `editorUrl` |
| `GET /projects` | | `200`, tableau `{"projectId", "title", "ownerTimeZone", "isOwner"}` |
| `GET /projects/{projectId}` | | `200`, même objet ; `404` si inaccessible |
| `GET /projects/{projectId}/branches` | | `200`, branches (voir section 5) |
| `POST /branches/{id}/invitations` | `email`, `access` (`READ` ou `WRITE`), `Idempotency-Key` | `201`, invitation |
| `GET /branches/{id}/invitations` | | `200`, tableau d'invitations (propriétaire) |
| `POST /invitations/{id}/resend` | `access` facultatif | `200`, invitation ; l'ancien lien est invalidé |
| `DELETE /invitations/{id}` | | `204`, invitation révoquée |
| `POST /invitations/preview` | `token` (64 caractères hexadécimaux) | `200`, `{"projectTitle", "email", "access", "state", "expiresAt"}` |
| `POST /invitations/accept` | `token` | `200`, invitation acceptée ; exige l'adresse vérifiée de l'invitation |
| `GET /branches/{id}/collaborators` | | `200`, tableau `{"userId", "name", "email", "access"}` |
| `PUT /branches/{id}/collaborators/{userId}` | `access` | `204` |
| `DELETE /branches/{id}/collaborators/{userId}` | | `204` |

Une invitation est `{"id", "branchId", "email", "access", "state", "emailStatus", "expiresAt", "emailAttempts"}`, avec `state` parmi `PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`. Ouvrir le lien reçu n'accorde aucun droit : le destinataire doit vérifier la même adresse, puis accepter explicitement. Seul le propriétaire invite. En mode local, `emailStatus: "SENT"` signifie que le message a été déposé dans la boîte mémoire, pas qu'un e-mail est parti.

## 11. Santé

`GET /health` (public) : `{"status": "ok", "quota": "DAILY_WRITE_CREDIT", "authentication": "LOCAL_ONLY"}`. À utiliser comme sonde de disponibilité.

## 12. Scénarios de test prêts à rejouer

Dans les exemples, `$BASE_URL` est l'adresse de l'API.

**C1, plafond de téléchargements.** Créer un document puis un lien limité, et le solliciter en parallèle.

```sh
curl -s -c o.jar -H 'content-type: application/json' -d '{"name":"Owner","email":"owner@example.test"}' $BASE_URL/dev/sessions
BRANCH=$(curl -s -b o.jar -H 'content-type: application/json' -H 'Idempotency-Key: demo-document-0001' \
  -d '{"title":"Test","ownerTimeZone":"Europe/Paris"}' $BASE_URL/documents | sed -E 's/.*"branchId":"([^"]+)".*/\1/')
LINK=$(curl -s -b o.jar -H 'content-type: application/json' -d '{"maxDownloads":3}' \
  $BASE_URL/branches/$BRANCH/download-links | sed -E 's/.*"url":"https?:\/\/[^\/]+(\/d\/[0-9a-f]+)".*/\1/')
seq 1 50 | xargs -P 25 -I{} curl -s -o /dev/null -w '%{http_code}\n' $BASE_URL$LINK | sort | uniq -c
curl -s $BASE_URL$LINK/status
```

Résultat attendu : exactement trois réponses `200`, quarante-sept réponses `410`, puis `{"state":"EXHAUSTED","remaining":0}`. Le script `tests/c1-download-limit.mjs` rejoue le même contrôle avec une limite de 1 puis de 500.

**C3, document à jour.** Écrire du texte dans le pad (navigateur), télécharger le PDF, modifier le texte, télécharger de nouveau avec le même lien : le second PDF contient le texte modifié et le compteur a baissé de deux.

**Contrôle d'accès.** Sans cookie, `GET /branches/{id}/versions` renvoie `401`. Avec la session d'un autre rédacteur, la création d'un lien renvoie `403`. Après `PUT /branches/{id}/permissions/{userId}` avec `READ`, la lecture des versions passe en `200`, et l'ouverture du pad en écriture reste refusée tant que le droit n'est pas `WRITE`.

**Versions.** Créer un document, écrire du texte, `POST /branches/{id}/closures`, interroger `GET /closures/{operationId}` jusqu'à `COMPLETED`, puis `GET /branches/{id}/versions` : V1 est `FROZEN` avec une `finalRevision`, V2 est `OPEN`. Une restauration crée une branche indépendante.

**C4, crédit.** `tests/credit-paste.mjs`.

## 13. Ce qui n'est pas implémenté

- Aucun e-mail au dernier téléchargement d'un lien.
- Pas de détection ni de blocage des abus.
- Pas de route de supervision (documents ouverts, liens actifs et restants, personnes bloquées) : seule la liste des liens d'une branche, par son propriétaire, existe.
- Les curseurs des autres rédacteurs ne s'affichent pas.
- PDF en texte brut seulement.
- Aucune mesure sur 15 000 visiteurs ni 300 rédacteurs simultanés.
