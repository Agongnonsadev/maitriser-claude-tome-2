"""L'atelier d'Awa : ventes, stock, recettes, fournisseurs, événements et bons de commande (chapitre 13).

L'agent de réapprovisionnement lit ces données par ses outils et propose un bon de commande.
Tout ce qui se calcule se calcule ici : les ventes par semaine, les besoins en articles, le
contrôle et le total du bon. L'agent ne fait aucune addition qui compte, et il n'envoie rien :
un bon reste « à valider » tant qu'Awa ne l'a pas validé elle-même.
"""

import csv
import json
import math
import uuid
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

DONNEES = Path(__file__).parent / "donnees" / "atelier"
AUJOURDHUI = date(2026, 10, 19)   # le lundi du bon de commande, dans le récit
PLAFOND_FCFA = 250_000            # ce qu'Awa engage au plus sur un bon, sans en parler d'abord à sa banque
HORIZON_JOURS = 60                # une livraison souhaitée au-delà ne se commande pas aujourd'hui

A_VALIDER, VALIDE, REFUSE, REMPLACE = "à valider par Awa", "validé par Awa", "refusé par Awa", "remplacé"


class BonInvalide(Exception):
    def __init__(self, erreurs: list[str]):
        super().__init__(" ; ".join(erreurs))
        self.erreurs = erreurs


@dataclass
class Bon:
    code: str
    lignes: list[dict]          # article, fournisseur, quantite, unite, livraison_souhaitee, prix_fcfa, montant_fcfa
    total_fcfa: int
    justification: str
    alertes: list[str]
    statut: str = A_VALIDER
    cree_le: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    decision_note: str | None = None


def _lire_json(dossier: Path, nom: str) -> dict:
    return json.loads((dossier / nom).read_text(encoding="utf-8"))


def _fcfa(montant: float) -> str:
    return f"{round(montant):,}".replace(",", " ") + " FCFA"


def _unites(unite: str, quantite: float) -> str:
    """« unité » -> « unités » au pluriel ; « kg » ne change pas."""
    return unite + "s" if quantite >= 2 and unite in ("unité", "pièce") else unite


def _nombre(valeur: float) -> str:
    """2.0 -> « 2 », 2.5 -> « 2.5 » : des quantités lisibles, sans faux décimales."""
    return f"{valeur:g}"


