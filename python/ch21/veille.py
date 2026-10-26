"""Chapitre 21 : la veille du Comptoir. Ce qui change chez Anthropic sans que le code du Comptoir bouge.

Depuis le dossier python/ :
    python -m ch21.veille                   (gratuit : l'API Models ne génère rien et ne consomme aucun token)
    python -m ch21.veille --horizon 180     (alerte si un modèle utilisé est retiré dans les 180 jours)

Trois questions, chaque semaine, dans la CI :
1. Les modèles que le Comptoir appelle sont-ils toujours actifs, et jusqu'à quand ? Deux sources, croisées :
   la page Model deprecations (l'état publié, la date de retrait ou « pas avant… ») et l'API Models (ce que la
   clé voit). Le 22 octobre 2026, l'API disait « active » pour un modèle que la page annonçait retiré le
   30 novembre : une seule source n'aurait pas suffi. Anthropic prévient au moins 60 jours avant le retrait
   d'un modèle publié.
2. Le SDK installé est-il à jour ? sdk-versions.json donne la dernière version de chaque SDK. Une version
   majeure de plus veut dire, depuis la 2.0.0 du SDK Python, une nouvelle version de l'API.
3. Quelle version de l'API le Comptoir envoie-t-il (en-tête anthropic-version) ?

Le code de sortie vaut 1 s'il y a une alerte : le job planifié de la CI échoue, et quelqu'un regarde.
"""

import argparse
import importlib.metadata
import json
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import anthropic

from comptoir import config

RACINE = Path(__file__).resolve().parents[1]
PAGE_DES_RETRAITS = "https://platform.claude.com/docs/en/about-claude/model-deprecations.md"
VERSIONS_DES_SDK = "https://platform.claude.com/docs/sdk-versions.json"
AGENT = {"User-Agent": "comptoir-veille/1.0"}  # le site refuse le client par défaut de Python (403)
MODELE = re.compile(r"\bclaude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?\b")
REGLAGES = ("MODELE", "MODELE_ROUTEUR", "MODELE_DOCUMENTS", "MODELE_AUXILIAIRE", "MODELE_COMPTOIR")
LIGNE_DU_TABLEAU = re.compile(r"^\|\s*(claude-[a-z0-9-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$", re.M)


@dataclass
class Etat:
    """Ce que dit la page des retraits pour un modèle."""
    etat: str                       # Active, Legacy, Deprecated, Retired
    deprecie_le: str | None
    retrait: datetime | None        # la date fixée, ou celle avant laquelle il n'y aura pas de retrait
    au_plus_tot: bool               # « Not sooner than » : une date plancher, pas une date fixée


@dataclass
class Rapport:
    alertes: list[str] = field(default_factory=list)
    infos: list[str] = field(default_factory=list)

    def texte(self) -> str:
        return "\n".join([f"ALERTE  {a}" for a in self.alertes] + [f"        {i}" for i in self.infos]) or "Rien à signaler."


def lire_date(texte: str) -> datetime | None:
    try:
        return datetime.strptime(texte.strip(), "%B %d, %Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def etats_publies(page: str) -> dict[str, Etat]:
    """Le tableau « Model status » de la page des retraits, en Markdown."""
    etats = {}
    for identifiant, etat, deprecie, retrait in LIGNE_DU_TABLEAU.findall(page):
        plancher = retrait.lower().startswith("not sooner than")
        date = lire_date(re.sub(r"(?i)^not sooner than\s+", "", retrait))
        etats[identifiant] = Etat(etat, None if deprecie in ("N/A", "") else deprecie, date, plancher)
    return etats


def telecharger(url: str) -> str | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=20) as reponse:
            return reponse.read().decode("utf-8")
    except OSError:
        return None


def modeles_en_production() -> dict[str, str]:
    """Réglage -> modèle, tels que comptoir/config.py les lit (variables d'environnement comprises)."""
    return {nom: getattr(config, nom) for nom in REGLAGES}


def modeles_du_depot(racine: Path = RACINE) -> dict[str, set[str]]:
    """Modèle -> fichiers où il est écrit, hors résultats, tests, environnements virtuels et ce fichier."""
    trouves: dict[str, set[str]] = {}
    for fichier in racine.rglob("*.py"):
        relatif = fichier.relative_to(racine).as_posix()
        if relatif.startswith((".venv", "tests/")) or "/resultats/" in relatif or fichier.resolve() == Path(__file__).resolve():
            continue
        for modele in set(MODELE.findall(fichier.read_text(encoding="utf-8", errors="replace"))):
            trouves.setdefault(modele, set()).add(relatif)
    return trouves


