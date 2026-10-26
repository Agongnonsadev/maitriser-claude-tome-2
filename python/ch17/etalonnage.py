"""Étalonner le juge : comparer ses verdicts à ceux d'un humain, sur les mêmes réponses (chapitre 17).

Trois chiffres par critère :
- l'accord brut : la part des réponses où le juge et l'humain disent la même chose ;
- le kappa de Cohen : le même accord, une fois retiré celui que le hasard donnerait. Quand
  presque toutes les réponses sont bonnes, un juge qui dit toujours « oui » a un excellent
  accord brut et un kappa nul : il ne voit rien ;
- les faux « oui » : le juge laisse passer une réponse que l'humain refuse. C'est l'erreur qui
  coûte, puisqu'un juge sert à attraper les mauvaises réponses.

L'humain peut se tromper aussi : chaque désaccord se relit, et se tranche, avant de corriger
la grille.
"""

from collections import Counter
from dataclasses import dataclass, field

from ch17.juge import CRITERES


@dataclass
class Accord:
    critere: str
    n: int = 0
    accords: int = 0
    kappa: float | None = None
    faux_oui: list[str] = field(default_factory=list)    # juge oui, humain non
    faux_non: list[str] = field(default_factory=list)    # juge non, humain oui
    autres: list[str] = field(default_factory=list)      # un « inconnu » d'un côté seulement

    @property
    def accord_brut(self) -> float:
        return self.accords / self.n if self.n else 0.0


def kappa(paires: list[tuple[str, str]]) -> float | None:
    """Kappa de Cohen pour deux notateurs. None si le hasard suffit à tout expliquer (une seule valeur)."""
    n = len(paires)
    if not n:
        return None
    observe = sum(a == b for a, b in paires) / n
    gauche, droite = Counter(a for a, _ in paires), Counter(b for _, b in paires)
    attendu = sum(gauche[v] * droite[v] for v in set(gauche) | set(droite)) / (n * n)
    if attendu == 1:
        return None
    return (observe - attendu) / (1 - attendu)


def comparer(humain: dict[str, dict[str, str]], juge: dict[str, dict[str, str]]) -> list[Accord]:
    """humain et juge : {identifiant de l'essai : {critère : verdict}}. Seuls les essais notés des deux côtés comptent."""
    communs = sorted(set(humain) & set(juge))
    resultats = []
    for critere in CRITERES:
        accord, paires = Accord(critere), []
        for essai in communs:
            h, j = humain[essai].get(critere), juge[essai].get(critere)
            if h is None or j is None:
                continue
            paires.append((h, j))
            accord.n += 1
            if h == j:
                accord.accords += 1
            elif j == "oui" and h == "non":
                accord.faux_oui.append(essai)
            elif j == "non" and h == "oui":
                accord.faux_non.append(essai)
            else:
                accord.autres.append(essai)
        accord.kappa = kappa(paires)
        resultats.append(accord)
    return resultats


def issue(verdicts: dict[str, str]) -> str:
    if "non" in verdicts.values():
        return "echoue"
    return "reussi" if verdicts and all(v == "oui" for v in verdicts.values()) else "a_relire"


def accord_global(humain: dict[str, dict[str, str]], juge: dict[str, dict[str, str]]) -> tuple[int, int, list[str]]:
    """Sur l'issue de chaque réponse (réussie, échouée, à relire) : accords, total, désaccords."""
    communs = sorted(set(humain) & set(juge))
    desaccords = [e for e in communs if issue(humain[e]) != issue(juge[e])]
    return len(communs) - len(desaccords), len(communs), desaccords


def afficher(resultats: list[Accord]) -> str:
    lignes = [f"{'critère':14} {'notés':>5} {'accord':>7} {'kappa':>6} {'faux oui':>9} {'faux non':>9}"]
    for a in resultats:
        k = f"{a.kappa:.2f}" if a.kappa is not None else "—"
        lignes.append(f"{a.critere:14} {a.n:>5} {a.accord_brut:>7.0%} {k:>6} {len(a.faux_oui):>9} {len(a.faux_non):>9}")
    return "\n".join(lignes)
