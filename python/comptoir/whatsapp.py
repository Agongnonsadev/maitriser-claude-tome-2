"""Le Comptoir sur WhatsApp (chapitre 19) : l'API Cloud de Meta, d'après sa documentation du 22 octobre 2026.

- Vérification du webhook : Meta envoie un GET avec hub.mode=subscribe, hub.verify_token et
  hub.challenge ; on rend hub.challenge, statut 200, si le jeton est le bon.
- Signature : chaque notification porte X-Hub-Signature-256, « sha256= » suivi du HMAC-SHA256 du corps,
  calculé avec le secret de l'application. Une notification mal signée est refusée.
- Messages entrants : entry[].changes[].value.messages[], avec from (le numéro), id (wamid…), type, text.body ;
  metadata.phone_number_id dit à quel numéro de l'entreprise répondre. Les statuts (envoyé, lu) sont ignorés.
- Doublons : Meta réessaie pendant 7 jours une notification qui n'a pas reçu un 200, et peut l'envoyer
  deux fois ; chaque message n'est traité qu'une fois (DejaVus).
- Réponse : POST https://graph.facebook.com/<version>/<phone_number_id>/messages, texte de 4 096
  caractères au plus, seulement dans la fenêtre de service de 24 heures ouverte par le client.

Le numéro d'un client est une donnée personnelle : il ne quitte pas l'annuaire (Annuaire), ni vers le
journal, ni vers le budget. Ailleurs, on écrit son empreinte (pseudonyme).
"""

import hashlib
import hmac
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx2

GRAPH = "https://graph.facebook.com"
LONGUEUR_MAX = 4096
# La politique d'utilisation d'Anthropic : dire au client qu'il parle à une IA, au début de chaque
# conversation. Sur le web, la page le dit ; sur WhatsApp, c'est le premier message, écrit par le code.
MENTION_IA = ("Bonjour, je suis le Comptoir, l'assistant automatique de Délices d'Awa : une intelligence "
              "artificielle, pas une personne. Pour parler à Awa, demandez-le simplement.")
NON_TEXTE = "Je ne lis que les messages écrits pour le moment : pouvez-vous m'écrire votre demande ?"


def signature_valide(corps: bytes, entete: str | None, secret: str) -> bool:
    if not secret or not entete or not entete.startswith("sha256="):
        return False
    attendue = hmac.new(secret.encode("utf-8"), corps, hashlib.sha256).hexdigest()
    return hmac.compare_digest(attendue, entete.removeprefix("sha256="))


def pseudonyme(numero: str, sel: str) -> str:
    """Une empreinte stable du numéro : de quoi compter et limiter, sans écrire le numéro. Sans sel, elle
    ne protège rien (les numéros possibles s'essaient tous) : refusée (chapitre 20)."""
    if not sel:
        raise ValueError("Le sel des empreintes (COMPTOIR_SEL_PSEUDONYMES) est vide.")
    return "wa-" + hmac.new(sel.encode("utf-8"), numero.encode("utf-8"), hashlib.sha256).hexdigest()[:16]


@dataclass(frozen=True)
class MessageEntrant:
    identifiant: str        # wamid…, unique : la clé contre les doublons
    numero: str             # le numéro WhatsApp du client (from)
    numero_entreprise: str  # metadata.phone_number_id : le numéro d'Awa qui a reçu le message
    type: str               # text, image, audio…
    texte: str | None
    horodatage: int


def messages_entrants(notification: dict) -> list[MessageEntrant]:
    sortie = []
    for entree in notification.get("entry", []):
        for changement in entree.get("changes", []):
            if changement.get("field") != "messages":
                continue
            valeur = changement.get("value", {})
            numero_entreprise = valeur.get("metadata", {}).get("phone_number_id", "")
            for m in valeur.get("messages", []):
                sortie.append(MessageEntrant(m.get("id", ""), m.get("from", ""), numero_entreprise, m.get("type", ""),
                                             (m.get("text") or {}).get("body"), int(m.get("timestamp") or 0)))
    return sortie


