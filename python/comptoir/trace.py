"""Suivre chaque étape d'un traitement : modèle, durée, coût, résultat (chapitre 12).

Une trace par message du client. Chaque étape (routage, extraction, réponse…) y note ce
qu'elle a fait, et une ligne entre dans le journal, avec l'identifiant de la trace : on
retrouve, après coup, pourquoi un message a pris tel chemin et ce qu'il a coûté.

Comme le journal, la trace ne contient jamais le texte du client : seulement des catégories,
des codes et des nombres.
"""

import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field

from comptoir.journal import noter_evenement


@dataclass
class Etape:
    nom: str
    modele: str            # « code » quand aucun modèle n'est appelé
    duree_ms: int = 0
    cout_dollars: float = 0.0
    resultat: str = ""     # une catégorie, un code, un nombre : jamais le texte du client
    erreur: str | None = None


@dataclass
class Enregistreur:
    """Ce que l'étape en cours remplit : son coût et son résultat."""
    etape: Etape

    def noter(self, cout: float = 0.0, resultat: str = "") -> None:
        self.etape.cout_dollars += cout
        if resultat:
            self.etape.resultat = resultat


@dataclass
class Trace:
    identifiant: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    etapes: list[Etape] = field(default_factory=list)

    @contextmanager
    def etape(self, nom: str, modele: str = "code"):
        etape = Etape(nom, modele)
        debut = time.perf_counter()
        try:
            yield Enregistreur(etape)
        except Exception as erreur:
            etape.erreur = type(erreur).__name__
            raise
        finally:
            etape.duree_ms = round((time.perf_counter() - debut) * 1000)
            self._garder(etape)

    def ajouter(self, nom: str, modele: str, duree_ms: int, cout_dollars: float, resultat: str = "") -> None:
        """Une étape déjà mesurée ailleurs, par exemple un appel fait par le Tool Runner (chapitre 13)."""
        self._garder(Etape(nom, modele, duree_ms, cout_dollars, resultat))

    def _garder(self, etape: Etape) -> None:
        self.etapes.append(etape)
        noter_evenement("etape", trace=self.identifiant, etape=etape.nom, modele=etape.modele,
                        duree_ms=etape.duree_ms, cout_dollars=round(etape.cout_dollars, 6),
                        resultat=etape.resultat or None, erreur=etape.erreur)

    @property
    def cout(self) -> float:
        return sum(e.cout_dollars for e in self.etapes)

    @property
    def duree_ms(self) -> int:
        return sum(e.duree_ms for e in self.etapes)

    def afficher(self) -> str:
        lignes = [f"trace {self.identifiant} : {len(self.etapes)} étapes, {self.duree_ms / 1000:.1f} s, {self.cout:.4f} $"]
        for e in self.etapes:
            lignes.append(f"  {e.nom:13} {e.modele:18} {e.duree_ms / 1000:>5.1f} s  {e.cout_dollars:.5f} $  "
                          f"{e.resultat}{'  ERREUR ' + e.erreur if e.erreur else ''}")
        return "\n".join(lignes)
