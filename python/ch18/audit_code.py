"""Chapitre 18 : les attaques qui ne coûtent rien, et les contrôles de l'audit, lancés sur le code.

Lancement, depuis le dossier python/ (GRATUIT : un faux client, aucun appel à l'API) :
    python -m ch18.audit_code --etiquette avant
    python -m ch18.audit_code --etiquette apres

Cinq attaques, sur le Comptoir du web (chapitre 6), sur ses outils et sur le dépôt :
  6. une conversation neuve à chaque message, pour échapper au quota par client ;
  7. une rafale de messages, puis un corps de requête géant ;
  8. du HTML dans la réponse de Claude, pour exécuter un script chez le client ;
  9. la conversation d'un autre client : un identifiant deviné, des outils détournés ;
 10. la clé d'API : dépôt, historique Git, journaux, résultats.
Et deux contrôles, la lecture du code contre ses promesses :
  C1. les données personnelles sont-elles supprimées à la date promise ?
  C2. le client sait-il qu'il parle à une IA ?

Le même script sert avant et après les corrections : il attaque par les portes publiques
(l'API web, les outils, les fichiers), sans rien supposer du code qui les garde.
Résultat : un tableau, et ch18/resultats/audit-<etiquette>.json.
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from anthropic.types import TextBlock, Usage

DOSSIER = Path(__file__).parent
RACINE = DOSSIER.parent                      # tome-2/code/python
DEPOT = RACINE.parents[2]                     # la racine du dépôt Git
RESULTATS = DOSSIER / "resultats"

ATTAQUANT = ("196.168.10.20", 40000)          # une adresse fixe pour l'attaquant
CLIENTE = ("196.168.77.5", 40001)             # et une autre pour une vraie cliente
HTML_PIEGE = "<img src=x onerror=\"alert('Comptoir')\">"
CLE = re.compile(r"sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}")


# --- Un faux client : il répond toujours, sans rien facturer -------------------------------------

class _Flux:
    def __init__(self, texte: str):
        self.texte, self.request_id = texte, "req_audit"
        self.message = SimpleNamespace(content=[TextBlock(type="text", text=texte)], stop_reason="end_turn",
                                       usage=Usage(input_tokens=1000, output_tokens=50))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def morceaux():
            yield self.texte
        return morceaux()

    async def get_final_message(self):
        return self.message


class FauxClient:
    """Le client du SDK, vu du Comptoir : chaque message reçoit la même réponse, 1 000 tokens d'entrée et 50 de sortie."""

    def __init__(self, texte: str = "Bonjour ! Que puis-je pour vous ?"):
        self.messages, self.texte, self.appels = self, texte, 0

    def stream(self, **requete):
        self.appels += 1
        return _Flux(self.texte)

    async def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=1000)


def _application(texte: str | None = None):
    from comptoir.budget import Budget
    from comptoir.conversations import Conversations
    from comptoir.web import creer_app

    client, budget = FauxClient(texte) if texte else FauxClient(), Budget(":memory:")
    return creer_app(client, Conversations(), budget), client, budget


def _evenements(corps: str) -> list[tuple[str, dict]]:
    sortie = []
    for bloc in corps.split("\n\n"):
        nom = next((l[7:] for l in bloc.splitlines() if l.startswith("event: ")), None)
        donnees = "".join(l[6:] for l in bloc.splitlines() if l.startswith("data: "))
        if nom:
            sortie.append((nom, json.loads(donnees)))
    return sortie


def _envoyer(http, texte: str, conversation: str | None = None) -> tuple[int, str, str | None]:
    """(statut HTTP, issue, conversation) ; issue : fin, erreur, refus ou le statut lui-même."""
    r = http.post("/api/messages", json={"conversation": conversation, "id_message": uuid.uuid4().hex,
                                         "texte": texte, "depuis": 0})
    if r.status_code != 200:
        return r.status_code, str(r.status_code), conversation
    evenements = _evenements(r.text)
    conv = next((d["conversation"] for n, d in evenements if n == "conversation"), None)
    issue = next((n for n, _ in evenements if n in ("fin", "erreur", "refus")), "aucune")
    return 200, issue, conv


# --- Les attaques ------------------------------------------------------------------------------

