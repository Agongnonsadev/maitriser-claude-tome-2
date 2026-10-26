"""Comptoir pour Awa : le serveur MCP de Délices d'Awa (chapitre 15).

Awa le branche dans son application Claude, comme extension de bureau ; Yao, dans Claude Code.
Ce que Claude peut faire avec :
- lire : les commandes d'un jour, le stock, les ventes d'une semaine, une commande, le catalogue ;
- préparer : un bilan du soir, un inventaire (deux prompts qu'Awa choisit) ;
- écrire, une seule chose : corriger le stock après un inventaire, en deux temps. preparer_correction
  montre l'écart et rend un jeton ; appliquer_correction n'accepte que ce jeton, une seule fois, dans
  les dix minutes, et seulement si le stock n'a pas bougé entre-temps. Entre les deux, Awa dit oui.

Le module ne dépend que de la bibliothèque standard et du SDK MCP : il s'empaquette seul (ch15/
construire_extension.py). Configuration, par l'environnement :
  COMPTOIR_BOUTIQUE    chemin de la base SQLite de la boutique (obligatoire)
  COMPTOIR_CATALOGUE   chemin du catalogue JSON (par défaut : catalogue.json à côté de ce fichier,
                       sinon comptoir/donnees/delices_awa.json du dépôt)
  COMPTOIR_AUJOURDHUI  date du jour, AAAA-MM-JJ, pour les démonstrations (facultatif)

Lancement : python comptoir_pour_awa.py  (stdio). Rien n'est écrit sur la sortie standard, qui
appartient au protocole : le journal va sur la sortie d'erreur.
"""

import json
import logging
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

VERSION = "0.1.0"
COTONOU = timezone(timedelta(hours=1))  # le Bénin est à UTC+1, sans heure d'été
DUREE_JETON = timedelta(minutes=10)
ECART_MAXIMUM = 200  # au-delà, ce n'est plus une correction d'inventaire : Awa le fait elle-même
SEUILS_BAS = {"bouteille": 10, "flacon": 5}
JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
        "novembre", "décembre"]

journal = logging.getLogger("comptoir_pour_awa")

INSTRUCTIONS = """Comptoir pour Awa donne accès aux ventes et au stock de Délices d'Awa, l'entreprise de jus d'Awa à Cotonou. Règles :
1. Les chiffres (bouteilles, montants, écarts) viennent des outils : ne les recalcule pas et ne les arrondis pas.
2. Pour corriger le stock : appelle preparer_correction, montre à Awa l'écart tel que l'outil le donne, et attends son accord explicite avant appliquer_correction. Une correction par produit, jamais plusieurs à la suite sans accord pour chacune.
3. Ne propose jamais de modifier autre chose que le stock : les commandes et les clients ne se changent pas ici.
4. Réponds à Awa en français, en la vouvoyant, simplement : elle n'est pas informaticienne."""


# ---------- Configuration et base ------------------------------------------------------


def _chemin_base() -> Path:
    brut = os.environ.get("COMPTOIR_BOUTIQUE", "").strip()
    if not brut or "${" in brut:
        raise ToolError("Aucune base de la boutique n'est réglée. Dans les réglages de l'extension Comptoir pour "
                        "Awa, choisissez le fichier « Base de la boutique ».")
    chemin = Path(brut)
    if not chemin.is_file():
        raise ToolError(f"La base de la boutique est introuvable : {chemin}. Vérifiez le réglage « Base de la "
                        "boutique » de l'extension, ou demandez le bon fichier à Yao.")
    return chemin


def _ouvrir() -> sqlite3.Connection:
    db = sqlite3.connect(_chemin_base(), timeout=10)
    db.row_factory = sqlite3.Row
    return db


def _catalogue() -> dict:
    candidats = [os.environ.get("COMPTOIR_CATALOGUE", "").strip(), Path(__file__).with_name("catalogue.json"),
                 Path(__file__).parents[1] / "comptoir" / "donnees" / "delices_awa.json"]
    for c in candidats:
        if c and Path(c).is_file():
            return json.loads(Path(c).read_text(encoding="utf-8"))
    raise ToolError("Le catalogue de Délices d'Awa est introuvable : réinstallez l'extension.")


def _aujourdhui() -> date:
    forcee = os.environ.get("COMPTOIR_AUJOURDHUI", "").strip()
    return date.fromisoformat(forcee) if forcee and "${" not in forcee else datetime.now(COTONOU).date()


def _maintenant() -> datetime:
    return datetime.now(timezone.utc)


