"""Le budget du Comptoir : plafonds par client, par jour et par mois, vérifiés avant chaque appel (chapitre 8).

Le principe est celui du plafond quotidien de Studio Botlyx : vérifier avant de lancer, en
comptant ce qui est déjà en cours. Chaque appel réserve d'abord son coût maximal possible
(entrée connue, sortie au plus max_tokens), puis règle son coût réel une fois terminé.
Dix appels lancés en même temps ne peuvent donc pas dépasser le plafond à eux dix.

Les jours et les mois sont comptés en temps universel (UTC), comme le plafond mensuel
d'Anthropic, qui repart le 1er à 00:00 UTC.
"""

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from comptoir import config


@dataclass(frozen=True)
class Decision:
    accepte: bool
    reservation: str | None = None
    motif: str | None = None    # quota_client, budget_jour, budget_mois
    alerte: bool = False        # le seuil d'alerte du jour ou du mois est franchi


class Budget:
    def __init__(self, chemin: str = ":memory:", horloge=None):
        if chemin != ":memory:":
            Path(chemin).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(chemin, check_same_thread=False)
        self._horloge = horloge or (lambda: datetime.now(timezone.utc))
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS depenses (
                id TEXT PRIMARY KEY, jour TEXT NOT NULL, mois TEXT NOT NULL,
                client TEXT NOT NULL, dollars REAL NOT NULL, reglee INTEGER NOT NULL, groupe TEXT)"""
        )
        # Chapitre 18 : la colonne groupe (l'adresse réseau du client), ajoutée aux bases déjà créées.
        if "groupe" not in {ligne[1] for ligne in self._db.execute("PRAGMA table_info(depenses)")}:
            self._db.execute("ALTER TABLE depenses ADD COLUMN groupe TEXT")
        self._db.commit()

    def _maintenant(self) -> tuple[str, str]:
        instant = self._horloge()
        return instant.strftime("%Y-%m-%d"), instant.strftime("%Y-%m")

    def _somme(self, condition: str, valeur: str) -> float:
        (total,) = self._db.execute(f"SELECT COALESCE(SUM(dollars), 0) FROM depenses WHERE {condition} = ?", (valeur,)).fetchone()
        return total

    def du_jour(self) -> float:
        return self._somme("jour", self._maintenant()[0])

    def du_mois(self) -> float:
        return self._somme("mois", self._maintenant()[1])

    def du_client(self, client_id: str) -> float:
        jour, _ = self._maintenant()
        (total,) = self._db.execute(
            "SELECT COALESCE(SUM(dollars), 0) FROM depenses WHERE jour = ? AND client = ?", (jour, client_id)
        ).fetchone()
        return total

    def du_groupe(self, groupe: str) -> float:
        jour, _ = self._maintenant()
        (total,) = self._db.execute(
            "SELECT COALESCE(SUM(dollars), 0) FROM depenses WHERE jour = ? AND groupe = ?", (jour, groupe)
        ).fetchone()
        return total

    def reserver(self, client_id: str, maximum: float, groupe: str | None = None) -> Decision:
        """Réserve le coût maximal d'un appel, s'il tient dans les plafonds.

        groupe (chapitre 18) : ce qui relie plusieurs conversations, l'adresse réseau sur le web. Une
        conversation neuve à chaque message ne remet pas ce compteur à zéro."""
        jour, mois = self._maintenant()
        plafonds = [("quota_client", self.du_client(client_id), config.QUOTA_CLIENT_JOUR)]
        if groupe:
            plafonds.append(("quota_reseau", self.du_groupe(groupe), config.QUOTA_RESEAU_JOUR))
        plafonds += [("budget_jour", self.du_jour(), config.BUDGET_JOUR),
                     ("budget_mois", self.du_mois(), config.BUDGET_MOIS)]
        with self._db:  # vérifier et réserver dans la même transaction
            for motif, depense, plafond in plafonds:
                if depense + maximum > plafond:
                    return Decision(False, motif=motif, alerte=True)
            reservation = uuid.uuid4().hex
            self._db.execute(
                "INSERT INTO depenses (id, jour, mois, client, dollars, reglee, groupe) VALUES (?, ?, ?, ?, ?, 0, ?)",
                (reservation, jour, mois, client_id, maximum, groupe),
            )
        return Decision(True, reservation, alerte=self.en_alerte())

    def regler(self, reservation: str, dollars: float) -> None:
        """Remplace la réservation par le coût réel de l'appel."""
        with self._db:
            self._db.execute("UPDATE depenses SET dollars = ?, reglee = 1 WHERE id = ?", (dollars, reservation))

    def ajouter(self, client_id: str, dollars: float, groupe: str | None = None) -> None:
        """Compte une dépense déjà faite, sans plafond à vérifier : l'appel a eu lieu (chapitre 20, la
        surveillance, qui tourne à côté de la réponse et ne réserve rien avant)."""
        jour, mois = self._maintenant()
        with self._db:
            self._db.execute(
                "INSERT INTO depenses (id, jour, mois, client, dollars, reglee, groupe) VALUES (?, ?, ?, ?, ?, 1, ?)",
                (uuid.uuid4().hex, jour, mois, client_id, dollars, groupe),
            )

    def liberer(self, reservation: str) -> None:
        """Annule une réservation : l'appel n'a rien coûté (refusé par l'API avant tout traitement)."""
        with self._db:
            self._db.execute("DELETE FROM depenses WHERE id = ?", (reservation,))

    def en_alerte(self) -> bool:
        return self.du_jour() >= config.SEUIL_ALERTE * config.BUDGET_JOUR or (
            self.du_mois() >= config.SEUIL_ALERTE * config.BUDGET_MOIS
        )
