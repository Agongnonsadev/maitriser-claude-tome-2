"""Chapitre 15 : le serveur MCP « Comptoir pour Awa ». Aucun appel à l'API, aucun réseau, aucun Node."""

import asyncio
import json
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

pytest.importorskip("mcp")  # l'extra [mcp] : pip install -e ".[tests,mcp]"

from mcp import Client, StdioServerParameters

from ch14.fabriquer_commandes import simuler
from ch15 import comptoir_pour_awa as awa
from ch15.construire_extension import REGLAGES, _inventaire, manifeste

T0 = datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def base_modele(tmp_path_factory):
    chemin = tmp_path_factory.mktemp("ch15") / "boutique.sqlite3"
    simuler(chemin)
    return chemin


@pytest.fixture
def base(base_modele, tmp_path, monkeypatch):
    """Une copie neuve de la boutique pour chaque test : les corrections y écrivent."""
    copie = tmp_path / "boutique.sqlite3"
    copie.write_bytes(base_modele.read_bytes())
    monkeypatch.setenv("COMPTOIR_BOUTIQUE", str(copie))
    monkeypatch.setenv("COMPTOIR_AUJOURDHUI", "2026-10-17")
    monkeypatch.setattr(awa, "_maintenant", lambda: T0)
    return copie


def appeler(outil: str, arguments: dict | None = None):
    async def _():
        async with Client(awa.serveur, raise_exceptions=True) as client:
            return await client.call_tool(outil, arguments or {})
    return asyncio.run(_())


def test_le_serveur_annonce_cinq_outils_dont_un_seul_destructeur():
    async def _():
        async with Client(awa.serveur) as client:
            return (await client.list_tools()).tools
    outils = {t.name: t for t in asyncio.run(_())}
    assert set(outils) == {"commandes_du_jour", "stock", "ventes_de_la_semaine", "preparer_correction",
                           "appliquer_correction"}
    destructeurs = [n for n, t in outils.items() if t.annotations.destructive_hint]
    assert destructeurs == ["appliquer_correction"]
    assert outils["appliquer_correction"].meta == {"anthropic/requiresUserInteraction": True}
    assert all(outils[n].annotations.read_only_hint for n in ("commandes_du_jour", "stock", "ventes_de_la_semaine"))
    assert outils["preparer_correction"].annotations.read_only_hint is False  # il écrit un projet, pas le stock


def test_les_commandes_du_jour_sont_celles_de_la_base(base):
    resultat = appeler("commandes_du_jour").structured_content
    with sqlite3.connect(base) as db:
        attendu = db.execute("SELECT COUNT(*), SUM(total) FROM commandes WHERE substr(cree_le, 1, 10) = '2026-10-17'"
                             ).fetchone()
    assert (resultat["nombre"], resultat["total_fcfa"]) == attendu
    assert resultat["resume"] == f"{attendu[0]} commandes le samedi 17 octobre 2026, pour {awa.fcfa(attendu[1])}."
    # Prénom et initiale seulement : assez pour livrer, sans le nom complet.
    assert all(len(c["client"].split()) == 2 and c["client"].endswith(".") for c in resultat["commandes"])


def test_le_stock_signale_la_rupture(base):
    resultat = appeler("stock").structured_content
    corossol = next(p for p in resultat["produits"] if p["produit"] == "Jus de corossol")
    assert corossol["etat"] == "rupture" and "En rupture : Jus de corossol." in resultat["resume"]


def test_les_ventes_de_la_semaine_vont_du_lundi_au_dimanche(base):
    resultat = appeler("ventes_de_la_semaine", {"un_jour_de_la_semaine": "2026-10-14"}).structured_content
    assert (resultat["du"], resultat["au"]) == ("2026-10-12", "2026-10-18")
    bissap = next(p for p in resultat["par_produit"] if p["produit"] == "Jus de bissap")
    assert bissap["quantite"] == 129  # le chiffre vérifié au chapitre 14


def test_une_correction_se_fait_en_deux_temps(base):
    projet = appeler("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": 32}).structured_content
    assert (projet["stock_actuel"], projet["ecart"]) == (40, -8)
    assert "soit 8 de moins" in projet["a_dire_a_awa"]
    with sqlite3.connect(base) as db:
        assert db.execute("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").fetchone() == (40,)  # inchangé
    fait = appeler("appliquer_correction", {"jeton": projet["jeton"]}).structured_content
    assert (fait["avant"], fait["apres"]) == (40, 32)
    with sqlite3.connect(base) as db:
        assert db.execute("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").fetchone() == (32,)
        assert db.execute("SELECT statut FROM corrections_stock").fetchall() == [("appliquee",)]
    # Un jeton ne sert qu'une fois.
    encore = appeler("appliquer_correction", {"jeton": projet["jeton"]})
    assert encore.is_error and "déjà servi" in encore.content[0].text


