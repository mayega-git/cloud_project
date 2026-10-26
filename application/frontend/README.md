# Frontend Next.js

Interface web du journal collaboratif : identification par code OTP, projets, branches et versions, invitations et collaborateurs, acceptation d'une invitation, ouverture de l'éditeur Etherpad.

## Lancer

Le backend et Etherpad doivent tourner (voir `../README.md`). Depuis `application/frontend/` :

```sh
npm ci
npm run build
npm start        # http://127.0.0.1:3001
```

`npm run dev` lance le mode développement sur le même port. Variables : voir `.env.example` (les valeurs par défaut conviennent à la pile locale).

## Fonctionnement

- Le navigateur n'appelle jamais le backend directement. Toutes les requêtes passent par `/backend/...`, un relais côté serveur (`app/backend/[...path]/route.ts`). Il évite le CORS, garde le cookie de session sur l'origine du frontend et présente au backend l'origine qu'attend Better Auth. Seules les routes utiles sont relayées : `/internal/*` et `/dev/mailbox` ne le sont pas.
- Pages : `/` (connexion, projets), `/projects/{id}` (branches), `/projects/{id}/branches/{id}` (versions, partage), `/invite#invite=...` (acceptation).
- L'éditeur s'ouvre dans un **nouvel onglet** et non dans une iframe : Etherpad refuse de fonctionner dans une iframe d'une autre origine en HTTP, car son cookie de préférences exige `SameSite=None`, donc HTTPS. Sans nom de domaine, il n'y a pas de HTTPS.

## Vérifié

Build de production et contrôle de types réussis. Un essai Playwright sur la pile locale (deux rédacteurs) a réussi : connexion par OTP, création d'un projet, ouverture de l'éditeur depuis la page, invitation en écriture, acceptation par le second rédacteur, lecture du même texte dans l'éditeur. Le relais bloque `/internal/*` et `/dev/mailbox` (404).

## Limites

- Le lien reçu par e-mail pointe vers `/app` du backend, pas vers `/invite` de ce frontend : remplacer `/app` par `/invite` à l'adresse, ou utiliser l'interface `/app` du backend.
- Pas de clôture manuelle, de consultation de révision ni de restauration dans l'interface (les routes existent côté backend).
- Pas encore de conteneur, ni de service dans le déploiement AWS : le frontend tourne seulement en local.
- En mode local, le code OTP se lit dans la boîte de test du backend (`/dev/mailbox`) ; aucun SMTP n'est configuré.
