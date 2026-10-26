"""Convertir la consommation d'un appel (le champ usage) en dollars, en FCFA et en euros.

Prix relevés sur platform.claude.com le 19 octobre 2026, revérifiés le 22 octobre 2026 (annexe D),
en dollars par million de tokens.
Vérifiez-les avant de vous en servir : ils changent (annexe D, page d'accompagnement).
"""

from dataclasses import dataclass

from comptoir import config


@dataclass(frozen=True)
class Tarif:
    entree: float          # tokens d'entrée hors cache
    ecriture_5m: float     # écriture dans le cache de 5 minutes
    ecriture_1h: float     # écriture dans le cache d'une heure
    lecture_cache: float   # lecture depuis le cache
    sortie: float          # tokens de sortie, réflexion comprise


TARIFS = {
    "claude-fable-5-1": Tarif(10.00, 12.50, 20.00, 0.25, 50.00),
    "claude-opus-5-5": Tarif(4.00, 5.00, 8.00, 0.20, 20.00),
    "claude-sonnet-5-5": Tarif(2.00, 2.50, 4.00, 0.10, 10.00),
    "claude-haiku-5-5": Tarif(0.10, 0.125, 0.20, 0.01, 0.50),
}

# Claude Haiku 5.5 coûte plus cher quand le prompt dépasse 100 000 tokens.
SEUIL_LONG_PROMPT = 100_000
TARIFS_LONG_PROMPT = {
    "claude-haiku-5-5": Tarif(0.50, 0.625, 1.00, 0.05, 2.50),
}

# Batch API (traitement par lot) : 50 % de remise sur l'entrée et la sortie, et les
# multiplicateurs du cache se cumulent avec cette remise, donc tous les postes sont
# réduits de moitié. Source : page Pricing d'Anthropic, relue le 20 octobre 2026.
REMISE_LOT = 0.5


def _lire(objet, nom, defaut=0):
    """Lit un champ, que l'usage vienne du SDK (objet) ou d'un JSON (dictionnaire)."""
    if objet is None:
        return defaut
    valeur = objet.get(nom) if isinstance(objet, dict) else getattr(objet, nom, None)
    return defaut if valeur is None else valeur


@dataclass(frozen=True)
class Cout:
    dollars: float
    entree: int
    ecriture_cache: int
    lecture_cache: int
    sortie: int
    reflexion: int
    recherches: int = 0  # recherches web, facturées à part (chapitre 10)

    @property
    def fcfa(self) -> float:
        return self.dollars * config.TAUX_FCFA

    @property
    def euros(self) -> float:
        return self.dollars * config.TAUX_EUR

    def __str__(self) -> str:
        return (
            f"{_francais(self.dollars, 4)} $ "
            f"(≈ {_francais(self.fcfa, 1)} FCFA ; {_francais(self.euros, 4)} €)"
        )


def _francais(nombre: float, decimales: int) -> str:
    """0.0071 -> « 0,0071 » : virgule décimale, comme dans le livre."""
    return f"{nombre:.{decimales}f}".replace(".", ",")


# Recherche web : 10 $ les 1 000 recherches, en plus des tokens (Pricing, 20 octobre 2026).
# Même prix par la Batch API. La lecture de pages ne coûte que ses tokens ; l'exécution de
# code a 1 550 heures gratuites par mois et par organisation (chapitre 10).
PRIX_RECHERCHE_WEB = 10.0 / 1000


def cout_maximal(modele: str, tokens_entree: int, max_tokens: int, ecriture_cache: str | None = None) -> float:
    """Le coût le plus élevé possible d'un appel, en dollars, avant de le lancer (chapitre 8).

    L'entrée est connue (count_tokens, gratuit) ; la sortie ne dépassera pas max_tokens,
    réflexion comprise. ecriture_cache ("5m" ou "1h", chapitre 11) : si la requête pose un
    point de cache, le pire cas est une entrée entièrement écrite dans le cache, qui coûte
    1,25 ou 2 fois le prix d'entrée.
    """
    if modele not in TARIFS:
        raise ValueError(f"Prix inconnu pour le modèle {modele!r} : ajoutez-le dans TARIFS.")
    tarif = TARIFS[modele]
    if tokens_entree > SEUIL_LONG_PROMPT and modele in TARIFS_LONG_PROMPT:
        tarif = TARIFS_LONG_PROMPT[modele]
    prix_entree = {"5m": tarif.ecriture_5m, "1h": tarif.ecriture_1h}.get(ecriture_cache, tarif.entree)
    return (tokens_entree * prix_entree + max_tokens * tarif.sortie) / 1_000_000


def duree_cache(requete) -> str | None:
    """La durée de cache la plus chère que demande une requête : "1h", "5m", ou None sans point
    de cache. Les points peuvent être n'importe où : en tête, sur un outil, un bloc, un message."""
    durees = set()

    def parcourir(objet):
        if isinstance(objet, dict):
            controle = objet.get("cache_control")
            if isinstance(controle, dict):
                durees.add(controle.get("ttl", "5m"))
            for valeur in objet.values():
                parcourir(valeur)
        elif isinstance(objet, list):
            for valeur in objet:
                parcourir(valeur)

    parcourir(requete)
    return "1h" if "1h" in durees else ("5m" if durees else None)


def cout(modele: str, usage, lot: bool = False) -> Cout:
    """Calcule le coût d'un appel à partir de son champ usage.

    lot=True pour un appel passé par la Batch API. usage.service_tier peut valoir
    « batch », mais la remise reste demandée explicitement par l'appelant.
    """
    if modele not in TARIFS:
        raise ValueError(f"Prix inconnu pour le modèle {modele!r} : ajoutez-le dans TARIFS.")

    entree = _lire(usage, "input_tokens")
    sortie = _lire(usage, "output_tokens")
    lecture = _lire(usage, "cache_read_input_tokens")
    ecriture = _lire(usage, "cache_creation_input_tokens")
    detail_ecriture = _lire(usage, "cache_creation", None)
    ecriture_1h = _lire(detail_ecriture, "ephemeral_1h_input_tokens")
    ecriture_5m = ecriture - ecriture_1h  # sans détail, tout est compté en 5 minutes
    reflexion = _lire(_lire(usage, "output_tokens_details", None), "thinking_tokens")
    recherches = _lire(_lire(usage, "server_tool_use", None), "web_search_requests")

    # La longueur du prompt compte tous les tokens d'entrée, cache compris.
    longueur_prompt = entree + lecture + ecriture
    tarif = TARIFS[modele]
    if longueur_prompt > SEUIL_LONG_PROMPT and modele in TARIFS_LONG_PROMPT:
        tarif = TARIFS_LONG_PROMPT[modele]

    dollars = (
        entree * tarif.entree
        + ecriture_5m * tarif.ecriture_5m
        + ecriture_1h * tarif.ecriture_1h
        + lecture * tarif.lecture_cache
        + sortie * tarif.sortie  # output_tokens inclut déjà la réflexion
    ) / 1_000_000
    if lot:
        dollars *= REMISE_LOT  # après le choix du tarif : le seuil porte sur les tokens bruts
    dollars += recherches * PRIX_RECHERCHE_WEB  # sans remise de lot

    return Cout(dollars, entree, ecriture, lecture, sortie, reflexion, recherches)
