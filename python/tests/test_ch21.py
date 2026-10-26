"""Chapitre 21 : la veille des modèles et du SDK, l'estimation d'un projet. Aucun appel à l'API."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from ch18 import donnees
from ch21 import veille
from comptoir import whatsapp
from comptoir.boutique import Boutique
from comptoir.conversations import Conversations

MAINTENANT = datetime(2026, 10, 22, tzinfo=timezone.utc)
# Trois lignes du tableau « Model status » de la page des retraits, telles que lues le 22 octobre 2026.
PAGE = """| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-sonnet-5-5          | Active        | N/A                | Not sooner than September 28, 2027 |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |
| claude-haiku-4-5-20251001  | Active        | N/A                | Not sooner than October 15, 2026   |
"""


def modele(identifiant, cycle="active", retrait=None):
    return SimpleNamespace(id=identifiant, lifecycle=cycle, retires_at=retrait)


def test_la_page_des_retraits_se_lit_en_etats_et_en_dates():
    etats = veille.etats_publies(PAGE)
    assert etats["claude-sonnet-4-5-20250929"].etat == "Deprecated"
    assert etats["claude-sonnet-4-5-20250929"].retrait == datetime(2026, 11, 30, tzinfo=timezone.utc)
    assert etats["claude-sonnet-5-5"].au_plus_tot and not etats["claude-sonnet-4-5-20250929"].au_plus_tot


def test_un_modele_deprecie_sur_la_page_alerte_meme_si_l_api_le_dit_actif():
    """Constaté le 22 octobre 2026 : l'API Models disait « active » pour Claude Sonnet 4.5."""
    catalogue = {"claude-sonnet-4-5-20250929": modele("claude-sonnet-4-5-20250929")}
    rapport = veille.examiner_modeles(catalogue, veille.etats_publies(PAGE), {"MODELE": "claude-sonnet-4-5-20250929"},
                                      120, MAINTENANT)
    assert any("Deprecated" in a and "2026-11-30" in a for a in rapport.alertes)
    assert any("la page fait foi" in a for a in rapport.alertes)


def test_un_modele_actif_donne_sa_date_plancher_et_aucun_alias_n_echappe():
    catalogue = {"claude-sonnet-5-5": modele("claude-sonnet-5-5"),
                 "claude-haiku-4-5-20251001": modele("claude-haiku-4-5-20251001")}
    rapport = veille.examiner_modeles(catalogue, veille.etats_publies(PAGE),
                                      {"MODELE": "claude-sonnet-5-5", "MODELE_ROUTEUR": "claude-haiku-4-5"}, 120, MAINTENANT)
    assert rapport.alertes == []
    assert any("pas avant le 2027-09-28" in i for i in rapport.infos)
    assert any(i.startswith("claude-haiku-4-5 ") for i in rapport.infos)  # l'alias trouve la version datée


def test_un_retrait_proche_ou_un_modele_absent_alerte():
    proche = modele("claude-x-1", retrait=datetime(2026, 12, 1, tzinfo=timezone.utc))
    rapport = veille.examiner_modeles({"claude-x-1": proche}, {}, {"A": "claude-x-1", "B": "claude-disparu-1"}, 120, MAINTENANT)
    assert any("retrait le 2026-12-01, dans 40 jours" in a for a in rapport.alertes)
    assert any("claude-disparu-1" in a and "absent" in a for a in rapport.alertes)
    assert veille.examiner_modeles({}, None, {}, 120, MAINTENANT).alertes == [
        "Page des retraits injoignable : seule l'API Models a été lue"]


def test_une_version_majeure_de_plus_du_sdk_alerte():
    assert veille.examiner_sdk("1.15.0", "2.1.0", "2023-06-01").alertes
    mineure = veille.examiner_sdk("2.0.0", "2.1.0", "2026-10-21")
    assert not mineure.alertes and "même version majeure" in mineure.infos[0]
    assert "à jour" in veille.examiner_sdk("2.1.0", "2.1.0", "2026-10-21").infos[0]
    assert veille.examiner_sdk("2.1.0", None, "2026-10-21").alertes


def test_les_modeles_ecrits_dans_le_depot_sont_inventories(tmp_path):
    (tmp_path / "comptoir").mkdir()
    (tmp_path / "comptoir" / "appel.py").write_text('MODELE = "claude-sonnet-4-5-20250929"\n', encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text('"claude-haiku-4-5"\n', encoding="utf-8")  # les tests ne comptent pas
    assert veille.modeles_du_depot(tmp_path) == {"claude-sonnet-4-5-20250929": {"comptoir/appel.py"}}


# --- L'effacement à la demande, avec WhatsApp ---------------------------------------------------------

def test_effacer_une_conversation_efface_aussi_le_numero_whatsapp(monkeypatch, tmp_path):
    """Trouvé en écrivant la procédure d'exploitation : le numéro restait dans l'annuaire du chapitre 19."""
    monkeypatch.setattr("comptoir.config.SEL_PSEUDONYMES", "sel-de-test")
    boutique, conversations, annuaire = Boutique(), Conversations(), whatsapp.Annuaire()
    conversation = conversations.creer("systeme-v5")
    annuaire.lier(whatsapp.pseudonyme("22997000000", "sel-de-test"), "22997000000", conversation)
    resultat = donnees.effacer_numero(boutique, conversations, annuaire, "22997000000")
    assert resultat["conversation_trouvee"] and resultat["conversation_effacee"] and resultat["numero_efface"]
    assert annuaire.conversation(whatsapp.pseudonyme("22997000000", "sel-de-test")) is None
    assert donnees.effacer_numero(boutique, conversations, annuaire, "22997000000") == {"conversation_trouvee": False}


def test_la_purge_quotidienne_oublie_aussi_les_numeros_anciens():
    assert donnees.purger(Boutique(), Conversations(), whatsapp.Annuaire())["clients_whatsapp_oublies"] == 0


# --- L'estimation d'un projet, et le job de veille ---------------------------------------------------

def test_l_estimation_part_des_prix_mesures_et_compte_les_messages_gratuits():
    from ch21 import estimer_projet as ep
    e = ep.estimer(1500, whatsapp=True, hebergement=7.0)
    assert e.claude == pytest.approx(1500 * 0.00075) and e.claude_avec_marge == pytest.approx(1500 * 0.00075 * 1.5)
    assert e.whatsapp == pytest.approx(500 * 0.0040)            # 1 000 messages de service gratuits par mois
    assert e.total == pytest.approx(1.6875 + 2.0 + 7.0)
    assert ep.estimer(800, whatsapp=True).whatsapp == 0.0
    sans_hebergement = ep.estimer(1500)
    assert sans_hebergement.total is None and "[à mesurer]" in ep.en_texte(sans_hebergement, 1500)


def test_le_job_de_veille_est_planifie_sans_cle():
    from pathlib import Path
    texte = (Path(__file__).resolve().parents[2] / ".github/workflows/veille.yml").read_text(encoding="utf-8")
    assert "secrets." not in texte and "id-token: write" in texte and "cron:" in texte
    assert "python -m ch21.veille" in texte and "timeout-minutes:" in texte
