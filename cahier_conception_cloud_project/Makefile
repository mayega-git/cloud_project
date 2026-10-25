LATEXMK ?= latexmk
LATEXMK_MODE ?= -pdf
PLANTUML_JAR ?=

.PHONY: all pdf diagrams clean
all: pdf

pdf:
	$(LATEXMK) $(LATEXMK_MODE) -interaction=nonstopmode -halt-on-error main.tex

diagrams:
	@test -n "$(PLANTUML_JAR)" || (echo 'Indiquer PLANTUML_JAR=/chemin/plantuml.jar' >&2; exit 1)
	java -Djava.awt.headless=true -jar "$(PLANTUML_JAR)" -failfast2 -tpng -o ../figures diagrammes/google-protocole.puml diagrammes/overleaf-composants.puml diagrammes/cas-edition.puml diagrammes/cas-diffusion.puml diagrammes/cas-utilisation-global.puml diagrammes/contexte-systeme.puml diagrammes/packages-systeme.puml diagrammes/sequence-diffusion.puml diagrammes/cycle-version-metier.puml diagrammes/credit-classes.puml diagrammes/credit-activites.puml diagrammes/credit-sequence.puml diagrammes/version-classes.puml diagrammes/version-activites.puml diagrammes/version-sequence.puml diagrammes/partage-classes.puml diagrammes/partage-activites.puml diagrammes/partage-sequence.puml

clean:
	$(LATEXMK) -c main.tex
	rm -rf build
