"""Le Comptoir sur le web, avec un faux client : flux SSE, reprise, une réponse à la fois."""

import json
from datetime import datetime, timedelta, timezone

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

from comptoir.conversations import Conversations
from comptoir.flux import Generation
from comptoir.prompt import charger, charger_donnees
from comptoir.erreurs import INDISPONIBLE
from comptoir.web import creer_app
from faux_clients import FauxClientAsync, FauxFlux


@pytest.fixture(autouse=True)
def journal_temporaire(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.BUDGET", ":memory:")  # jamais de fichier pendant les tests


def lire_sse(corps: str) -> list[tuple[str, dict]]:
    """Découpe un flux SSE en (nom, données). Les commentaires (signes de vie) sont ignorés."""
    evenements = []
    for bloc in corps.split("\n\n"):
        nom = next((l[7:] for l in bloc.splitlines() if l.startswith("event: ")), None)
        donnees = "".join(l[6:] for l in bloc.splitlines() if l.startswith("data: "))
        if nom:
            evenements.append((nom, json.loads(donnees)))
    return evenements


def envoyer(http, texte, id_message, conversation=None, depuis=0):
    r = http.post(
        "/api/messages",
        json={"conversation": conversation, "id_message": id_message, "texte": texte, "depuis": depuis},
    )
    return r, lire_sse(r.text) if r.status_code == 200 else []


def test_la_page_s_affiche():
    with TestClient(creer_app(FauxClientAsync(), Conversations())) as http:
        r = http.get("/")
    assert r.status_code == 200 and "Le Comptoir d'Awa" in r.text


def test_la_reponse_arrive_en_morceaux_puis_est_rangee():
    conversations = Conversations()
    client = FauxClientAsync(FauxFlux(["Nous avons ", "du bissap."]))
    with TestClient(creer_app(client, conversations)) as http:
        r, evenements = envoyer(http, "Vos jus ?", "message-0001")
    assert r.headers["content-type"].startswith("text/event-stream")
    assert [nom for nom, _ in evenements] == ["conversation", "texte", "texte", "fin"]
    conversation = evenements[0][1]["conversation"]
    historique = conversations.historique(conversation)
    assert historique[0] == {"role": "user", "content": "<message_client>\nVos jus ?\n</message_client>"}
    # La réponse est rangée telle quelle, réflexion comprise.
    assert [b["type"] for b in historique[1]["content"]] == ["thinking", "text"]


def test_le_tour_suivant_renvoie_l_historique_sans_le_reecrire():
    conversations = Conversations()
    client = FauxClientAsync(FauxFlux(["Oui, le bissap."]), FauxFlux(["Six bouteilles : 6 000 FCFA."]))
    with TestClient(creer_app(client, conversations)) as http:
        _, evenements = envoyer(http, "Vous avez du bissap ?", "message-0001")
        conversation = evenements[0][1]["conversation"]
        envoyer(http, "Et pour six bouteilles ?", "message-0002", conversation)
    premiere, deuxieme = client.requetes
    assert deuxieme["messages"][:1] == premiere["messages"]  # même début, au caractère près
    assert deuxieme["messages"][1]["role"] == "assistant"
    assert deuxieme["messages"][1]["content"][0]["signature"] == "signature-de-test"


def test_le_meme_message_renvoye_apres_une_coupure_n_appelle_pas_claude_deux_fois():
    client = FauxClientAsync(FauxFlux(["Nous avons ", "du bissap", "."]))
    with TestClient(creer_app(client, Conversations())) as http:
        _, premier = envoyer(http, "Vos jus ?", "message-0001")
        conversation = premier[0][1]["conversation"]
        # Le navigateur avait reçu 2 morceaux avant la coupure : il redemande la suite.
        _, reprise = envoyer(http, "Vos jus ?", "message-0001", conversation, depuis=2)
    assert len(client.requetes) == 1
    assert [d for nom, d in reprise if nom == "texte"] == [{"texte": "."}]
    assert reprise[-1][0] == "fin"


def test_une_reponse_a_la_fois_par_conversation():
    conversations = Conversations()
    app = creer_app(FauxClientAsync(), conversations)
    conversation = conversations.creer(charger().identifiant)
    app.state.comptoir.generations["message-en-cours"] = Generation(conversation)  # pas encore terminée
    with TestClient(app) as http:
        r, _ = envoyer(http, "Et le gingembre ?", "message-0002", conversation)
    assert r.status_code == 409


def test_une_conversation_expiree_repart_a_zero(monkeypatch):
    conversations = Conversations()
    ancienne = conversations.creer(charger().identifiant)
    il_y_a_deux_jours = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    conversations._db.execute("UPDATE conversations SET derniere_activite = ?", (il_y_a_deux_jours,))
    client = FauxClientAsync(FauxFlux(["Bonjour !"]))
    with TestClient(creer_app(client, conversations)) as http:
        _, evenements = envoyer(http, "Bonjour", "message-0001", ancienne)
    nom, donnees = evenements[0]
    assert donnees["renouvelee"] == "expiree" and donnees["conversation"] != ancienne
    assert client.requetes[0]["messages"][:-1] == []  # rien de l'ancienne conversation


def test_un_catalogue_modifie_ouvre_une_nouvelle_conversation(monkeypatch):
    conversations = Conversations()
    client = FauxClientAsync(FauxFlux(["Le bissap est à 1 000 FCFA."]), FauxFlux(["Le bissap est à 1 100 FCFA."]))
    with TestClient(creer_app(client, conversations)) as http:
        _, premier = envoyer(http, "Le prix du bissap ?", "message-0001")
        conversation = premier[0][1]["conversation"]
        # Awa change un prix : le prompt système rendu change, son empreinte aussi.
        donnees = charger_donnees()
        donnees["produits"][0]["prix_fcfa"] += 100
        monkeypatch.setattr("comptoir.prompt.charger_donnees", lambda *a, **k: donnees)
        _, second = envoyer(http, "Et maintenant ?", "message-0002", conversation)
    assert second[0][1]["renouvelee"] == "nouveau_prompt"
    assert second[0][1]["conversation"] != conversation
    # L'ancien historique, et ses blocs de réflexion, ne sont pas renvoyés avec le nouveau prompt.
    assert len(client.requetes[1]["messages"]) == 1


def test_une_erreur_est_dite_au_client_et_rien_n_est_range():
    conversations = Conversations()
    refus = anthropic.BadRequestError(
        "Requête invalide",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")),
        body=None,
    )
    client = FauxClientAsync(FauxFlux(["x"], coupure=0, erreur=refus))
    with TestClient(creer_app(client, conversations)) as http:
        _, evenements = envoyer(http, "Bonjour", "message-0001")
    assert evenements[-1] == ("erreur", {"type": "erreur", "message": INDISPONIBLE})
    assert conversations.historique(evenements[0][1]["conversation"]) == []


def test_la_meme_conversation_par_websocket():
    client = FauxClientAsync(FauxFlux(["Nous livrons ", "à Cotonou."]))
    with TestClient(creer_app(client, Conversations())) as http, http.websocket_connect("/ws") as ws:
        ws.send_json({"id_message": "message-0001", "texte": "Livrez-vous à Akpakpa ?"})
        recus = [ws.receive_json() for _ in range(4)]
    assert [e["type"] for e in recus] == ["conversation", "texte", "texte", "fin"]
    assert "".join(e["texte"] for e in recus if e["type"] == "texte") == "Nous livrons à Cotonou."


# --- Chapitre 8 : budget, refus, erreurs ---------------------------------------------------


def test_hors_budget_le_client_est_prevenu_et_claude_n_est_pas_appele(monkeypatch, tmp_path):
    from comptoir.budget import Budget

    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 0.0001)
    client = FauxClientAsync(FauxFlux(["Bonjour !"]))
    with TestClient(creer_app(client, Conversations(), Budget())) as http:
        _, evenements = envoyer(http, "Bonjour", "message-0001")
    assert evenements[-1] == ("erreur", {"type": "erreur", "message": INDISPONIBLE})
    assert client.requetes == []  # le comptage a eu lieu, pas l'appel


def test_un_refus_efface_le_debut_et_n_entre_pas_dans_l_historique():
    from comptoir.erreurs import REFUS
    from faux_clients import message_final

    conversations = Conversations()
    refus = FauxFlux(["Je vais "], message=message_final("Je vais ", stop_reason="refusal"))
    with TestClient(creer_app(FauxClientAsync(refus), conversations)) as http:
        _, evenements = envoyer(http, "Une demande refusée", "message-0001")
    assert evenements[-1] == ("refus", {"type": "refus", "message": REFUS})
    assert conversations.historique(evenements[0][1]["conversation"]) == []


def test_une_erreur_de_l_api_avant_tout_texte_libere_le_budget():
    from comptoir.budget import Budget

    budget = Budget()
    refus = anthropic.BadRequestError(
        "Requête invalide",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")),
        body=None,
    )
    with TestClient(creer_app(FauxClientAsync(FauxFlux(["x"], coupure=0, erreur=refus)), Conversations(), budget)) as http:
        envoyer(http, "Bonjour", "message-0001")
    assert budget.du_jour() == 0
