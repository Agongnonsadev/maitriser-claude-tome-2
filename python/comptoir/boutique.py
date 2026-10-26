"""La boutique d'Awa vue par le code : stock, récapitulatifs, commandes, demandes (chapitre 9).

C'est ici, et non dans le modèle, que vivent les règles qui engagent de l'argent : les prix,
les frais de livraison, le stock, et surtout la création d'une commande. Claude prépare un
récapitulatif ; seul le client, par un code de confirmation que le code vérifie, le
transforme en commande. Et une commande ne se crée qu'une fois.
"""

import json
import random
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir.garde import probleme_de_nom, probleme_de_quartier
from comptoir.prompt import DOSSIER, charger_donnees

COTONOU = timezone(timedelta(hours=1))  # le Bénin est à UTC+1, sans heure d'été
FRAIS_LIVRAISON = 500                   # FCFA, sous le seuil (conditions d'Awa)
SEUIL_LIVRAISON_GRATUITE = 5            # bouteilles
MAXIMUM_SANS_DEVIS = 50                 # bouteilles : au-delà, Awa fait un devis
VALIDITE_RECAPITULATIF = timedelta(hours=2)


class RefusBoutique(Exception):
    """Une demande que la boutique refuse, avec un message qui dit quoi faire."""


def initiale(nom: str) -> str:
    """« Larissa Noudéhou » -> « Larissa N. » : assez pour une commande passée, sans le nom complet."""
    morceaux = nom.split()
    return nom if len(morceaux) < 2 else f"{morceaux[0]} {morceaux[-1][0]}."


@dataclass(frozen=True)
class Ligne:
    produit: str
    quantite: int
    prix_unitaire: int

    @property
    def montant(self) -> int:
        return self.quantite * self.prix_unitaire