def decouper(texte: str, longueur: int = LONGUEUR_MAX) -> list[str]:
    """Un texte trop long pour un seul message, coupé entre deux paragraphes quand c'est possible."""
    morceaux = []
    while len(texte) > longueur:
        coupe = texte.rfind("\n", 0, longueur)
        coupe = coupe if coupe > longueur // 2 else longueur
        morceaux.append(texte[:coupe].rstrip())
        texte = texte[coupe:].lstrip()
    return [*morceaux, texte] if texte else morceaux


class Expediteur:
    """Envoie les réponses par l'API Graph, avec le jeton d'un utilisateur système (jamais dans le code)."""

    def __init__(self, jeton: str, version: str = "v26.0", client_http=None):
        self.jeton, self.version = jeton, version
        self.http = client_http or httpx2.Client(timeout=30)

    def envoyer(self, numero_entreprise: str, numero: str, texte: str) -> list[str]:
        """Rend les identifiants des messages envoyés ; lève une erreur HTTP si Meta refuse."""
        identifiants = []
        for morceau in decouper(texte):
            r = self.http.post(f"{GRAPH}/{self.version}/{numero_entreprise}/messages",
                               headers={"Authorization": f"Bearer {self.jeton}"},
                               json={"messaging_product": "whatsapp", "recipient_type": "individual",
                                     "to": numero, "type": "text", "text": {"body": morceau}})
            r.raise_for_status()
            identifiants += [m.get("id") for m in r.json().get("messages", [])]
        return identifiants


def _maintenant() -> datetime:
    return datetime.now(timezone.utc)


class Annuaire:
    """Pour chaque client WhatsApp : son empreinte, son numéro (pour lui répondre), sa conversation en cours.
    Dans la même base que les conversations, et purgé avec elles : c'est la seule place du numéro.
    Garde aussi les messages déjà traités, contre les doublons de Meta."""

    def __init__(self, chemin: str = ":memory:"):
        if chemin != ":memory:":
            Path(chemin).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(chemin, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS whatsapp_clients (
                pseudonyme TEXT PRIMARY KEY, numero TEXT NOT NULL, conversation TEXT NOT NULL, vu_le TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS whatsapp_deja_vus (identifiant TEXT PRIMARY KEY, recu_le TEXT NOT NULL);
            """
        )

    def nouveau(self, identifiant: str) -> bool:
        """Vrai la première fois qu'on voit ce message ; faux pour un doublon."""
        with self._db:
            return self._db.execute("INSERT OR IGNORE INTO whatsapp_deja_vus VALUES (?, ?)",
                                    (identifiant, _maintenant().isoformat())).rowcount == 1

    def conversation(self, pseudo: str) -> str | None:
        ligne = self._db.execute("SELECT conversation FROM whatsapp_clients WHERE pseudonyme = ?", (pseudo,)).fetchone()
        return ligne[0] if ligne else None

    def lier(self, pseudo: str, numero: str, conversation: str) -> None:
        with self._db:
            self._db.execute("INSERT OR REPLACE INTO whatsapp_clients VALUES (?, ?, ?, ?)",
                             (pseudo, numero, conversation, _maintenant().isoformat()))

    def effacer(self, conversation: str) -> int:
        """Le numéro lié à une conversation qu'un client a demandé d'effacer (chapitre 21 : la commande
        d'effacement du chapitre 18 oubliait l'annuaire, où le numéro restait)."""
        with self._db:
            return self._db.execute("DELETE FROM whatsapp_clients WHERE conversation = ?", (conversation,)).rowcount

    def purger(self, jours: int, maintenant: datetime | None = None) -> int:
        """Oublie les clients sans message depuis `jours` jours, et les doublons de plus de 8 jours
        (Meta ne réessaie que pendant 7 jours)."""
        instant = maintenant or _maintenant()
        with self._db:
            clients = self._db.execute("DELETE FROM whatsapp_clients WHERE vu_le < ?",
                                       ((instant - timedelta(days=jours)).isoformat(),)).rowcount
            self._db.execute("DELETE FROM whatsapp_deja_vus WHERE recu_le < ?", ((instant - timedelta(days=8)).isoformat(),))
        return clients
