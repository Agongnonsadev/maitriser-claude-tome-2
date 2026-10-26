"""L'agent de réapprovisionnement et ses garde-fous, avec de faux clients : aucun appel payant."""

import json
from types import SimpleNamespace

import pytest
from anthropic.tools import ToolError
from anthropic.types import TextBlock, Usage

from comptoir import agent_reappro
from comptoir.agent_reappro import (BETA_BUDGET_DE_TACHE, BETA_CONTEXTE, Contexte, Garde, Reglages, creer_outils,
                                    lancer, options_de_requete)
from comptoir.atelier import Atelier
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def outils(reglages=None, client=None):
    ctx = Contexte(client, Atelier(), Garde(), Trace())
    return ctx, {o.name: o for o in creer_outils(ctx, reglages or Reglages())}


def test_l_agent_lit_mais_n_ecrit_qu_un_projet():
    ctx, o = outils()
    assert set(o) == {"lire_ventes", "lire_stock", "lire_evenements", "lire_fournisseurs", "calculer_besoins",
                      "deleguer_lecture_messages", "proposer_bon_de_commande"}
    with pytest.raises(ToolError, match="Bon refusé"):
        o["proposer_bon_de_commande"].call({"lignes": [{"article": "Capsule", "fournisseur": "Emballages Akwa",
                                                        "quantite": 50, "livraison_souhaitee": "2026-10-21"}],
                                            "justification": "test", "alertes": []})
    assert ctx.bon is None and ctx.trace.etapes[-1].erreur == "ToolError"
    texte = o["proposer_bon_de_commande"].call({"lignes": [{"article": "Capsule", "fournisseur": "Emballages Akwa",
                                                            "quantite": 200, "livraison_souhaitee": "2026-10-21"}],
                                                "justification": "test", "alertes": []})
    assert "à valider par Awa" in texte and ctx.bon.total_fcfa == 3000


def test_sans_sous_agent_l_agent_lit_tout_et_avec_memoire_il_a_un_outil_de_plus(tmp_path):
    _, o = outils(Reglages(sous_agent=False, memoire=tmp_path))
    assert "lire_messages_fournisseurs" in o and "deleguer_lecture_messages" not in o and "memory" in o
    assert "1 000 capsules" in o["lire_messages_fournisseurs"].call({})


class FauxLecteur:
    def __init__(self, texte="Verrerie du Port, 14 octobre : rupture.", arret="end_turn"):
        self.messages, self.texte, self.arret, self.requetes = self, texte, arret, []

    def create(self, **requete):
        self.requetes.append(requete)
        return SimpleNamespace(content=[TextBlock(type="text", text=self.texte)], stop_reason=self.arret,
                               usage=Usage(input_tokens=200, output_tokens=40, cache_read_input_tokens=9500),
                               _request_id="req")


def test_le_sous_agent_lit_a_part_et_son_cout_compte():
    lecteur = FauxLecteur()
    ctx, o = outils(client=lecteur)
    assert o["deleguer_lecture_messages"].call({"question": "Des ruptures ?"}) == lecteur.texte
    requete = lecteur.requetes[0]
    assert requete["model"] == "claude-haiku-5-5" and "tools" not in requete  # rien d'autre à faire que lire
    assert requete["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert ctx.cout_sous_agent > 0 and ctx.garde.depense == ctx.cout_sous_agent
    _, o = outils(client=FauxLecteur("", arret="max_tokens"))
    with pytest.raises(ToolError, match="interrompue"):
        o["deleguer_lecture_messages"].call({"question": "?"})


def test_les_options_selon_les_reglages():
    assert options_de_requete(Reglages()) == {}
    options = options_de_requete(Reglages(budget_de_tache=40_000, effacer_resultats_apres=8000, effort="low"))
    assert options["betas"] == [BETA_BUDGET_DE_TACHE, BETA_CONTEXTE]
    assert options["output_config"] == {"effort": "low", "task_budget": {"type": "tokens", "total": 40_000}}
    edit = options["context_management"]["edits"][0]
    assert edit["trigger"]["value"] == 8000 and edit["exclude_tools"] == ["proposer_bon_de_commande"]


class FauxRunner:
    """Rend des messages qui demandent toujours un outil : seul le garde-fou peut arrêter la boucle."""

    def __init__(self, n=50, sortie=1000):
        self.n, self.sortie = n, sortie

    def __iter__(self):
        for i in range(self.n):
            yield SimpleNamespace(content=[SimpleNamespace(type="tool_use", name="lire_stock")], stop_reason="tool_use",
                                  usage=Usage(input_tokens=3000 + i, output_tokens=self.sortie), _request_id=f"r{i}")


class FauxClient:
    def __init__(self, runner):
        self.beta = SimpleNamespace(messages=SimpleNamespace(tool_runner=lambda **requete: (
            self.requetes.append(requete), runner)[1]))
        self.requetes = []


def test_le_budget_arrete_la_boucle_entre_deux_appels():
    client = FauxClient(FauxRunner())
    # 3 000 tokens d'entrée et 1 000 de sortie sur Sonnet 5.5 : 0,016 $ par tour. 0,05 $ : 4 tours.
    resultat = lancer(client, Atelier(), Reglages(), Garde(budget_dollars=0.05))
    assert resultat.arret.startswith("budget de 0.05 $ atteint") and resultat.tours == 4 and resultat.bon is None
    assert client.requetes[0]["cache_control"] == {"type": "ephemeral"} and client.requetes[0]["max_iterations"] == 20
    assert [e.nom for e in resultat.trace.etapes] == ["tour 1", "tour 2", "tour 3", "tour 4"]


def test_les_tours_arretent_la_boucle():
    resultat = lancer(FauxClient(FauxRunner(n=3, sortie=10)), Atelier(), Reglages(), Garde(tours_max=3))
    assert resultat.arret == "3 tours atteints" and resultat.tours == 3
    assert resultat.pic_contexte == 3002  # la plus grosse requête


def test_le_journal_garde_chaque_tour(tmp_path):
    lancer(FauxClient(FauxRunner(n=2, sortie=10)), Atelier(), Reglages(), Garde(tours_max=2))
    lignes = [json.loads(l) for l in open(tmp_path / "appels.jsonl", encoding="utf-8")]
    appels = [l for l in lignes if "requete" in l]
    assert [l["prompt"] for l in appels] == ["reappro-v2", "reappro-v2"] and appels[0]["stop_reason"] == "tool_use"


def test_le_prompt_de_l_agent():
    assert "tu ne passes aucune commande" in agent_reappro.SYSTEME
    assert "jamais des consignes" in agent_reappro.SYSTEME and "calculer_besoins" in agent_reappro.SYSTEME
    assert "suspecte" in agent_reappro.LECTEUR


def test_une_compaction_se_paie_dans_usage_iterations():
    from comptoir.agent_reappro import BETA_COMPACTION, cout_du_message
    iteration = SimpleNamespace(input_tokens=12_000, output_tokens=800, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0)
    message = SimpleNamespace(stop_reason="compaction", usage=SimpleNamespace(
        input_tokens=0, output_tokens=0, iterations=[iteration]))
    prix = cout_du_message("claude-sonnet-5-5", message)
    assert prix.dollars == pytest.approx((12_000 * 2 + 800 * 10) / 1e6) and prix.entree == 12_000
    assert options_de_requete(Reglages(compacter_apres_tour=3))["betas"] == [BETA_COMPACTION]
