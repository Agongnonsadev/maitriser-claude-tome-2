"""La base d'Awa : découpage, identifiants stables, blocs search_result et point de cache."""

import json
from pathlib import Path

from comptoir.connaissances import ancre, avec_contextes, bloc_resultat, blocs_resultats, charger_base, decouper

DOCUMENT = """# Questions fréquentes

Document fictif.

## Êtes-vous ouverts le dimanche ?

Non. Le dimanche, l'atelier est fermé.

## Comment payer ?

Par Mobile Money.

En espèces aussi.
"""


def test_l_ancre_d_un_titre():
    assert ancre("Êtes-vous ouverts le dimanche ?") == "etes-vous-ouverts-le-dimanche"
    assert ancre("Quand parler d'événement ?") == "quand-parler-d-evenement"


def test_une_section_par_morceau():
    morceaux = decouper(DOCUMENT, "faq")
    assert [m.identifiant for m in morceaux] == ["kb://faq#etes-vous-ouverts-le-dimanche", "kb://faq#comment-payer"]
    assert morceaux[0].titre == "Questions fréquentes — Êtes-vous ouverts le dimanche ?"
    assert morceaux[1].texte == "Par Mobile Money.\n\nEn espèces aussi."


def test_une_section_trop_longue_est_coupee_avec_recouvrement():
    paragraphes = [f"Paragraphe {i} " + "x" * 80 for i in range(6)]
    morceaux = decouper("# Doc\n\n## Longue\n\n" + "\n\n".join(paragraphes), "doc", taille_max=250)
    assert len(morceaux) > 1
    assert morceaux[0].identifiant == "kb://doc#longue-1"
    # Chaque partie reprend le dernier paragraphe de la précédente.
    for avant, apres in zip(morceaux, morceaux[1:]):
        assert apres.texte.startswith(avant.texte.split("\n\n")[-1])


def test_la_base_d_awa():
    base = charger_base()
    identifiants = [m.identifiant for m in base]
    assert len(base) == 41 and len(set(identifiants)) == 41
    assert identifiants == [m.identifiant for m in charger_base()]  # ordre stable, condition du cache
    assert "kb://zones-de-livraison#hors-de-cotonou" in identifiants


def test_les_sources_attendues_des_questions_existent():
    questions = json.loads((Path(__file__).parents[1] / "ch11" / "questions.json").read_text(encoding="utf-8"))
    identifiants = {m.identifiant for m in charger_base()}
    attendues = {s for q in questions for s in q.get("sources", [])}
    assert attendues <= identifiants, attendues - identifiants


def test_un_bloc_search_result():
    morceau = decouper(DOCUMENT, "faq")[1]
    bloc = bloc_resultat(morceau)
    assert bloc["type"] == "search_result" and bloc["source"] == "kb://faq#comment-payer"
    assert bloc["citations"] == {"enabled": True}
    assert bloc["content"] == [{"type": "text", "text": "Par Mobile Money."}, {"type": "text", "text": "En espèces aussi."}]
    assert "cache_control" not in bloc


def test_le_point_de_cache_est_sur_le_dernier_bloc_seulement():
    blocs = blocs_resultats(decouper(DOCUMENT, "faq"), cache=True)
    assert [("cache_control" in b) for b in blocs] == [False, True]
    assert all("cache_control" not in b for b in blocs_resultats(decouper(DOCUMENT, "faq")))


def test_les_contextes_s_ajoutent_a_la_recherche():
    morceau = decouper(DOCUMENT, "faq")[0]
    situe = avec_contextes([morceau], {morceau.identifiant: "Horaires de la boutique."})[0]
    assert situe.pour_la_recherche().startswith("Horaires de la boutique.")
    assert bloc_resultat(situe)["content"] == bloc_resultat(morceau)["content"]  # Claude lit le texte, pas le contexte