def _local(horodatage: str) -> datetime:
    """Les dates de la base, en heure de Cotonou, quel que soit le fuseau où elles ont été écrites."""
    return datetime.fromisoformat(horodatage).astimezone(COTONOU)


# ---------- Mise en forme pour Awa ------------------------------------------------------


def fcfa(montant: int) -> str:
    """12500 -> « 12 500 FCFA » (espace insécable fine, comme en français)."""
    return f"{montant:,}".replace(",", " ") + " FCFA"


def jour_en_toutes_lettres(d: date) -> str:
    return f"{JOURS[d.weekday()]} {d.day}{'er' if d.day == 1 else ''} {MOIS[d.month - 1]} {d.year}"


def client_discret(nom: str) -> str:
    """« Larissa Noudéhou » -> « Larissa N. » : assez pour livrer, sans le nom complet."""
    morceaux = nom.split()
    return morceaux[0] if len(morceaux) == 1 else f"{morceaux[0]} {morceaux[-1][0]}."


# ---------- Lectures ----------------------------------------------------------------------


@dataclass
class _Commande:
    numero: str
    quand: datetime
    client: str
    quartier: str
    lignes: list[dict]
    frais: int
    total: int


def _commandes(db: sqlite3.Connection) -> list[_Commande]:
    lignes = db.execute(
        "SELECT c.id, c.cree_le, c.total, r.nom_client, r.quartier, r.lignes, r.frais_livraison "
        "FROM commandes c JOIN recapitulatifs r ON r.id = c.recapitulatif ORDER BY c.cree_le").fetchall()
    return [_Commande(l["id"], _local(l["cree_le"]), client_discret(l["nom_client"]), l["quartier"],
                      json.loads(l["lignes"]), l["frais_livraison"], l["total"]) for l in lignes]


class CommandeDuJour(BaseModel):
    numero: str
    heure: str
    client: str = Field(description="Prénom et initiale du nom.")
    quartier: str
    produits: str
    total_fcfa: int


class CommandesDuJour(BaseModel):
    jour: str
    nombre: int
    total_fcfa: int
    commandes: list[CommandeDuJour]
    resume: str = Field(description="Une phrase à dire à Awa, avec les chiffres exacts.")


class LigneStock(BaseModel):
    produit: str
    format: str
    quantite: int
    etat: Literal["rupture", "bas", "suffisant"]


class Stock(BaseModel):
    produits: list[LigneStock]
    resume: str


class VenteProduit(BaseModel):
    produit: str
    quantite: int
    montant_fcfa: int


class VentesSemaine(BaseModel):
    du: str
    au: str
    commandes: int
    total_fcfa: int
    par_produit: list[VenteProduit]
    semaine_precedente_fcfa: int
    resume: str


class Correction(BaseModel):
    produit: str
    stock_actuel: int
    quantite_comptee: int
    ecart: int
    jeton: str
    valable_jusqu_a: str
    a_dire_a_awa: str


class CorrectionAppliquee(BaseModel):
    produit: str
    avant: int
    apres: int
    resume: str


def _produits(catalogue: dict) -> dict[str, dict]:
    return {p["nom"]: p for p in catalogue["produits"]}


def _unite(produit: dict) -> str:
    return "bouteille" if "bouteille" in produit["format"] else "flacon"


def lire_commandes_du_jour(db: sqlite3.Connection, jour: date) -> CommandesDuJour:
    du_jour = [c for c in _commandes(db) if c.quand.date() == jour]
    commandes = [CommandeDuJour(
        numero=c.numero, heure=c.quand.strftime("%H h %M"), client=c.client, quartier=c.quartier,
        produits=", ".join(f"{l['quantite']} × {l['produit']}" for l in c.lignes), total_fcfa=c.total)
        for c in du_jour]
    total = sum(c.total for c in du_jour)
    quand = jour_en_toutes_lettres(jour)
    resume = (f"Aucune commande le {quand}." if not du_jour else
              f"{len(du_jour)} commande{'s' if len(du_jour) > 1 else ''} le {quand}, pour {fcfa(total)}.")
    return CommandesDuJour(jour=jour.isoformat(), nombre=len(du_jour), total_fcfa=total, commandes=commandes,
                           resume=resume)


