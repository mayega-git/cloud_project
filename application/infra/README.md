# Infrastructure AWS : déployer, tester, supprimer

`aws.yaml` est un modèle CloudFormation utilisé pour créer la pile `cloud-project-infra` en `eu-north-1`, dans le VPC par défaut. Le premier démarrage a échoué lors de la migration PostgreSQL, car RDS imposait TLS alors que le backend et Etherpad se connectaient sans chiffrement. Le groupe de paramètres a ensuite fixé `rds.force_ssl=0`. Les résultats consignés après le déploiement sont résumés ci-dessous ; ils ne couvrent ni la charge, ni les arrêts de composants, ni le coût. Ce guide conserve les procédures de création, de vérification et de suppression pour une éventuelle recréation.

## Architecture

| Élément | Rôle |
|---|---|
| ALB, port 80 | Entrée de l'application, vers le backend de A et de B (contrôle `/health`) |
| ALB, port 9001 | Entrée de l'éditeur, vers la passerelle Nginx de A et de B (contrôle `/health`) |
| Instance A (zone 1) | Backend, passerelle Nginx et **l'unique Etherpad**. Applique les migrations une seule fois |
| Instance B (zone 2) | Backend et passerelle Nginx. Relaie l'édition vers l'Etherpad de A (adresse privée de A transmise par la pile), démarre quand le backend de A répond |
| RDS PostgreSQL (une zone, non public) | Données métier, sessions et données Etherpad, partagées par A et B. Les sous-réseaux du VPC par défaut sont publics : seule la règle du groupe de sécurité (5432 depuis les instances) et `PubliclyAccessible: false` le protègent |
| ALB, port 3001 | Interface web Next.js (`FrontendUrl`), déployée et vérifiée le 26 octobre 2026 (page, connexion rapide, création de projet, éditeur ouvert depuis la page : `curl` et Playwright). Version écrite et validée localement, pas encore déployée : routage **par chemin** (`/backend/*` et `/d/*` vers le groupe des backends, le reste vers les frontends), pour qu'aucun frontend ne dépende d'un backend précis. |
| Bucket S3 privé | Réservé aux futurs PDF (aucun code ne l'utilise encore) |
| Secrets Manager | Clés et mots de passe générés par AWS, lus au démarrage par le rôle de l'instance |

La pile déployée possède trois listeners HTTP : 80, 9001 et 3001. Dans la version déployée, chaque conteneur `frontend` relaie les appels vers le backend de sa propre instance : arrêter ce backend a fait échouer environ la moitié des appels de l'interface (mesuré : 19 erreurs sur 40, puis 18 sur 40), alors que le port 80 est resté à 40 sur 40. La version du modèle présente dans le dépôt corrige ce couplage par le routage par chemin de l'ALB ; elle reste à déployer et à mesurer de la même façon.

Les deux instances sont dans des sous-réseaux publics avec une adresse IPv4 publique (pour télécharger les paquets et les images), mais leurs ports applicatifs sont configurés pour recevoir le trafic du groupe de sécurité de l'ALB. Le modèle courant décrit les ports 3000, 3001 et 9001 ; le port 3001 n'a pas été vérifié dans la pile active. Pas de NAT Gateway. L'administration passe par AWS Systems Manager (session sans port SSH). En secours, deux paramètres facultatifs ouvrent le port 22 à **votre adresse seulement** (`SshCidr`) et associent une paire de clés (`KeyPairName`) ; vides, aucune règle SSH n'existe. Les métadonnées de l'instance exigent IMDSv2 avec un saut maximal de 1 ; la configuration vise à empêcher le passage des identifiants du rôle aux conteneurs.

## Prérequis

1. Fusionner le correctif du lien d'éditeur de `/app` dans `main`, puis lancer le workflow manuel « Publish images » (onglet Actions). Noter les deux références `ghcr.io/...:<sha>@sha256:...` du résumé.
2. Rendre les deux paquets GHCR publics (page du paquet, Package settings), sinon les instances ne pourront pas les télécharger (aucun jeton n'est prévu).
3. Vérifier dans la console EC2 et RDS que les types d'instance par défaut (`t3.small`, `t3.micro`, `db.t3.micro`) sont autorisés par votre plan en **eu-north-1**. Sinon, les changer dans les paramètres.
4. Créer un budget d'alerte dans AWS Budgets : il prévient, il ne coupe rien.

## Déployer (console, sans CLI)

1. Console AWS, région **eu-north-1**, service CloudFormation, **Create stack**, **With new resources**.
2. Charger `application/infra/aws.yaml`.
3. Renseigner : `VpcId` (le VPC par défaut, repéré dans la liste), `SubnetAId` et `SubnetBId` (deux sous-réseaux de ce VPC dans **deux zones différentes**), `AllowedCidr` (par exemple votre adresse en `x.x.x.x/32`), `BackendImage` et `EtherpadImage`. Facultatif : `SshCidr` (votre adresse en `x.x.x.x/32`) et `KeyPairName` (une paire de clés créée avant dans la console EC2, dont le fichier privé reste hors du dépôt).
4. Cocher la case qui autorise la création de ressources IAM, puis créer la pile.
5. Attendre `CREATE_COMPLETE`. L'onglet Sorties donne `PublicUrl`, `EditorUrl`, le bucket et les identifiants des instances.
6. En cas d'échec de démarrage : console EC2, instance, Actions, Surveillance et dépannage, **Obtenir le journal système** (sans connexion), ou session Systems Manager puis `sudo tail -n 100 /var/log/app-bootstrap.log` et `sudo docker compose --env-file /opt/app/.env -f /opt/app/compose.yaml ps`.
7. Le script de démarrage ne s'exécute qu'une fois, au premier démarrage. Après avoir corrigé la cause d'un échec, relancer à la main sur l'instance A (en session Systems Manager) :
   ```sh
   cd /opt/app
   DC="sudo docker compose --env-file /opt/app/.env -f /opt/app/compose.yaml"
   $DC --profile a up -d etherpad
   $DC run --rm --no-deps backend node dist/database.js
   $DC --profile a up -d backend gateway
   ```
   Sur l'instance B, les conteneurs redémarrent seuls (`restart: unless-stopped`) une fois la base joignable ; sinon, `$DC up -d backend gateway`.

## Ajouter ou mettre à jour le frontend sur des instances existantes

Le script de démarrage ne s'exécute qu'une fois. Une mise à jour de la pile qui modifie `UserData` arrête puis redémarre les instances (interruption de quelques minutes, les conteneurs reviennent seuls) sans relancer ce script. Pour démarrer ou mettre à jour le frontend sur A puis B, en session Systems Manager, en une seule ligne (remplacer les trois références) :

```sh
sudo sh -c 'docker pull <FRONTEND_IMAGE> && docker rm -f frontend 2>/dev/null; docker run -d --name frontend --restart unless-stopped --network app_default --memory 256m -p 3001:3001 -e BACKEND_URL=http://backend:3000 -e BACKEND_PUBLIC_ORIGIN=http://<ALB_DNS> <FRONTEND_IMAGE>'
```

Sur AWS, le frontend ne relaie plus les appels API : l'ALB envoie `/backend/*` directement aux backends. `AUTH_BASE_URL` doit donc valoir l'origine que le navigateur utilise, `http://<ALB_DNS>:3001` (Better Auth refuse les requêtes d'une autre origine, vérifié : origine identique 200, origine étrangère 403). Sur une instance existante, le fichier `/opt/app/compose.yaml` se corrige par : `sudo sed -i 's|AUTH_BASE_URL: http://$ALB_DNS$|AUTH_BASE_URL: http://$ALB_DNS:3001|' /opt/app/compose.yaml`, puis recréer le conteneur backend. La connexion rapide du frontend (`POST /dev/sessions` avec `"verified": true`) n'existe qu'en mode local : elle ne prouve pas la possession de l'adresse.

## Contrôles à exécuter, et ce qu'ils prouvent

| Contrôle | Comment | Ce que cela établit |
|---|---|---|
| A et B sains | EC2, Target Groups, les deux groupes, onglet Targets | Les deux instances répondent aux contrôles de santé |
| Application publique | Ouvrir `PublicUrl/health` puis `PublicUrl/app` | L'entrée fonctionne |
| Répartition | Plusieurs requêtes, puis consulter les métriques de requêtes par cible du groupe | Les deux cibles reçoivent du trafic |
| Session sur les deux | Ouvrir une session, rafraîchir plusieurs fois et rester connecté | Les sessions sont partagées par la base |
| Éditeur | Ouvrir un document depuis `/app`, éditer depuis deux navigateurs | WebSocket à travers l'ALB et la passerelle |
| Ports internes fermés | Depuis votre machine, les ports 3000, 9002 et 5432 de l'ALB doivent expirer | Seul l'ALB est exposé |
| API Etherpad fermée | `EditorUrl/api/1/listAllPads` doit répondre 403 | La passerelle bloque l'administration |
| Bucket privé | URL directe d'un objet : `AccessDenied` | Aucun accès public |
| Arrêt d'un backend | Arrêter le conteneur backend de B, vérifier que `PublicUrl/health` répond toujours | Le backend est redondé |

Le journal du 26 octobre rapporte des cibles saines, `/health` à 200, vingt requêtes de santé à 200, trente appels authentifiés à 200, un essai d'édition simultanée, l'accès anonyme au bucket refusé en 403 et des timeouts sur plusieurs ports internes. Ces résultats ne prouvent pas la répartition du trafic entre A et B, une session effectivement observée sur chaque backend, la panne d'une instance, la charge ou le coût. Le listener du frontend n'a pas fait l'objet d'une vérification consignée.

## Limites réelles

- **Etherpad n'est pas redondé.** Il n'y a qu'un moteur actif, sur A. Une panne de A, ou de son backend (le plugin d'accès appelle le backend de A), interrompt l'édition. La couche backend est redondée, pas l'éditeur. Deux Etherpad sur le même pad violeraient la contrainte « aucune modification perdue ».
- **Mode d'identité local.** `APP_ENV=local` est fixé : la route `/dev/sessions` permet de se faire passer pour n'importe quelle adresse, et aucun SMTP n'est configuré. À limiter par `AllowedCidr`. La boîte mail de test (`/dev/mailbox`) est en mémoire **par instance** : avec deux backends, une requête peut arriver sur l'autre et ne pas retrouver le code.
- **HTTP seulement.** Sans nom de domaine, pas de certificat reconnu. Les cookies ne sont pas marqués `Secure`.
- **Plusieurs backends non éprouvés.** Les tests d'intégration ont été exécutés contre un seul backend. La concurrence entre deux backends sur les clôtures est protégée par des verrous en base, sans test dédié.
- **RDS dans une seule zone** : pas de résistance à la perte de cette zone.
- **Connexion à la base non chiffrée.** RDS PostgreSQL refuse par défaut les connexions sans TLS (`no pg_hba.conf entry ... no encryption`, observé au premier déploiement). Ni le backend ni Etherpad n'étant configurés pour TLS, la pile désactive `rds.force_ssl` dans un groupe de paramètres. Le trafic reste dans le VPC et n'est ouvert qu'au groupe de sécurité des instances, mais il n'est pas chiffré. Une amélioration serait de configurer TLS dans le backend (`sslmode`) et dans Etherpad.
- **Fonctions absentes du code** : liens de téléchargement limités, PDF, crédit d'écriture, blocage, notification. Le bucket S3 et le rôle prévoient seulement le préfixe `exports/`.
- Les instances sont créées une fois : une nouvelle version des images demande de remplacer les instances (mise à jour de la pile avec de nouvelles références) ou de relancer les conteneurs en session Systems Manager. Il n'y a pas encore de pipeline de redéploiement ni de retour arrière automatique.

## Coût

Postes facturables créés : deux instances EC2 et leurs volumes, un ALB, une instance RDS et son stockage, trois adresses IPv4 publiques environ (deux instances et l'ALB), cinq secrets, trafic sortant vers Internet. Le cours indique, pour un compte créé depuis le 15/07/2025, jusqu'à 200 dollars de crédits et un plan gratuit de 6 mois : cela ne veut pas dire que ces ressources sont gratuites. Estimer avec https://calculator.aws avec vos types d'instance, puis relever le coût observé dans Cost Explorer après quelques heures et le joindre au rapport. Aucun prix n'est donné ici faute de source vérifiée.

## Supprimer l'ensemble

1. Vider le bucket S3 (console S3, **Empty**). CloudFormation ne supprime pas un bucket non vide.
2. Console CloudFormation, sélectionner la pile, **Delete**. La base est supprimée sans instantané (`DeletionPolicy: Delete`).
3. Vérifier ensuite : plus d'instance EC2, d'ALB, de RDS ni de groupe cible ; pas de volume orphelin ; secrets (ils peuvent rester planifiés pour suppression pendant un délai de récupération, à vérifier dans Secrets Manager).
4. Contrôler le coût du lendemain dans Cost Explorer.

## Vérifié localement

- `cfn-lint` 1.58.0 ne signale aucune erreur sur le modèle, y compris avec `--regions eu-north-1`. Ce contrôle est statique : il ne prouve pas que CloudFormation, RDS ou EC2 acceptent réellement les valeurs.
- Le script de démarrage a une syntaxe shell correcte, le script Python qui récupère les secrets compile.
- Le fichier Compose généré est valide pour le rôle A, et ne contient que le backend et la passerelle pour le rôle B.
- Le gabarit Nginx de la passerelle donne 200 sur `/health` (relayé vers Etherpad), 403 sur `/api/` et sur `/admin`.

Les premiers points ci-dessus étaient non vérifiés avant le déploiement. L'exécution a ensuite confirmé la création de la pile, le démarrage de PostgreSQL et des conteneurs, et le contrôle de santé. Il reste à vérifier la suppression puis la recréation, le test d'arrêt d'une instance, la restauration de sauvegarde, la configuration du frontend sur les deux instances, la charge et le coût réel.