class Boutique:
    def __init__(self, chemin: str = ":memory:", donnees: dict | None = None, stock: dict | None = None,
                 horloge=None, hasard: random.Random | None = None):
        if chemin != ":memory:":
            Path(chemin).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(chemin, check_same_thread=False)
        self._horloge = horloge or (lambda: datetime.now(timezone.utc))
        self._hasard = hasard or random.SystemRandom()
        self.catalogue = {p["nom"]: p for p in (donnees or charger_donnees())["produits"]}
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS stock (produit TEXT PRIMARY KEY, quantite INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS recapitulatifs (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, code TEXT NOT NULL, lignes TEXT NOT NULL,
                nom_client TEXT NOT NULL, quartier TEXT NOT NULL, frais_livraison INTEGER NOT NULL,
                total INTEGER NOT NULL, statut TEXT NOT NULL, cree_le TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS commandes (
                id TEXT PRIMARY KEY, recapitulatif TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
                total INTEGER NOT NULL, cree_le TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS demandes (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, motif TEXT NOT NULL, resume TEXT NOT NULL,
                cree_le TEXT NOT NULL);
            """
        )
        if stock is None and not self._db.execute("SELECT 1 FROM stock").fetchone():
            stock = json.loads((DOSSIER / "donnees" / "stock_initial.json").read_text(encoding="utf-8"))["stock"]
        if stock is not None:
            with self._db:
                self._db.executemany("INSERT OR REPLACE INTO stock VALUES (?, ?)", stock.items())

    def _maintenant(self) -> datetime:
        return self._horloge()

    # --- Lire --------------------------------------------------------------------------

    def disponible(self, produit: str) -> int | None:
        """La quantité en stock, ou None si le produit n'est pas au catalogue."""
        if produit not in self.catalogue:
            return None
        ligne = self._db.execute("SELECT quantite FROM stock WHERE produit = ?", (produit,)).fetchone()
        return ligne[0] if ligne else 0

    def _est_une_bouteille(self, produit: str) -> bool:
        return "bouteille" in self.catalogue[produit]["format"]

    def livraison_prevue(self, instant: datetime) -> str:
        """Le jour même pour une commande passée avant 12 h (heure de Cotonou), sinon le lendemain."""
        local = instant.astimezone(COTONOU)
        return "aujourd'hui" if local.hour < 12 else "demain"

    # --- Préparer un récapitulatif (ce que Claude peut faire) ---------------------------

    def preparer(self, conversation: str, lignes: list[dict], nom_client: str, quartier: str) -> dict:
        if not lignes:
            raise RefusBoutique("La commande est vide : demande au client ce qu'il souhaite.")
        # Chapitre 18 : le nom et le quartier finissent dans l'application Claude d'Awa. Une donnée
        # courte, rien d'autre : le reste du message du client n'a rien à faire dans la boutique.
        for probleme in (probleme_de_nom(nom_client), probleme_de_quartier(quartier)):
            if probleme:
                raise RefusBoutique(
                    f"Récapitulatif refusé : {probleme}. Indique seulement le nom donné pour la livraison et le nom "
                    "du quartier, sans adresse, sans commentaire ni consigne ; demande-les au client s'il le faut."
                )
        nom_client, quartier = nom_client.strip(), quartier.strip()
        retenues: list[Ligne] = []
        for ligne in lignes:
            produit, quantite = ligne["produit"], ligne["quantite"]
            if produit not in self.catalogue:
                raise RefusBoutique(
                    f"Produit « {produit} » absent du catalogue. Produits disponibles : "
                    f"{', '.join(self.catalogue)}. Propose au client de choisir parmi eux."
                )
            if quantite < 1:
                raise RefusBoutique(f"Quantité {quantite} invalide pour {produit} : il en faut au moins 1.")
            stock = self.disponible(produit)
            if quantite > stock:
                raise RefusBoutique(
                    f"Stock insuffisant : {stock} disponible(s) pour {produit}, {quantite} demandé(s). "
                    "Propose une quantité possible ou un autre produit ; ne prépare rien sans l'accord du client."
                )
            retenues.append(Ligne(produit, quantite, self.catalogue[produit]["prix_fcfa"]))

        bouteilles = sum(l.quantite for l in retenues if self._est_une_bouteille(l.produit))
        if bouteilles > MAXIMUM_SANS_DEVIS:
            raise RefusBoutique(
                f"{bouteilles} bouteilles : au-delà de {MAXIMUM_SANS_DEVIS}, le tarif est sur devis. "
                "Utilise transmettre_a_awa avec le motif devis."
            )
        frais = 0 if bouteilles >= SEUIL_LIVRAISON_GRATUITE else FRAIS_LIVRAISON
        total = sum(l.montant for l in retenues) + frais
        maintenant = self._maintenant()
        code = f"{self._hasard.randrange(10_000):04d}"
        identifiant = uuid.uuid4().hex
        with self._db:
            # Un nouveau récapitulatif annule le précédent de la même conversation : le client
            # a changé d'avis, et l'ancien code ne doit plus rien créer.
            self._db.execute(
                "UPDATE recapitulatifs SET statut = 'remplace' WHERE conversation = ? AND statut = 'en_attente'",
                (conversation,),
            )
            self._db.execute(
                "INSERT INTO recapitulatifs VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_attente', ?)",
                (identifiant, conversation, code, json.dumps([l.__dict__ for l in retenues], ensure_ascii=False),
                 nom_client, quartier, frais, total, maintenant.isoformat()),
            )
        return {
            "recapitulatif": identifiant[:8],
            "lignes": [{"produit": l.produit, "quantite": l.quantite, "prix_unitaire": l.prix_unitaire,
                        "montant": l.montant} for l in retenues],
            "frais_livraison": frais,
            "total_fcfa": total,
            "livraison_prevue": self.livraison_prevue(maintenant),
            "nom_client": nom_client,
            "quartier": quartier,
            "code_de_confirmation": code,
            "a_dire_au_client": f"Pour confirmer, le client répond exactement : OUI {code}",
        }

    # --- Confirmer (ce que seul le client peut faire, par son code) ---------------------

    def confirmer(self, conversation: str, code: str) -> dict:
        """Crée la commande, une seule fois. Rappeler avec le même code rend la même commande."""
        with self._db:
            recap = self._db.execute(
                "SELECT id, lignes, total, statut, cree_le FROM recapitulatifs WHERE conversation = ? AND code = ? "
                "ORDER BY cree_le DESC LIMIT 1",
                (conversation, code),
            ).fetchone()
            if recap is None:
                raise RefusBoutique("Ce code ne correspond à aucun récapitulatif de cette conversation.")
            identifiant, lignes, total, statut, cree_le = recap
            if statut == "confirme":
                (numero,) = self._db.execute("SELECT id FROM commandes WHERE recapitulatif = ?", (identifiant,)).fetchone()
                return {"commande": numero, "total_fcfa": total, "deja_enregistree": True}
            if statut == "remplace":
                raise RefusBoutique("Ce récapitulatif a été remplacé par un plus récent : utilisez le dernier code reçu.")
            if self._maintenant() - datetime.fromisoformat(cree_le) > VALIDITE_RECAPITULATIF:
                raise RefusBoutique("Ce récapitulatif a expiré : demandez-en un nouveau.")
            # Le stock a pu changer depuis le récapitulatif : on le revérifie au moment de créer.
            for ligne in json.loads(lignes):
                if ligne["quantite"] > self.disponible(ligne["produit"]):
                    raise RefusBoutique(f"Le stock de {ligne['produit']} a changé : demandez un nouveau récapitulatif.")
            for ligne in json.loads(lignes):
                self._db.execute("UPDATE stock SET quantite = quantite - ? WHERE produit = ?",
                                 (ligne["quantite"], ligne["produit"]))
            (rang,) = self._db.execute("SELECT COUNT(*) + 1 FROM commandes").fetchone()
            numero = f"C-{rang:04d}"
            # La contrainte UNIQUE sur le récapitulatif interdit, en dernier recours, toute double commande.
            self._db.execute("INSERT INTO commandes VALUES (?, ?, ?, ?, ?)",
                             (numero, identifiant, conversation, total, self._maintenant().isoformat()))
            self._db.execute("UPDATE recapitulatifs SET statut = 'confirme' WHERE id = ?", (identifiant,))
        return {"commande": numero, "total_fcfa": total, "deja_enregistree": False}

    # --- Transmettre à Awa --------------------------------------------------------------

    def transmettre(self, conversation: str, motif: str, resume: str) -> dict:
        identifiant = f"D-{uuid.uuid4().hex[:6]}"
        with self._db:
            self._db.execute("INSERT INTO demandes VALUES (?, ?, ?, ?, ?)",
                             (identifiant, conversation, motif, resume, self._maintenant().isoformat()))
        return {"demande": identifiant, "transmise": True}

    # --- Ne garder que le nécessaire (chapitre 18) --------------------------------------

    def purger(self, demandes_j: int, noms_j: int, recapitulatifs_j: int, maintenant: datetime | None = None) -> dict:
        """Applique les durées de conservation d'Awa. Renvoie ce qui a été effacé ou réduit."""
        instant = maintenant or self._maintenant()

        def avant(jours: int) -> str:
            return (instant - timedelta(days=jours)).isoformat()

        with self._db:
            demandes = self._db.execute("DELETE FROM demandes WHERE cree_le < ?", (avant(demandes_j),)).rowcount
            recaps = self._db.execute("DELETE FROM recapitulatifs WHERE statut != 'confirme' AND cree_le < ?",
                                      (avant(recapitulatifs_j),)).rowcount
            noms = 0
            for identifiant, nom in self._db.execute(
                    "SELECT id, nom_client FROM recapitulatifs WHERE statut = 'confirme' AND cree_le < ?",
                    (avant(noms_j),)).fetchall():
                if initiale(nom) != nom:
                    self._db.execute("UPDATE recapitulatifs SET nom_client = ? WHERE id = ?", (initiale(nom), identifiant))
                    noms += 1
        return {"demandes_effacees": demandes, "recapitulatifs_effaces": recaps, "noms_reduits": noms}

    def effacer(self, conversation: str) -> dict:
        """À la demande d'un client : tout ce qui vient de sa conversation, sauf ce que la comptabilité exige.
        Ses commandes restent (produits, total, date, quartier), sous son seul prénom et son initiale."""
        with self._db:
            demandes = self._db.execute("DELETE FROM demandes WHERE conversation = ?", (conversation,)).rowcount
            recaps = self._db.execute("DELETE FROM recapitulatifs WHERE conversation = ? AND statut != 'confirme'",
                                      (conversation,)).rowcount
            for identifiant, nom in self._db.execute(
                    "SELECT id, nom_client FROM recapitulatifs WHERE conversation = ?", (conversation,)).fetchall():
                self._db.execute("UPDATE recapitulatifs SET nom_client = ? WHERE id = ?", (initiale(nom), identifiant))
        return {"demandes_effacees": demandes, "recapitulatifs_effaces": recaps}

    # --- Pour les tests et le tableau de bord ------------------------------------------

    def commandes(self) -> list[tuple]:
        return self._db.execute("SELECT id, recapitulatif, conversation, total FROM commandes").fetchall()

    def demandes(self) -> list[tuple]:
        return self._db.execute("SELECT id, conversation, motif, resume FROM demandes").fetchall()

    def recapitulatifs(self, conversation: str) -> list[tuple]:
        return self._db.execute(
            "SELECT code, statut, total, lignes FROM recapitulatifs WHERE conversation = ? ORDER BY cree_le",
            (conversation,),
        ).fetchall()