def lire_stock(db: sqlite3.Connection, catalogue: dict) -> Stock:
    quantites = dict(db.execute("SELECT produit, quantite FROM stock").fetchall())
    lignes = []
    for nom, produit in _produits(catalogue).items():
        quantite = quantites.get(nom, 0)
        etat = "rupture" if quantite == 0 else "bas" if quantite < SEUILS_BAS[_unite(produit)] else "suffisant"
        lignes.append(LigneStock(produit=nom, format=produit["format"], quantite=quantite, etat=etat))
    ruptures = [l.produit for l in lignes if l.etat == "rupture"]
    bas = [f"{l.produit} ({l.quantite})" for l in lignes if l.etat == "bas"]
    morceaux = []
    if ruptures:
        morceaux.append("En rupture : " + ", ".join(ruptures) + ".")
    if bas:
        morceaux.append("Stock bas : " + ", ".join(bas) + ".")
    return Stock(produits=lignes, resume=" ".join(morceaux) or "Tous les produits sont en stock.")


def lire_ventes_semaine(db: sqlite3.Connection, catalogue: dict, un_jour: date) -> VentesSemaine:
    lundi = un_jour - timedelta(days=un_jour.weekday())
    dimanche = lundi + timedelta(days=6)
    commandes = _commandes(db)
    semaine = [c for c in commandes if lundi <= c.quand.date() <= dimanche]
    precedente = [c for c in commandes if lundi - timedelta(days=7) <= c.quand.date() < lundi]
    quantites: dict[str, int] = {}
    montants: dict[str, int] = {}
    for c in semaine:
        for l in c.lignes:
            quantites[l["produit"]] = quantites.get(l["produit"], 0) + l["quantite"]
            montants[l["produit"]] = montants.get(l["produit"], 0) + l["quantite"] * l["prix_unitaire"]
    par_produit = [VenteProduit(produit=p, quantite=quantites[p], montant_fcfa=montants[p])
                   for p in sorted(quantites, key=lambda p: -quantites[p])]
    total = sum(c.total for c in semaine)
    avant = sum(c.total for c in precedente)
    evolution = ""
    if avant:
        variation = round(100 * (total - avant) / avant)
        evolution = f" ({'+' if variation >= 0 else ''}{variation} % par rapport à la semaine précédente)"
    meilleur = f" Le plus vendu : {par_produit[0].produit}, {par_produit[0].quantite}." if par_produit else ""
    resume = (f"Du {jour_en_toutes_lettres(lundi)} au {jour_en_toutes_lettres(dimanche)} : {len(semaine)} "
              f"commandes, {fcfa(total)}{evolution}.{meilleur}")
    return VentesSemaine(du=lundi.isoformat(), au=dimanche.isoformat(), commandes=len(semaine), total_fcfa=total,
                         par_produit=par_produit, semaine_precedente_fcfa=avant, resume=resume)


# ---------- La seule écriture : corriger le stock ----------------------------------------

_TABLE_CORRECTIONS = """CREATE TABLE IF NOT EXISTS corrections_stock (
    jeton TEXT PRIMARY KEY, produit TEXT NOT NULL, avant INTEGER NOT NULL, apres INTEGER NOT NULL,
    preparee_le TEXT NOT NULL, statut TEXT NOT NULL, appliquee_le TEXT)"""


def preparer(db: sqlite3.Connection, catalogue: dict, produit: str, quantite_comptee: int,
             maintenant: datetime) -> Correction:
    if produit not in _produits(catalogue):
        raise ToolError(f"« {produit} » n'est pas au catalogue. Produits : {', '.join(_produits(catalogue))}.")
    (actuel,) = db.execute("SELECT quantite FROM stock WHERE produit = ?", (produit,)).fetchone() or (0,)
    ecart = quantite_comptee - actuel
    if abs(ecart) > ECART_MAXIMUM:
        raise ToolError(f"L'écart serait de {ecart} pour {produit} : c'est trop pour une correction d'inventaire. "
                        "Vérifiez le comptage ; pour un réassort, Awa passe par l'écran du Comptoir.")
    # Le jeton est enregistré dans la base, pas en mémoire : il survit à un redémarrage du serveur,
    # et un serveur distant sans état (chapitre 16) le retrouvera de la même façon.
    jeton = secrets.token_hex(4)
    with db:
        db.execute(_TABLE_CORRECTIONS)
        db.execute("INSERT INTO corrections_stock VALUES (?, ?, ?, ?, ?, 'preparee', NULL)",
                   (jeton, produit, actuel, quantite_comptee, maintenant.isoformat()))
    fin = (maintenant + DUREE_JETON).astimezone(COTONOU)
    if ecart == 0:
        dire = f"Le stock de {produit} est déjà de {actuel} : rien à corriger."
    else:
        sens = "de plus" if ecart > 0 else "de moins"
        dire = (f"Le Comptoir compte {actuel} pour {produit} ; vous en avez compté {quantite_comptee}, soit "
                f"{abs(ecart)} {sens}. Voulez-vous que le stock passe à {quantite_comptee} ?")
    return Correction(produit=produit, stock_actuel=actuel, quantite_comptee=quantite_comptee, ecart=ecart,
                      jeton=jeton, valable_jusqu_a=fin.strftime("%H h %M"), a_dire_a_awa=dire)


