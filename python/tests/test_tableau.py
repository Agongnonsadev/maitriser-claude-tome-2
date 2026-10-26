"""Le tableau de bord lit le journal : coûts par jour, modes d'échec, latences, conversations à reprendre."""

import json

from comptoir.tableau import a_reprendre, centile, charger, en_html, latences, modes_d_echec, par_jour

JOURNAL = [
    {"date": "2026-10-20T08:00:00+00:00", "requete": "r1", "cout_dollars": 0.004, "tokens_entree": 1000,
     "tokens_sortie": 100, "stop_reason": "end_turn", "duree_ms": 900, "client": "c1"},
    {"date": "2026-10-20T08:05:00+00:00", "requete": "r2", "cout_dollars": 0.006, "tokens_entree": 1500,
     "tokens_sortie": 150, "stop_reason": "end_turn", "duree_ms": 1500, "client": "c1"},
    {"date": "2026-10-20T09:00:00+00:00", "requete": None, "cout_dollars": None, "interrompu": True,
     "erreur": "surcharge", "origine": "service", "duree_ms": 30000, "client": "c2"},
    {"date": "2026-10-20T10:00:00+00:00", "requete": "r4", "cout_dollars": 0.001, "stop_reason": "refusal",
     "erreur": "refus", "origine": "modele", "client": "c3"},
    {"date": "2026-10-21T07:00:00+00:00", "evenement": "hors_budget", "motif": "quota_client", "client": "c4"},
]


def test_les_couts_par_jour():
    jours = par_jour(JOURNAL)
    assert jours["2026-10-20"]["appels"] == 4 and round(jours["2026-10-20"]["dollars"], 6) == 0.011
    assert jours["2026-10-20"]["echecs"] == 2 and jours["2026-10-21"]["echecs"] == 1


def test_les_modes_d_echec_par_origine():
    assert modes_d_echec(JOURNAL) == {("service", "surcharge"): 1, ("modele", "refus"): 1, ("compte", "hors_budget"): 1}


def test_les_latences_ignorent_les_echecs():
    assert latences(JOURNAL) == (900, 1500)  # l'appel en surcharge (30 s) n'est pas compté
    assert centile([], 50) is None


def test_les_conversations_a_reprendre():
    # Une surcharge se réessaie ; un refus ou un budget épuisé laissent le client sans réponse.
    assert [r["conversation"] for r in a_reprendre(JOURNAL)] == ["c3", "c4"]


def test_la_page_html_echappe_le_contenu_du_journal(tmp_path):
    chemin = tmp_path / "appels.jsonl"
    piege = {"date": "2026-10-20T11:00:00+00:00", "evenement": "hors_budget", "client": "<script>x</script>"}
    chemin.write_text("\n".join(json.dumps(l) for l in JOURNAL + [piege]) + "\n", encoding="utf-8")
    page = en_html(charger(str(chemin)))
    assert "<script>x</script>" not in page and "&lt;script&gt;" in page
