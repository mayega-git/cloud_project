# Cahier de conception — Éditeur de documents partagé

Le dossier rassemble l'état de l'art, l'analyse des exigences, la conception du crédit, le cadrage de l'historique et les résultats rapportés de l'intégration locale. Il s'appuie sur le sujet, le cours d'ingénierie des exigences et les décisions complémentaires du porteur.

Le cahier est rédigé en français, en LaTeX, avec une présentation en noir et blanc. Les diagrammes UML sont maintenus en PlantUML. Etherpad est retenu pour le MVP local ; les garanties prioritaires et la cible AWS restent à qualifier.

## Contenu

- `main.tex` : entrée du document.
- `chapitres/01-etat-art.tex` : approches OT/CRDT, existants et comparaison sourcée.
- `chapitres/02-analyse.tex` : parties prenantes, exigences, scénarios, traçabilité et diagrammes fonctionnels sans nom de technologie.
- `chapitres/03-conception.tex` : crédit quotidien, branches, versions métier, permissions et clôture.
- `chapitres/04-implementation-resultats.tex` : choix de la stack, état réel du MVP, correspondance technique et preuves restantes.
- `chapitres/05-references.tex` : références des pièces fournies et sources officielles.
- `diagrammes/*.puml` : sources UML et style monochrome commun.
- `figures/*.png` : rendus PlantUML, dont les figures incluses dans le rapport, pour compiler sans installer PlantUML.
- `main.pdf` : unique PDF du cahier, généré depuis `main.tex`.

## Compiler

Prérequis : TeX Live ou équivalent, **pdfLaTeX**, `latexmk`, polices Latin Modern et modules LaTeX utilisés dans `main.tex` (notamment `iftex`, `babel-french`, `lmodern`, `geometry`, `microtype`, `graphicx`, `booktabs`, `longtable`, `tabularx`, `enumitem`, `amsmath`, `needspace`, `float`, `fancyhdr`, `hyperref`, `xurl`, `ragged2e`). XeLaTeX reste possible avec `fontspec` et `polyglossia` installés. Aucun accès réseau, shell escape ou téléchargement n'est nécessaire pour la compilation du cahier.

```sh
make pdf
```

Le PDF est produit directement dans `main.pdf`, sans copie sous un autre nom. Pour compiler avec XeLaTeX si disponible : `make pdf LATEXMK_MODE=-xelatex`. Sans Make :

```sh
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

Une nouvelle compilation remplace `main.pdf` ; conserver séparément toute annotation ajoutée au PDF.

Dans Overleaf, importer le contenu du dossier et sélectionner `main.tex` ; pdfLaTeX et XeLaTeX sont tous deux pris en charge. Les figures sont déjà fournies.

## Régénérer les diagrammes

Les images de cette version ont été générées avec PlantUML **1.2026.8** et Java 21. Pour reproduire exactement ce rendu, utiliser cette version de PlantUML : <https://github.com/plantuml/plantuml/releases/tag/v1.2026.8>.

```sh
make diagrams PLANTUML_JAR=/chemin/plantuml-1.2026.8.jar
make pdf
```

Le moteur Smetana est activé pour les diagrammes concernés. Ne pas modifier uniquement une image : modifier le `.puml`, régénérer, puis recompiler.

## Méthode et statut des décisions

Les besoins sont sourcés au sujet. Le cours distingue exigences utilisateur, exigences système fonctionnelles et non fonctionnelles, puis catégories produit, organisationnelles et externes. Les identifiants restent stables au fil des révisions.

Les deux contraintes prioritaires sont l'exactitude du tirage et l'absence de perte avec convergence. Les autres obligations restent impératives. Les seuils temporels proposés sont explicitement **non validés**, sauf la marge de trois secondes décidée pour l'admission lors d'une clôture. Les questions encore ouvertes doivent être résolues avant de figer le contrat d'API et les tests. Le chapitre 3 distingue les obligations du sujet, les décisions complémentaires et les propositions techniques ; le chapitre 4 distingue le code existant des intégrations prévues.

La documentation Google de 2010 est présentée comme historique. La documentation Overleaf sur site est distinguée du service commercial. Le manifeste Overleaf consulté identifie des technologies du code publié, sans démontrer toute la pile SaaS. Les références web sont datées du 24 octobre 2026.

Les PDF sources de l'énoncé et du cours ne sont pas redistribués dans ce dépôt ; leurs noms et pages/diapositives figurent dans les références. Le cahier contient la spécification extraite nécessaire à la lecture.

## Prochaines évolutions

1. Éprouver sur Etherpad 3.3.6 l'admission ordonnée des écritures, le gel, la reconnexion et la cohérence du crédit.
2. Résoudre les questions encore ouvertes du registre Q-01 à Q-15 et fixer les objectifs mesurables.
3. Construire le parcours PDF à nombre d'utilisations exact, puis l'éprouver sous concurrence et charge.
4. Décrire et vérifier le déploiement AWS sans exposer de clés.

Pour supprimer uniquement les fichiers temporaires de compilation : `make clean`.