def test_un_jeton_expire_apres_dix_minutes(base, monkeypatch):
    projet = appeler("preparer_correction", {"produit": "Jus d'ananas", "quantite_comptee": 10}).structured_content
    monkeypatch.setattr(awa, "_maintenant", lambda: T0 + timedelta(minutes=11))
    resultat = appeler("appliquer_correction", {"jeton": projet["jeton"]})
    assert resultat.is_error and "expiré" in resultat.content[0].text
    with sqlite3.connect(base) as db:
        assert db.execute("SELECT quantite FROM stock WHERE produit = 'Jus d''ananas'").fetchone() == (12,)


def test_un_stock_qui_a_bouge_entre_temps_annule_la_correction(base):
    projet = appeler("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": 32}).structured_content
    with sqlite3.connect(base) as db:
        db.execute("UPDATE stock SET quantite = 37 WHERE produit = 'Jus de bissap'")  # une vente pendant ce temps
    resultat = appeler("appliquer_correction", {"jeton": projet["jeton"]})
    assert resultat.is_error and "a changé depuis la préparation (40 → 37" in resultat.content[0].text
    with sqlite3.connect(base) as db:
        assert db.execute("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").fetchone() == (37,)


def test_les_arguments_sont_verifies_avant_le_code(base):
    assert appeler("preparer_correction", {"produit": "Jus de mangue", "quantite_comptee": 3}).is_error
    assert appeler("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": -1}).is_error
    trop = appeler("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": 900})
    assert trop.is_error and "trop pour une correction d'inventaire" in trop.content[0].text


def test_une_base_absente_donne_un_message_qui_dit_quoi_faire(monkeypatch, tmp_path):
    monkeypatch.setenv("COMPTOIR_BOUTIQUE", str(tmp_path / "absente.sqlite3"))
    resultat = appeler("stock")
    assert resultat.is_error and "Vérifiez le réglage « Base de la boutique »" in resultat.content[0].text


def test_ressources_et_prompts(base):
    async def _():
        async with Client(awa.serveur, raise_exceptions=True) as client:
            catalogue = (await client.read_resource("comptoir://catalogue")).contents[0].text
            commande = (await client.read_resource("comptoir://commande/C-0042")).contents[0].text
            modeles = [t.uri_template for t in (await client.list_resource_templates()).resource_templates]
            bilan = await client.get_prompt("bilan_du_soir", {"jour": "samedi 17 octobre"})
            return catalogue, commande, modeles, bilan
    catalogue, commande, modeles, bilan = asyncio.run(_())
    assert "- Jus de bissap (bouteille de 50 cl) : 1 000 FCFA" in catalogue
    assert commande.startswith("# Commande C-0042") and modeles == ["comptoir://commande/{numero}"]
    texte = bilan.messages[0].content.text
    assert bilan.messages[0].role == "user" and "du samedi 17 octobre" in texte and "Ne modifie rien" in texte


def test_le_serveur_demarre_en_stdio_et_n_ecrit_rien_sur_la_sortie_standard(base):
    # Le client lit la sortie standard comme du JSON-RPC : un print() la casserait.
    parametres = StdioServerParameters(command=sys.executable, args=[awa.__file__],
                                       env={"COMPTOIR_BOUTIQUE": str(base), "COMPTOIR_AUJOURDHUI": "2026-10-17"})

    async def _():
        async with Client(parametres, read_timeout_seconds=60) as client:
            return client.protocol_version, (await client.call_tool("stock", {})).structured_content["resume"]
    version, resume = asyncio.run(_())
    assert version == "2026-07-28" and resume.startswith("En rupture")


def test_le_manifeste_annonce_exactement_ce_que_le_serveur_expose():
    outils, prompts = asyncio.run(_inventaire())
    m = manifeste(outils, prompts)
    assert m["manifest_version"] == "0.4" and m["server"]["type"] == "uv"
    assert [o["name"] for o in m["tools"]] == ["commandes_du_jour", "stock", "ventes_de_la_semaine",
                                                "preparer_correction", "appliquer_correction"]
    bilan = next(p for p in m["prompts"] if p["name"] == "bilan_du_soir")
    assert bilan["arguments"] == ["jour"] and "${arguments.jour}" in bilan["text"]
    # Chaque réglage est transmis au serveur, et seulement par l'environnement.
    assert m["server"]["mcp_config"]["env"] == {"COMPTOIR_BOUTIQUE": "${user_config.base_boutique}"}
    assert set(m["user_config"]) == set(REGLAGES)


def test_mise_en_forme_pour_awa():
    assert awa.fcfa(329500) == "329 500 FCFA"
    assert awa.jour_en_toutes_lettres(date(2026, 11, 1)) == "dimanche 1er novembre 2026"
    assert awa.client_discret("Larissa Noudéhou") == "Larissa N."
