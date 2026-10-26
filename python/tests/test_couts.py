"""Tests du calculateur de coût, sans aucun appel à l'API."""

import pytest
from anthropic.types import CacheCreation, Usage

from comptoir.couts import cout


def test_exemple_du_livre_sonnet():
    # Chapitre 1 : 2 000 tokens d'entrée et 300 de sortie sur Sonnet 5.5 = 0,007 $.
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cout("claude-sonnet-5-5", usage).dollars == pytest.approx(0.007)


def test_conversion_fcfa_et_euros():
    prix = cout("claude-sonnet-5-5", Usage(input_tokens=1_000_000, output_tokens=0))
    assert prix.dollars == pytest.approx(2.0)
    assert prix.fcfa == pytest.approx(1140.0)
    assert prix.euros == pytest.approx(1.74)


def test_affichage_en_francais():
    prix = cout("claude-sonnet-5-5", Usage(input_tokens=2000, output_tokens=300))
    assert str(prix) == "0,0070 $ (≈ 4,0 FCFA ; 0,0061 €)"


def test_accepte_un_dictionnaire_venu_du_json():
    usage = {"input_tokens": 2000, "output_tokens": 300, "cache_read_input_tokens": None}
    assert cout("claude-sonnet-5-5", usage).dollars == pytest.approx(0.007)


def test_cache_lecture_et_ecritures():
    usage = Usage(
        input_tokens=50,
        output_tokens=100,
        cache_read_input_tokens=10_000,
        cache_creation_input_tokens=3_000,
        cache_creation=CacheCreation(ephemeral_5m_input_tokens=2_000, ephemeral_1h_input_tokens=1_000),
    )
    attendu = (50 * 2 + 100 * 10 + 10_000 * 0.10 + 2_000 * 2.50 + 1_000 * 4.00) / 1_000_000
    assert cout("claude-sonnet-5-5", usage).dollars == pytest.approx(attendu)


def test_ecriture_sans_detail_comptee_en_cinq_minutes():
    usage = Usage(input_tokens=0, output_tokens=0, cache_creation_input_tokens=1_000_000)
    assert cout("claude-opus-5-5", usage).dollars == pytest.approx(5.0)


def test_haiku_change_de_tarif_au_dela_de_100_000_tokens():
    court = Usage(input_tokens=100_000, output_tokens=1_000)
    long = Usage(input_tokens=100_001, output_tokens=1_000)
    assert cout("claude-haiku-5-5", court).dollars == pytest.approx((100_000 * 0.10 + 1_000 * 0.50) / 1e6)
    assert cout("claude-haiku-5-5", long).dollars == pytest.approx((100_001 * 0.50 + 1_000 * 2.50) / 1e6)


def test_le_cache_compte_dans_la_longueur_du_prompt_de_haiku():
    # 1 000 tokens hors cache + 150 000 lus dans le cache : le prompt dépasse 100 000 tokens.
    usage = Usage(input_tokens=1_000, output_tokens=0, cache_read_input_tokens=150_000)
    assert cout("claude-haiku-5-5", usage).dollars == pytest.approx((1_000 * 0.50 + 150_000 * 0.05) / 1e6)


def test_modele_inconnu():
    with pytest.raises(ValueError):
        cout("claude-modele-imaginaire", Usage(input_tokens=1, output_tokens=1))


# Chapitre 4 : la remise de la Batch API, ajoutée avec Claude Code puis relue.

def test_lot_divise_l_exemple_du_livre_par_deux():
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cout("claude-sonnet-5-5", usage, lot=True).dollars == pytest.approx(0.0035)


def test_lot_se_cumule_avec_le_cache():
    usage = Usage(
        input_tokens=50,
        output_tokens=100,
        cache_read_input_tokens=10_000,
        cache_creation_input_tokens=3_000,
        cache_creation=CacheCreation(ephemeral_5m_input_tokens=2_000, ephemeral_1h_input_tokens=1_000),
    )
    attendu = (50 * 2 + 100 * 10 + 10_000 * 0.10 + 2_000 * 2.50 + 1_000 * 4.00) / 1_000_000
    assert cout("claude-sonnet-5-5", usage, lot=True).dollars == pytest.approx(attendu * 0.5)


def test_lot_et_long_prompt_de_haiku():
    # Le seuil de 100 000 tokens se calcule sur les tokens bruts, avant la remise.
    long = Usage(input_tokens=100_001, output_tokens=1_000)
    attendu = (100_001 * 0.50 + 1_000 * 2.50) / 1e6 * 0.5
    assert cout("claude-haiku-5-5", long, lot=True).dollars == pytest.approx(attendu)


def test_lot_faux_par_defaut():
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cout("claude-sonnet-5-5", usage) == cout("claude-sonnet-5-5", usage, lot=False)


def test_lot_conserve_les_compteurs_de_tokens():
    usage = Usage(input_tokens=2000, output_tokens=300, cache_read_input_tokens=500)
    normal = cout("claude-sonnet-5-5", usage)
    par_lot = cout("claude-sonnet-5-5", usage, lot=True)
    assert (par_lot.entree, par_lot.lecture_cache, par_lot.sortie) == (normal.entree, normal.lecture_cache, normal.sortie)
