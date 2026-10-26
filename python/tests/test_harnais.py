"""Le même agent dans deux autres harnais : le Claude Agent SDK et Managed Agents. Aucun appel."""

import asyncio

import pytest

from ch13.avec_agent_sdk import LECTURE, garder, options
from ch13.avec_managed_agents import executer, outils_personnalises, sans_references
from comptoir.agent_reappro import Contexte, Garde, Reglages, creer_outils
from comptoir.atelier import Atelier
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    # Les outils exécutés ici notent leurs étapes dans le journal : jamais dans journal/appels.jsonl.
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def decision(entree: dict) -> str | None:
    sortie = asyncio.run(garder(entree, "toolu_1", None))
    return sortie.get("hookSpecificOutput", {}).get("permissionDecision")


def test_le_hook_reserve_la_lecture_des_messages_au_sous_agent():
    assert decision({"tool_name": LECTURE}) == "deny"                                  # l'agent principal
    assert decision({"tool_name": LECTURE, "agent_id": "a1", "agent_type": "lecteur"}) is None  # le sous-agent
    assert decision({"tool_name": "Bash"}) == "deny"
    assert decision({"tool_name": "Agent"}) is None
    assert decision({"tool_name": "mcp__atelier__lire_stock"}) is None


def test_les_options_du_sdk_n_ouvrent_rien_de_plus(tmp_path):
    ctx = Contexte(None, Atelier(), Garde(), Trace())
    o = options(ctx, 0.60, str(tmp_path))
    assert o.tools == ["Agent"] and o.permission_mode == "dontAsk" and o.setting_sources == []
    assert o.agents["lecteur"].tools == [LECTURE] and o.agents["lecteur"].model == "claude-haiku-5-5"
    assert o.max_budget_usd == 0.60 and o.env["CLAUDE_CONFIG_DIR"].startswith(str(tmp_path))


def test_les_outils_personnalises_ont_un_schema_d_un_seul_bloc():
    outils = creer_outils(Contexte(None, Atelier(), Garde(), Trace()), Reglages())
    proposer = next(o for o in outils_personnalises(outils) if o["name"] == "proposer_bon_de_commande")
    assert proposer["type"] == "custom" and "$defs" not in str(proposer["input_schema"])
    ligne = proposer["input_schema"]["properties"]["lignes"]["items"]
    assert ligne["properties"]["livraison_souhaitee"]["type"] == "string"
    assert sans_references({"type": "object", "properties": {"a": {"type": "string"}}}) == {
        "type": "object", "properties": {"a": {"type": "string"}}}


def test_une_erreur_d_outil_revient_comme_une_erreur():
    outils = {o.name: o for o in creer_outils(Contexte(None, Atelier(), Garde(), Trace()), Reglages())}
    texte, erreur = executer(outils, "calculer_besoins", {"production": {"Jus de baobab": 3}})
    assert erreur and "produits inconnus" in texte
    texte, erreur = executer(outils, "lire_stock", {})
    assert not erreur and "produits_finis" in texte


def test_la_planification_du_lundi_n_appelle_rien_par_defaut():
    from ch13.planifier_lundi import LUNDI_7H, requete
    corps = requete("agent_x", "env_x", 50)
    assert LUNDI_7H == {"type": "cron", "expression": "0 7 * * 1", "timezone": "Africa/Porto-Novo"}
    assert corps["budget"]["max_list_cost"] == {"amount": "50", "currency": "USD"}
    assert corps["initial_events"][0]["type"] == "user.message"
