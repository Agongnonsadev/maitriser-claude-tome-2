"""Le prompt système du Comptoir : un fichier versionné, rempli par le code (chapitre 5).

Les instructions vivent dans comptoir/prompts/systeme_vN.md ; les données (catalogue,
conditions) dans comptoir/donnees/delices_awa.json. Le code assemble les deux : un prix
ne s'écrit qu'à un seul endroit.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from string import Template

DOSSIER = Path(__file__).parent
VERSION_PAR_DEFAUT = "v1"


@dataclass(frozen=True)
class PromptSysteme:
    texte: str
    version: str

    @property
    def empreinte(self) -> str:
        """8 caractères qui changent dès qu'un seul caractère du prompt change."""
        return hashlib.sha256(self.texte.encode("utf-8")).hexdigest()[:8]

    @property
    def identifiant(self) -> str:
        return f"systeme-{self.version}@{self.empreinte}"


def charger_donnees(chemin: Path = DOSSIER / "donnees" / "delices_awa.json") -> dict:
    return json.loads(chemin.read_text(encoding="utf-8"))


def _fcfa(montant: int) -> str:
    """1000 -> « 1 000 FCFA », avec une espace insécable comme séparateur."""
    return f"{montant:,}".replace(",", " ") + " FCFA"


def rendre_catalogue(donnees: dict) -> str:
    return "\n".join(f"- {p['nom']} : {_fcfa(p['prix_fcfa'])} par {p['format']}" for p in donnees["produits"])


def rendre_conditions(donnees: dict) -> str:
    return "\n".join(f"- {c}" for c in donnees["conditions"])


def charger(version: str = VERSION_PAR_DEFAUT, donnees: dict | None = None) -> PromptSysteme:
    modele = Template((DOSSIER / "prompts" / f"systeme_{version}.md").read_text(encoding="utf-8"))
    donnees = donnees or charger_donnees()
    texte = modele.substitute(catalogue=rendre_catalogue(donnees), conditions=rendre_conditions(donnees))
    return PromptSysteme(texte.strip(), version)


# --- Le message du client : une donnée, jamais une instruction -----------------------

LONGUEUR_MAX = 2000
_BALISE = re.compile(r"<\s*/?\s*message_client\s*>", re.IGNORECASE)
_CONTROLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def assainir(texte: str, longueur_max: int = LONGUEUR_MAX) -> str:
    """Retire ce qui pourrait faire sortir le texte du client de sa balise, et le borne."""
    texte = _CONTROLE.sub("", texte)
    texte = _BALISE.sub("", texte)
    return texte.strip()[:longueur_max]


def message_client(texte: str) -> str:
    return f"<message_client>\n{assainir(texte)}\n</message_client>"