def appliquer(db: sqlite3.Connection, jeton: str, maintenant: datetime) -> CorrectionAppliquee:
    db.execute(_TABLE_CORRECTIONS)
    ligne = db.execute("SELECT * FROM corrections_stock WHERE jeton = ?", (jeton.strip(),)).fetchone()
    if ligne is None or ligne["statut"] != "preparee":
        raise ToolError("Ce jeton est inconnu ou a déjà servi. Préparez une nouvelle correction avec "
                        "preparer_correction et montrez l'écart à Awa.")
    if maintenant - datetime.fromisoformat(ligne["preparee_le"]) > DUREE_JETON:
        with db:
            db.execute("UPDATE corrections_stock SET statut = 'expiree' WHERE jeton = ?", (ligne["jeton"],))
        raise ToolError("Ce jeton a expiré (10 minutes). Préparez à nouveau la correction et redemandez "
                        "l'accord d'Awa.")
    with db:
        (actuel,) = db.execute("SELECT quantite FROM stock WHERE produit = ?", (ligne["produit"],)).fetchone() or (0,)
        if actuel != ligne["avant"]:
            db.execute("UPDATE corrections_stock SET statut = 'perimee' WHERE jeton = ?", (ligne["jeton"],))
            raise ToolError(f"Le stock de {ligne['produit']} a changé depuis la préparation ({ligne['avant']} → "
                            f"{actuel}, une vente sans doute). Préparez une nouvelle correction.")
        db.execute("INSERT OR REPLACE INTO stock VALUES (?, ?)", (ligne["produit"], ligne["apres"]))
        db.execute("UPDATE corrections_stock SET statut = 'appliquee', appliquee_le = ? WHERE jeton = ?",
                   (maintenant.isoformat(), ligne["jeton"]))
    journal.info("correction appliquée : %s %s -> %s", ligne["produit"], ligne["avant"], ligne["apres"])
    return CorrectionAppliquee(produit=ligne["produit"], avant=ligne["avant"], apres=ligne["apres"],
                               resume=f"C'est fait : le stock de {ligne['produit']} est passé de {ligne['avant']} "
                                      f"à {ligne['apres']}.")


# ---------- Le serveur MCP ------------------------------------------------------------------

serveur = MCPServer("comptoir-pour-awa", title="Comptoir pour Awa", version=VERSION, instructions=INSTRUCTIONS)

LECTURE = ToolAnnotations(read_only_hint=True, open_world_hint=False)
Produit = Literal["Jus de bissap", "Jus de gingembre", "Jus d'ananas", "Jus de corossol", "Sirop de bissap",
                  "Sirop de gingembre"]


@serveur.tool(title="Commandes d'un jour", annotations=LECTURE)
def commandes_du_jour(
    jour: Annotated[date | None, Field(description="AAAA-MM-JJ. Sans date : aujourd'hui.")] = None,
) -> CommandesDuJour:
    """Les commandes confirmées d'un jour : heure, client, quartier, produits, total. Pour « mes commandes
    d'aujourd'hui », « qu'est-ce que j'ai livré samedi ». Ne modifie rien."""
    with _ouvrir() as db:
        return lire_commandes_du_jour(db, jour or _aujourdhui())


@serveur.tool(title="Stock", annotations=LECTURE)
def stock() -> Stock:
    """Le stock de chaque produit, avec les ruptures et les stocks bas. Ne modifie rien."""
    with _ouvrir() as db:
        return lire_stock(db, _catalogue())


@serveur.tool(title="Ventes d'une semaine", annotations=LECTURE)
def ventes_de_la_semaine(
    un_jour_de_la_semaine: Annotated[date | None, Field(
        description="AAAA-MM-JJ, n'importe quel jour de la semaine voulue (du lundi au dimanche). "
                    "Sans date : la semaine en cours.")] = None,
) -> VentesSemaine:
    """Les ventes d'une semaine, du lundi au dimanche : commandes, total, bouteilles par produit, et
    comparaison avec la semaine précédente. Ne modifie rien."""
    with _ouvrir() as db:
        return lire_ventes_semaine(db, _catalogue(), un_jour_de_la_semaine or _aujourdhui())