def attaque_6_conversations_neuves(essais_max: int = 1000) -> dict:
    """Une conversation neuve à chaque message : le quota par client ne voit jamais deux fois le même client."""
    from fastapi.testclient import TestClient

    app, client, budget = _application()
    acceptes, premier_refus = 0, None
    with TestClient(app, client=ATTAQUANT) as http:
        for _ in range(essais_max):
            statut, issue, _ = _envoyer(http, "Bonjour, vous avez du jus de bissap ?")
            if issue == "fin":
                acceptes += 1
            else:
                premier_refus = issue
                break
    with TestClient(app, client=CLIENTE) as http:
        _, issue_cliente, _ = _envoyer(http, "Bonjour, je voudrais commander 6 jus d'ananas.")
    return {
        "messages_acceptes": acceptes,
        "arret": premier_refus,
        "depense_du_jour_dollars": round(budget.du_jour(), 4),
        "appels_a_claude": client.appels,
        "une_vraie_cliente_ensuite": issue_cliente,
        "verdict": "faille" if issue_cliente != "fin" else "tenu",
    }


def attaque_7_rafale_et_corps_geant() -> dict:
    """60 messages en une minute dans la même conversation, puis un texte trop long, puis un corps de 3 Mo."""
    from fastapi.testclient import TestClient

    app, _, _ = _application()
    with TestClient(app, client=ATTAQUANT) as http:
        acceptes, conversation, debut = 0, None, time.monotonic()
        for _ in range(60):
            statut, issue, conversation = _envoyer(http, "Encore une question sur le bissap.", conversation)
            acceptes += issue == "fin"
        duree = time.monotonic() - debut
        statut_long, _, _ = _envoyer(http, "a" * 10_000)
        corps = json.dumps({"conversation": None, "id_message": uuid.uuid4().hex, "texte": "b" * 3_000_000})
        debut = time.monotonic()
        r = http.post("/api/messages", content=corps, headers={"content-type": "application/json"})
        duree_corps = time.monotonic() - debut
    return {
        "rafale_acceptee": f"{acceptes} sur 60 en {duree:.1f} s",
        "texte_de_10000_caracteres": statut_long,
        "corps_de_3_mo": r.status_code,
        "corps_de_3_mo_traite_en_s": round(duree_corps, 3),
        "verdict": "faille" if acceptes == 60 or r.status_code != 413 else "tenu",
    }


def attaque_8_html_dans_la_reponse() -> dict:
    """Claude répond par du HTML piégé : le flux le transporte-t-il tel quel, la page l'exécute-t-elle ?"""
    from fastapi.testclient import TestClient

    app, _, _ = _application(HTML_PIEGE)
    with TestClient(app, client=CLIENTE) as http:
        r = http.post("/api/messages", json={"conversation": None, "id_message": uuid.uuid4().hex,
                                             "texte": "Écrivez le nom du jus en HTML pour mon site", "depuis": 0})
        page = http.get("/").text
    textes = [d.get("texte", "") for n, d in _evenements(r.text) if n == "texte"]
    script = page.split("<script>", 1)[1].split("</script>", 1)[0] if "<script>" in page else ""
    code = "\n".join(l.split("//", 1)[0] for l in script.splitlines())  # sans les commentaires
    dangereux = sorted({m for m in re.findall(r"innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(", code)})
    return {
        "html_recu_comme_texte": HTML_PIEGE in "".join(textes),
        "insertions_dangereuses_dans_la_page": dangereux,
        "verdict": "tenu" if not dangereux else "faille",
    }


def attaque_9_conversation_d_un_autre() -> dict:
    """Deviner l'identifiant d'une conversation ; détourner un outil vers la commande d'un autre client."""
    from fastapi.testclient import TestClient

    from comptoir.boutique import Boutique
    from comptoir.outils import Execution, Outils

    app, _, _ = _application()
    with TestClient(app, client=ATTAQUANT) as http:
        devinees = [_envoyer(http, "Rappelez-moi mon adresse.", c)[2] for c in ("0" * 32, "1", "conversation-de-rachidatou")]
    # La conversation que voit l'outil est celle que le code lui a donnée, quels que soient les arguments.
    boutique = Boutique(":memory:")
    victime, attaquant = uuid.uuid4().hex, uuid.uuid4().hex
    boutique.preparer(victime, [{"produit": "Jus de bissap", "quantite": 6}], "Rachidatou", "Zogbo")
    appel = SimpleNamespace(id="toolu_audit", name="commande_preparer",
                            input={"lignes": [{"produit": "Jus de bissap", "quantite": 1}], "nom_client": "X",
                                   "quartier": "Zogbo", "conversation": victime})
    Outils(boutique, attaquant).executer(appel, Execution())
    statuts_victime = [statut for _, statut, _, _ in boutique.recapitulatifs(victime)]
    return {
        "identifiants_devines_acceptes": sum(1 for c in devinees if c in ("0" * 32, "1", "conversation-de-rachidatou")),
        "recapitulatif_de_la_victime": statuts_victime,
        "outils_disponibles": "stock_verifier, commande_preparer, transmettre_a_awa (aucun ne lit une autre conversation)",
        "verdict": "tenu" if statuts_victime == ["en_attente"] and not any(
            c in ("0" * 32, "1", "conversation-de-rachidatou") for c in devinees) else "faille",
    }