def chercher(modeles: dict, identifiant: str):
    """Le modèle exact, ou la version datée dont l'identifiant est un alias (…-4-5 -> …-4-5-20251001)."""
    if identifiant in modeles:
        return modeles[identifiant]
    datees = [m for i, m in modeles.items() if i.startswith(identifiant + "-")]
    return datees[0] if len(datees) == 1 else None


def examiner_modeles(catalogue: dict, publies: dict[str, Etat] | None, utilises: dict[str, str], horizon_j: int,
                     maintenant: datetime) -> Rapport:
    """catalogue : identifiant -> modèle de l'API Models ; publies : la page des retraits (None si injoignable)."""
    rapport = Rapport()
    if publies is None:
        rapport.alertes.append("Page des retraits injoignable : seule l'API Models a été lue")
    for identifiant in sorted(set(utilises.values())):
        ou = ", ".join(sorted(k for k, v in utilises.items() if v == identifiant))
        api, page = chercher(catalogue, identifiant), chercher(publies or {}, identifiant)
        if api is None:
            rapport.alertes.append(f"{identifiant} ({ou}) : absent de l'API Models — retiré, ou pas accessible avec cette clé")
        if page is not None and page.etat != "Active":
            quand = f", retrait le {page.retrait.date().isoformat()}" if page.retrait and not page.au_plus_tot else ""
            rapport.alertes.append(f"{identifiant} ({ou}) : « {page.etat} » selon la page des retraits{quand}")
            if api is not None and api.lifecycle == "active":
                rapport.alertes.append(f"{identifiant} : l'API Models dit encore « active » ; la page fait foi")
            continue
        if api is not None and api.lifecycle != "active":
            rapport.alertes.append(f"{identifiant} ({ou}) : « {api.lifecycle} » selon l'API Models")
            continue
        retrait = getattr(api, "retires_at", None) or (page.retrait if page and not page.au_plus_tot else None)
        if retrait and retrait - maintenant <= timedelta(days=horizon_j):
            rapport.alertes.append(f"{identifiant} ({ou}) : retrait le {retrait.date().isoformat()}, dans {(retrait - maintenant).days} jours")
        elif api is not None:
            plancher = f", pas avant le {page.retrait.date().isoformat()}" if page and page.au_plus_tot and page.retrait else ""
            rapport.infos.append(f"{identifiant} ({ou}) : actif{plancher}")
    return rapport


def majeure(version: str) -> int:
    return int(version.split(".")[0])


def examiner_sdk(installee: str, derniere: str | None, version_api: str) -> Rapport:
    rapport = Rapport()
    if derniere is None:
        rapport.alertes.append("Dernière version du SDK inconnue : sdk-versions.json injoignable")
    elif majeure(derniere) > majeure(installee):
        rapport.alertes.append(f"SDK anthropic {installee} installé, {derniere} disponible : une version majeure de plus, "
                               "donc une nouvelle version de l'API. Lire le guide de migration avant de changer.")
    elif derniere != installee:
        rapport.infos.append(f"SDK anthropic {installee} installé, {derniere} disponible (même version majeure)")
    else:
        rapport.infos.append(f"SDK anthropic {installee} : à jour")
    rapport.infos.append(f"Version de l'API envoyée : {version_api}")
    return rapport


def version_api_envoyee() -> str:
    """L'en-tête anthropic-version que le SDK installé envoie par défaut (aucune requête n'est faite)."""
    return anthropic.Anthropic(api_key="aucune").default_headers.get("anthropic-version", "?")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--horizon", type=int, default=120, help="jours avant un retrait pour lever une alerte")
    args = parser.parse_args()
    maintenant = datetime.now(timezone.utc)

    from comptoir.appel import creer_client
    page = telecharger(PAGE_DES_RETRAITS)
    publies = etats_publies(page) if page else None
    production = modeles_en_production()
    catalogue = {m.id: m for m in creer_client().models.list()}
    rapport = examiner_modeles(catalogue, publies, production, args.horizon, maintenant)
    versions = telecharger(VERSIONS_DES_SDK)
    sdk = examiner_sdk(importlib.metadata.version("anthropic"), json.loads(versions).get("python") if versions else None,
                       version_api_envoyee())
    print(f"Veille du {maintenant:%d/%m/%Y}\n\nModèles du Comptoir en production :\n{rapport.texte()}\n")
    print("SDK et API :\n" + sdk.texte() + "\n")
    autres = {m: f for m, f in modeles_du_depot().items() if m not in production.values()}
    if autres:
        print("Autres modèles écrits dans le dépôt (scripts des chapitres, comparaisons) :")
        for modele, fichiers in sorted(autres.items()):
            etat = chercher(publies or {}, modele)
            print(f"        {modele} ({etat.etat if etat else 'état inconnu'}) : {', '.join(sorted(fichiers))}")
    return 1 if rapport.alertes or sdk.alertes else 0


if __name__ == "__main__":
    raise SystemExit(main())