# preparer_correction écrit un projet de correction (le jeton), jamais le stock : elle n'est donc pas
# « en lecture seule », mais elle ne détruit rien.
@serveur.tool(title="Préparer une correction de stock",
              annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False,
                                          open_world_hint=False))
def preparer_correction(
    produit: Produit,
    quantite_comptee: Annotated[int, Field(ge=0, le=1000, description="Ce qu'Awa a compté sur l'étagère.")],
) -> Correction:
    """Première étape d'une correction de stock après un inventaire : compare ce qu'Awa a compté au stock
    du Comptoir et rend l'écart avec un jeton valable 10 minutes. Ne modifie pas le stock. Montrez
    l'écart à Awa (a_dire_a_awa) et attendez son accord avant appliquer_correction."""
    with _ouvrir() as db:
        return preparer(db, _catalogue(), produit, quantite_comptee, _maintenant())


@serveur.tool(
    title="Appliquer une correction de stock",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False,
                                open_world_hint=False),
    # Claude Code demande l'accord de la personne à chaque appel, quel que soit le mode de permission.
    meta={"anthropic/requiresUserInteraction": True},
)
def appliquer_correction(jeton: Annotated[str, Field(description="Le jeton rendu par preparer_correction.")],
                         ) -> CorrectionAppliquee:
    """Seconde étape : remplace le stock du produit par la quantité comptée. Seulement avec un jeton de
    preparer_correction, et seulement après l'accord explicite d'Awa sur l'écart annoncé. Un jeton
    ne sert qu'une fois."""
    with _ouvrir() as db:
        return appliquer(db, jeton, _maintenant())


@serveur.resource("comptoir://catalogue", title="Catalogue et conditions", mime_type="text/markdown")
def catalogue() -> str:
    """Les produits de Délices d'Awa, leurs prix et les conditions de commande et de livraison."""
    c = _catalogue()
    lignes = ["# Délices d'Awa : catalogue", ""]
    lignes += [f"- {p['nom']} ({p['format']}) : {fcfa(p['prix_fcfa'])}" for p in c["produits"]]
    lignes += ["", "## Conditions", ""] + [f"- {condition}" for condition in c["conditions"]]
    return "\n".join(lignes)


@serveur.resource("comptoir://commande/{numero}", title="Une commande", mime_type="text/markdown")
def une_commande(numero: str) -> str:
    """Le détail d'une commande, par son numéro (par exemple C-0042)."""
    with _ouvrir() as db:
        for c in _commandes(db):
            if c.numero == numero:
                lignes = [f"# Commande {c.numero}", "", f"- Date : {jour_en_toutes_lettres(c.quand.date())}, "
                          f"{c.quand.strftime('%H h %M')}", f"- Client : {c.client}, {c.quartier}"]
                lignes += [f"- {l['quantite']} × {l['produit']} à {fcfa(l['prix_unitaire'])}" for l in c.lignes]
                lignes += [f"- Livraison : {fcfa(c.frais) if c.frais else 'offerte'}", f"- Total : {fcfa(c.total)}"]
                return "\n".join(lignes)
    raise ToolError(f"Aucune commande ne porte le numéro {numero}.")


@serveur.prompt(title="Bilan du soir")
def bilan_du_soir(jour: str = "") -> str:
    """Le point de fin de journée : commandes, stock à surveiller, ce qu'il faut préparer pour demain."""
    quand = f"du {jour}" if jour else "d'aujourd'hui"
    return (f"Fais-moi le bilan du soir {quand}, en cinq lignes au plus : le nombre de commandes et le total "
            "(outil commandes_du_jour), les produits en rupture ou en stock bas (outil stock), et ce que je "
            "dois préparer ou commander pour demain. Donne les chiffres tels que les outils les rendent. Ne "
            "modifie rien.")


@serveur.prompt(title="Inventaire")
def inventaire() -> str:
    """Guide l'inventaire produit par produit, avec une correction de stock seulement après accord."""
    return ("Je fais mon inventaire. Pour chaque produit que je te donne avec la quantité comptée, prépare la "
            "correction (preparer_correction), dis-moi l'écart, et attends que je réponde oui avant de "
            "l'appliquer. Un produit à la fois. À la fin, résume ce qui a changé.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")  # sur la sortie d'erreur
    serveur.run(transport="stdio")


if __name__ == "__main__":
    main()