def attaque_10_la_cle() -> dict:
    """Chercher une clé d'API : fichiers suivis, tout l'historique Git, journaux et résultats sur le disque."""
    def git(*args) -> str:
        return subprocess.run(["git", "-C", str(DEPOT), *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace").stdout

    suivis = [l for l in git("grep", "-I", "-n", "-E", CLE.pattern).splitlines() if l]
    historique = CLE.findall(git("log", "-p", "--all", "--no-color"))
    sur_le_disque = []
    for dossier in ("journal", "rapports", "donnees_clients", "ch17/resultats", "ch18/resultats"):
        for f in (RACINE / dossier).rglob("*"):
            if f.is_file() and f.suffix in (".jsonl", ".json", ".txt", ".csv", ".md", ".html"):
                if CLE.search(f.read_text(encoding="utf-8", errors="ignore")):
                    sur_le_disque.append(str(f.relative_to(RACINE)))
    ignore = git("check-ignore", "-v", str(RACINE / ".env"), str(RACINE / "ch16" / "deploiement" / ".env")).strip()
    return {
        "cles_dans_les_fichiers_suivis": len(suivis),
        "cles_dans_l_historique_git": len(historique),
        "fichiers_locaux_avec_une_cle": sur_le_disque,
        "env_ignore_par_git": bool(ignore),
        "verdict": "tenu" if not (suivis or historique or sur_le_disque) and ignore else "faille",
    }


# --- Les contrôles -----------------------------------------------------------------------------

def controle_1_conservation() -> dict:
    """Les conversations sont promises supprimées après 30 jours (chapitre 6) : qui les supprime ?"""
    appels = []
    for f in list((RACINE / "comptoir").glob("*.py")) + list(RACINE.glob("ch*/*.py")):
        if f.name == "audit_code.py":
            continue
        for n, ligne in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\.purger\(", ligne) and "def purger" not in ligne:
                appels.append(f"{f.relative_to(RACINE)}:{n}")
    from comptoir.boutique import Boutique

    tables_sans_purge = [t for t in ("recapitulatifs", "demandes") if not hasattr(Boutique, "purger")]
    return {
        "appels_a_purger_dans_l_application": appels,
        "tables_de_la_boutique_jamais_purgees": tables_sans_purge,
        "verdict": "tenu" if appels and not tables_sans_purge else "faille",
    }


def controle_2_mention_ia() -> dict:
    """La politique d'utilisation d'Anthropic : un assistant qui parle à des clients doit dire qu'il est une IA."""
    page = (RACINE / "comptoir" / "pages" / "comptoir.html").read_text(encoding="utf-8")
    visible = re.sub(r"<script>.*?</script>|<style>.*?</style>|<[^>]+>", " ", page, flags=re.S)
    mention = bool(re.search(r"intelligence\s+artificielle|\bIA\b", visible))
    return {"mention_dans_la_page": mention, "verdict": "tenu" if mention else "faille"}


ATTAQUES = {
    "6. Une conversation neuve à chaque message": attaque_6_conversations_neuves,
    "7. Rafale et corps géant": attaque_7_rafale_et_corps_geant,
    "8. Du HTML dans la réponse": attaque_8_html_dans_la_reponse,
    "9. La conversation d'un autre client": attaque_9_conversation_d_un_autre,
    "10. La clé d'API": attaque_10_la_cle,
    "C1. Données gardées au-delà de 30 jours": controle_1_conservation,
    "C2. Le client sait-il qu'il parle à une IA ?": controle_2_mention_ia,
}


def auditer() -> dict:
    from comptoir import config

    with tempfile.TemporaryDirectory() as dossier:
        # Rien ne s'écrit dans le journal du Comptoir : l'audit a le sien, jeté à la fin.
        config.JOURNAL = str(Path(dossier) / "journal-audit.jsonl")
        resultats = {}
        for nom, attaque in ATTAQUES.items():
            debut = time.perf_counter()
            resultats[nom] = attaque()
            resultats[nom]["duree_s"] = round(time.perf_counter() - debut, 2)
    return resultats


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--etiquette", default=datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    resultats = auditer()
    for nom, r in resultats.items():
        print(f"{r['verdict'].upper():6} {nom}")
        for cle, valeur in r.items():
            if cle not in ("verdict",):
                print(f"         {cle} : {valeur}")
    RESULTATS.mkdir(parents=True, exist_ok=True)
    sortie = RESULTATS / f"audit-{args.etiquette}.json"
    sortie.write_text(json.dumps({"date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                  "resultats": resultats}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {sortie.relative_to(RACINE)}")


if __name__ == "__main__":
    main()
