"""La notation par Claude, avec une grille (chapitre 17).

Le juge lit ce que le code ne sait pas juger : une affirmation exacte ou inventée, une promesse
tournée autrement, une réponse à côté, le ton. Il travaille dans son propre contexte : il ne voit
ni le prompt du Comptoir ni sa réflexion, seulement les documents d'Awa, le message, la réponse,
les actions du système et l'attendu. Il écrit son constat avant son verdict (l'ordre du schéma
est respecté, et un verdict posé avant le constat se trompe plus souvent, chapitre 12), et il a
droit à « inconnu » plutôt que d'inventer.

Un juge se vérifie avant de servir : ch17/etalonnage.py compare ses verdicts à des notes humaines.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

from comptoir.connaissances import charger_base
from comptoir.couts import cout
from comptoir.journal import noter as noter_au_journal
from comptoir.prompt import PromptSysteme, charger_donnees, rendre_catalogue, rendre_conditions

DOSSIER = Path(__file__).parent
CRITERES = ("exacte", "sans_promesse", "repond", "ton")
GRILLE = "v2"  # v1 : sans les résultats d'outils ; v2 : avec (voir actions)
VERDICTS = ("oui", "non", "inconnu")
MAX_TOKENS = 3000

SCHEMA = {
    "type": "object",
    "properties": {
        c: {
            "type": "object",
            "properties": {"constat": {"type": "string"}, "verdict": {"type": "string", "enum": list(VERDICTS)}},
            "required": ["constat", "verdict"],
            "additionalProperties": False,
        }
        for c in CRITERES
    },
    "required": list(CRITERES),
    "additionalProperties": False,
}


def charger_grille(version: str = GRILLE) -> PromptSysteme:
    texte = (DOSSIER / "grilles" / f"juge_{version}.md").read_text(encoding="utf-8").strip()
    return PromptSysteme(texte, f"juge-{version}")


def documents() -> str:
    """Les mêmes faits que ceux du Comptoir : catalogue, conditions et base d'Awa."""
    donnees = charger_donnees()
    base = "\n\n".join(f"## {m.titre}\n{m.texte}" for m in charger_base())
    return (f"<documents>\n<catalogue>\n{rendre_catalogue(donnees)}\n</catalogue>\n<conditions>\n"
            f"{rendre_conditions(donnees)}\n</conditions>\n{base}\n</documents>")


def outils_et_resultats(essai) -> list[str]:
    """Chaque outil appelé, avec ce qu'il a répondu : le résultat d'un appel arrive avec l'appel suivant."""
    lignes = []
    for rang, appel in enumerate(essai.appels):
        demandes = [b for b in appel["rendu"] if b["type"] == "tool_use"]
        recus = essai.appels[rang + 1]["recu"] if rang + 1 < len(essai.appels) else []
        for i, bloc in enumerate(demandes):
            resultat = recus[i] if i < len(recus) else None
            reponse = ("(pas de résultat)" if resultat is None
                       else ("ERREUR : " if resultat["erreur"] else "") + resultat["contenu"][:220])
            lignes.append(f"- {bloc['name']} {json.dumps(bloc['input'], ensure_ascii=False)[:160]} → {reponse}")
    return lignes


def actions(essai) -> str:
    """Ce que le système a fait, lu dans la boutique et dans la transcription : le juge vérifie le texte
    contre les faits. Ajouté après la première notation : sans les résultats d'outils, le juge prenait
    pour inventé un stock que le Comptoir avait bel et bien vérifié."""
    en_attente = [r for r in essai.recapitulatifs if r["statut"] == "en_attente"]
    lignes = [f"récapitulatif préparé : {'oui, total ' + str(en_attente[-1]['total']) + ' FCFA' if en_attente else 'non'}",
              f"demandes transmises à Awa : {', '.join(essai.demandes) if essai.demandes else 'aucune'}",
              f"commandes créées : {essai.commandes}"]
    outils = outils_et_resultats(essai)
    lignes.append("outils appelés et leurs résultats :" + ("\n" + "\n".join(outils) if outils else " aucun"))
    return "\n".join(lignes)


def requete(cas: dict, essai, modele: str, grille: PromptSysteme | None = None) -> dict:
    grille = grille or charger_grille()
    recapitulatif = essai.texte[len(essai.texte_claude):].strip() or "aucun"
    a_noter = (f"<message_client>\n{cas['message']}\n</message_client>\n"
               f"<reponse_du_comptoir>\n{essai.texte_claude}\n</reponse_du_comptoir>\n"
               f"<recapitulatif_officiel>\n{recapitulatif}\n</recapitulatif_officiel>\n"
               f"<actions_du_systeme>\n{actions(essai)}\n</actions_du_systeme>\n"
               f"<attendu>\n{cas['reference']}\n</attendu>")
    return {
        "model": modele,
        "max_tokens": MAX_TOKENS,
        "system": grille.texte,
        "messages": [{"role": "user", "content": [
            # Les documents ne changent pas d'un jugement à l'autre : ils sont lus dans le cache.
            {"type": "text", "text": documents(), "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": a_noter},
        ]}],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
    }


@dataclass
class Jugement:
    essai: str                     # l'identifiant de l'essai jugé
    modele: str
    grille: str
    verdicts: dict[str, str] = field(default_factory=dict)
    constats: dict[str, str] = field(default_factory=dict)
    cout_dollars: float = 0.0
    erreur: str | None = None

    @property
    def issue(self) -> str:
        """« reussi » si tout est oui, « echoue » au premier non, sinon « a_relire »."""
        if self.erreur or not self.verdicts:
            return "a_relire"
        if "non" in self.verdicts.values():
            return "echoue"
        return "reussi" if all(v == "oui" for v in self.verdicts.values()) else "a_relire"


def juger(client, cas: dict, essai, modele: str, grille: PromptSysteme | None = None) -> Jugement:
    grille = grille or charger_grille()
    params = requete(cas, essai, modele, grille)
    message = client.messages.create(**params)
    prix = cout(modele, message.usage)
    noter_au_journal(message._request_id, modele, prix, prompt=grille.identifiant, stop_reason=message.stop_reason)
    jugement = Jugement(essai.identifiant, modele, grille.identifiant, cout_dollars=round(prix.dollars, 6))
    if message.stop_reason != "end_turn":
        jugement.erreur = f"jugement arrêté par {message.stop_reason}"
        return jugement
    donnees = json.loads("".join(b.text for b in message.content if b.type == "text"))
    jugement.verdicts = {c: donnees[c]["verdict"] for c in CRITERES}
    jugement.constats = {c: donnees[c]["constat"] for c in CRITERES}
    return jugement
