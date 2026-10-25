# Intégration Etherpad 3.3.6

`ep_business` est installé dans l'image construite par `deployment/Dockerfile.etherpad`. Le script `patch-etherpad.py` modifie de façon reproductible la source du tag 3.3.6 dans l'image. Il place le hook `businessBeforeUserChanges` et la fonction `enqueueBusinessBarrier` dans la file ordonnée des modifications du pad. Une mise à niveau d'Etherpad exige une revue du patch et des tests réels.

Le plugin consulte le backend pour autoriser la lecture à la connexion et l'écriture de chaque message. Le backend vérifie les droits de branche, la version active, l'état `OPEN`/`CLOSING`/`FROZEN` et l'échéance. Le client reçoit l'annonce de fermeture et conserve un texte local récupérable. Ce texte peut inclure des passages déjà enregistrés.

Le quota et son couplage durable aux révisions Etherpad restent non implémentés. `ep_cursortrace` n'est pas installé ; sa compatibilité avec cette version et l'affichage des curseurs restent à vérifier. Les commandes de construction et de test figurent dans `application/README.md`.