class Atelier:
    def __init__(self, dossier: Path = DONNEES, aujourdhui: date = AUJOURDHUI, plafond_fcfa: int = PLAFOND_FCFA,
                 bons: Path | None = None):
        self.dossier, self.aujourdhui, self.plafond_fcfa = dossier, aujourdhui, plafond_fcfa
        self.chemin_bons = bons      # None : les bons restent en mémoire (tests, mesures)
        self._bons: dict[str, Bon] = {}
        if bons and bons.exists():
            self._bons = {b["code"]: Bon(**b) for b in json.loads(bons.read_text(encoding="utf-8"))}

    # --- Lecture -------------------------------------------------------------------------

    def ventes_par_semaine(self) -> dict[str, dict[str, dict[str, int]]]:
        """{lundi : {produit : {"habituel": n, "evenement": n}}}, calculé sur le fichier des ventes."""
        semaines: dict[str, dict[str, dict[str, int]]] = defaultdict(lambda: defaultdict(lambda: {"habituel": 0,
                                                                                                    "evenement": 0}))
        with (self.dossier / "ventes.csv").open(encoding="utf-8") as f:
            for ligne in csv.DictReader(f):
                jour = date.fromisoformat(ligne["date"])
                lundi = (jour - timedelta(days=jour.weekday())).isoformat()
                genre = "evenement" if ligne["canal"] == "evenement" else "habituel"
                semaines[lundi][ligne["produit"]][genre] += int(ligne["quantite"])
        return {s: dict(p) for s, p in sorted(semaines.items())}

    def produits(self) -> list[str]:
        return list(self.recettes()["recettes"])

    def resume_ventes(self) -> str:
        """Le tableau que lit l'agent : ventes habituelles par semaine, moyennes et commandes d'événement à part."""
        semaines = self.ventes_par_semaine()
        lignes = ["Ventes habituelles par semaine (bouteilles ou flacons), commandes d'événement exclues :"]
        for lundi, ventes in semaines.items():
            lignes.append(f"- semaine du {lundi} : " + ", ".join(
                f"{p} {ventes.get(p, {}).get('habituel', 0)}" for p in self.produits()))
        dernieres = list(semaines.values())[-4:]
        lignes.append("Moyennes par semaine (calculées par le code) :")
        for p in self.produits():
            sur_8 = sum(v.get(p, {}).get("habituel", 0) for v in semaines.values()) / len(semaines)
            sur_4 = sum(v.get(p, {}).get("habituel", 0) for v in dernieres) / len(dernieres)
            lignes.append(f"- {p} : {sur_8:.1f} sur 8 semaines, {sur_4:.1f} sur les 4 dernières")
        evenements = [(lundi, p, n["evenement"]) for lundi, v in semaines.items() for p, n in v.items() if n["evenement"]]
        lignes.append("Commandes d'événement passées (ponctuelles) : " + ("; ".join(
            f"semaine du {lundi}, {p} {n}" for lundi, p, n in evenements) or "aucune"))
        return "\n".join(lignes)

    def stock(self) -> dict:
        return _lire_json(self.dossier, "stock.json")

    def recettes(self) -> dict:
        return _lire_json(self.dossier, "recettes.json")

    def offres(self) -> list[dict]:
        return _lire_json(self.dossier, "fournisseurs.json")["offres"]

    def evenements(self) -> list[dict]:
        return _lire_json(self.dossier, "evenements.json")["evenements"]

    def messages_fournisseurs(self) -> str:
        return (self.dossier / "messages-fournisseurs.md").read_text(encoding="utf-8")

    def unite(self, article: str) -> str:
        return self.recettes()["unites"].get(article, "unité")

    # --- Calculs -------------------------------------------------------------------------

    def besoins(self, production: dict[str, int]) -> list[dict]:
        """Ce que demande une production (bouteilles ou flacons par produit), moins le stock d'articles,
        et, pour chaque offre, la quantité à commander qui respecte le minimum et le conditionnement."""
        inconnus = [p for p in production if p not in self.recettes()["recettes"]]
        if inconnus:
            raise ValueError(f"produits inconnus : {', '.join(inconnus)} ; produits connus : {', '.join(self.produits())}")
        brut: dict[str, float] = defaultdict(float)
        for produit, nombre in production.items():
            for article, par_unite in self.recettes()["recettes"][produit].items():
                brut[article] += par_unite * nombre
        en_stock = self.stock()["articles"]
        resultat = []
        for article, besoin in brut.items():
            net = max(0.0, besoin - en_stock.get(article, 0))
            suggestions = []
            for o in (o for o in self.offres() if o["article"] == article):
                quantite = 0 if net == 0 else max(o["minimum"], math.ceil(net / o["conditionnement"] - 1e-9)
                                                  * o["conditionnement"])
                suggestions.append({"fournisseur": o["fournisseur"], "quantite": quantite,
                                    "montant_fcfa": round(quantite * o["prix_fcfa"])})
            resultat.append({"article": article, "unite": self.unite(article), "besoin": round(besoin, 3),
                             "stock": en_stock.get(article, 0), "besoin_net": round(net, 3),
                             "a_commander_selon_fiches": suggestions})
        return resultat

    def verifier(self, lignes: list[dict]) -> list[str]:
        """Les erreurs d'un projet de bon ; une liste vide s'il respecte les fiches et le plafond."""
        erreurs, total, vues = [], 0.0, set()
        if not lignes:
            return ["le bon ne contient aucune ligne"]
        for i, ligne in enumerate(lignes, start=1):
            article, fournisseur = ligne.get("article"), ligne.get("fournisseur")
            offre = next((o for o in self.offres() if o["article"] == article and o["fournisseur"] == fournisseur), None)
            if offre is None:
                vendeurs = [o["fournisseur"] for o in self.offres() if o["article"] == article]
                erreurs.append(f"ligne {i} : {fournisseur!r} ne vend pas {article!r}" +
                               (f" (fournisseurs de cet article : {', '.join(vendeurs)})" if vendeurs else
                                " (article inconnu)"))
                continue
            quantite = float(ligne.get("quantite") or 0)
            if quantite < offre["minimum"]:
                erreurs.append(f"ligne {i} : {_nombre(quantite)} {article}, en dessous du minimum de "
                               f"{offre['minimum']} chez {fournisseur}")
            elif abs(quantite / offre["conditionnement"] - round(quantite / offre["conditionnement"])) > 1e-9:
                erreurs.append(f"ligne {i} : {fournisseur} vend {article} par {offre['conditionnement']} "
                               f"{_unites(self.unite(article), offre['conditionnement'])}")
            try:
                livraison = date.fromisoformat(str(ligne.get("livraison_souhaitee")))
            except ValueError:
                erreurs.append(f"ligne {i} : date de livraison illisible ({ligne.get('livraison_souhaitee')!r}), "
                               "format attendu AAAA-MM-JJ")
            else:
                au_plus_tot = self.aujourdhui + timedelta(days=offre["delai_jours"])
                if livraison < au_plus_tot:
                    erreurs.append(f"ligne {i} : livraison le {livraison} impossible, le délai de {fournisseur} est "
                                   f"de {offre['delai_jours']} jours (au plus tôt le {au_plus_tot})")
                elif livraison > self.aujourdhui + timedelta(days=HORIZON_JOURS):
                    erreurs.append(f"ligne {i} : livraison le {livraison}, trop loin pour la commander aujourd'hui")
                cle = (article, fournisseur, livraison)
                if cle in vues:
                    erreurs.append(f"ligne {i} : doublon ({article}, {fournisseur}, {livraison})")
                vues.add(cle)
            total += quantite * offre["prix_fcfa"]
        if total > self.plafond_fcfa:
            erreurs.append(f"total de {_fcfa(total)}, au-dessus du plafond de {_fcfa(self.plafond_fcfa)} fixé par Awa")
        return erreurs

    # --- Le bon de commande --------------------------------------------------------------

    def proposer(self, lignes: list[dict], justification: str, alertes: list[str] | None = None) -> Bon:
        """Enregistre un projet de bon, à valider par Awa. Lève BonInvalide si les fiches ne sont pas respectées.
        Rien n'est envoyé à un fournisseur : c'est Awa qui envoie un bon validé."""
        erreurs = self.verifier(lignes)
        if erreurs:
            raise BonInvalide(erreurs)
        detail = []
        for ligne in lignes:
            offre = next(o for o in self.offres() if o["article"] == ligne["article"]
                         and o["fournisseur"] == ligne["fournisseur"])
            quantite = float(ligne["quantite"])
            detail.append({"article": ligne["article"], "fournisseur": ligne["fournisseur"],
                           "quantite": quantite, "unite": self.unite(ligne["article"]),
                           "livraison_souhaitee": str(ligne["livraison_souhaitee"]),
                           "prix_fcfa": offre["prix_fcfa"], "montant_fcfa": round(quantite * offre["prix_fcfa"])})
        bon = Bon(f"BC-{uuid.uuid4().hex[:6]}", detail, sum(l["montant_fcfa"] for l in detail), justification,
                  list(alertes or []))
        self._bons[bon.code] = bon
        self._enregistrer()
        return bon

    def retirer(self, code: str, remplace_par: str) -> None:
        """Un projet de bon que l'agent remplace par un autre, dans la même séance : il n'est plus à valider."""
        bon = self._bons[code]
        if bon.statut == A_VALIDER:
            bon.statut = f"{REMPLACE} par {remplace_par}"
            self._enregistrer()

    def decider(self, code: str, valide: bool, note: str | None = None) -> Bon:
        """La décision d'Awa, hors de l'agent : la seule façon de faire sortir un bon de « à valider »."""
        bon = self._bons[code]
        if bon.statut != A_VALIDER:
            raise ValueError(f"le bon {code} est déjà {bon.statut}")
        bon.statut, bon.decision_note = (VALIDE if valide else REFUSE), note
        self._enregistrer()
        return bon

    def bons(self) -> list[Bon]:
        return list(self._bons.values())

    def _enregistrer(self) -> None:
        if self.chemin_bons:
            self.chemin_bons.parent.mkdir(parents=True, exist_ok=True)
            self.chemin_bons.write_text(json.dumps([asdict(b) for b in self._bons.values()], ensure_ascii=False,
                                                   indent=2), encoding="utf-8")


def rendre_bon(bon: Bon) -> str:
    lignes = [f"Bon {bon.code} — {bon.statut} — total {_fcfa(bon.total_fcfa)}"]
    for l in bon.lignes:
        lignes.append(f"- {_nombre(l['quantite'])} {_unites(l['unite'], l['quantite'])} de {l['article']} chez {l['fournisseur']}, "
                      f"livraison le {l['livraison_souhaitee']} : {_fcfa(l['montant_fcfa'])}")
    if bon.alertes:
        lignes.append("Alertes : " + " | ".join(bon.alertes))
    return "\n".join(lignes)
