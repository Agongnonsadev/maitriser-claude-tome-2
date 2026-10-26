"""Les conversations du Comptoir, gardées par l'application (chapitre 6).

L'API ne garde rien : c'est ici que vit l'historique. Il est en ajout seul : on ajoute
des messages, on ne modifie ni ne supprime jamais un message passé d'une conversation
ouverte. Les blocs renvoyés par Claude, réflexion comprise, sont gardés tels quels.
"""

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir import config


def _maintenant() -> datetime:
    return datetime.now(timezone.utc)


def en_blocs(contenu) -> str | list[dict]:
    """Le contenu d'un message, sous une forme qui se range en JSON et se renvoie à l'API.

    exclude_none : un simple model_dump() ajouterait des champs vides (citations: null…)
    que l'API refuse quand on les lui renvoie.
    """
    if isinstance(contenu, str):
        return contenu
    return [b if isinstance(b, dict) else b.model_dump(mode="json", exclude_none=True) for b in contenu]


class Conversations:
    def __init__(self, chemin: str = ":memory:"):
        if chemin != ":memory:":
            Path(chemin).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(chemin, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                creee_le TEXT NOT NULL,
                derniere_activite TEXT NOT NULL,
                tokens INTEGER NOT NULL DEFAULT 0,
                prompt TEXT);
            CREATE TABLE IF NOT EXISTS messages (
                conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                rang INTEGER NOT NULL,
                role TEXT NOT NULL,
                contenu TEXT NOT NULL,
                PRIMARY KEY (conversation, rang));
            PRAGMA foreign_keys = ON;
            """
        )

    def creer(self, prompt: str | None = None) -> str:
        """prompt : l'identifiant du prompt système (version et empreinte) qui ouvre la conversation."""
        identifiant = uuid.uuid4().hex
        date = _maintenant().isoformat()
        with self._db:
            self._db.execute("INSERT INTO conversations VALUES (?, ?, ?, 0, ?)", (identifiant, date, date, prompt))
        return identifiant

    def existe(self, identifiant: str) -> bool:
        return self._db.execute("SELECT 1 FROM conversations WHERE id = ?", (identifiant,)).fetchone() is not None

    def historique(self, identifiant: str) -> list[dict]:
        lignes = self._db.execute(
            "SELECT role, contenu FROM messages WHERE conversation = ? ORDER BY rang", (identifiant,)
        ).fetchall()
        return [{"role": role, "content": json.loads(contenu)} for role, contenu in lignes]

    def ajouter_tour(self, identifiant: str, messages: list[dict], tokens: int) -> None:
        """Ajoute un tour complet (message du client, réponse de Claude) dans une seule transaction.

        On n'enregistre jamais une question sans sa réponse : si l'appel échoue, rien n'est
        écrit, et l'historique reste tel que Claude l'a vu la dernière fois.
        tokens : la taille du contexte après ce tour (entrée, cache compris, plus la sortie).
        """
        with self._db:
            (rang,) = self._db.execute(
                "SELECT COALESCE(MAX(rang), -1) + 1 FROM messages WHERE conversation = ?", (identifiant,)
            ).fetchone()
            for decalage, message in enumerate(messages):
                self._db.execute(
                    "INSERT INTO messages VALUES (?, ?, ?, ?)",
                    (
                        identifiant,
                        rang + decalage,
                        message["role"],
                        json.dumps(en_blocs(message["content"]), ensure_ascii=False),
                    ),
                )
            self._db.execute(
                "UPDATE conversations SET derniere_activite = ?, tokens = ? WHERE id = ?",
                (_maintenant().isoformat(), tokens, identifiant),
            )

    def motif_de_cloture(
        self, identifiant: str, prompt: str | None = None, maintenant: datetime | None = None
    ) -> str | None:
        """« nouveau_prompt », « expiree », « trop_longue », ou None si la conversation peut continuer.

        Un prompt système modifié invalide les blocs de réflexion déjà dans l'historique :
        la requête suivante serait refusée (erreur 400). La conversation est donc close
        quand le prompt du jour n'est plus celui qui l'a ouverte.
        """
        derniere, tokens, prompt_initial = self._db.execute(
            "SELECT derniere_activite, tokens, prompt FROM conversations WHERE id = ?", (identifiant,)
        ).fetchone()
        if prompt is not None and prompt != prompt_initial:
            return "nouveau_prompt"
        if (maintenant or _maintenant()) - datetime.fromisoformat(derniere) > timedelta(hours=config.EXPIRATION_H):
            return "expiree"
        if tokens > config.CONTEXTE_MAX:
            return "trop_longue"
        return None

    def effacer(self, identifiant: str) -> bool:
        """À la demande du client (chapitre 18) : la conversation et tous ses messages, tout de suite."""
        with self._db:
            return self._db.execute("DELETE FROM conversations WHERE id = ?", (identifiant,)).rowcount == 1

    def purger(self, maintenant: datetime | None = None) -> int:
        """Supprime les conversations sans activité depuis CONSERVATION_J jours. Renvoie leur nombre."""
        limite = (maintenant or _maintenant()) - timedelta(days=config.CONSERVATION_J)
        with self._db:
            curseur = self._db.execute("DELETE FROM conversations WHERE derniere_activite < ?", (limite.isoformat(),))
        return curseur.rowcount
