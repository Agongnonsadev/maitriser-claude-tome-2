"""Le budget : réserver le maximum, régler le réel, ne jamais dépasser un plafond."""

from datetime import datetime, timezone

import pytest

from comptoir.budget import Budget
from comptoir.couts import cout_maximal


@pytest.fixture(autouse=True)
def plafonds(monkeypatch):
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 0.15)
    monkeypatch.setattr("comptoir.config.BUDGET_JOUR", 1.30)
    monkeypatch.setattr("comptoir.config.BUDGET_MOIS", 26.0)
    monkeypatch.setattr("comptoir.config.SEUIL_ALERTE", 0.8)


class Horloge:
    def __init__(self, instant):
        self.instant = instant

    def __call__(self):
        return self.instant


def test_le_cout_maximal_d_un_appel():
    # 3 000 tokens d'entrée et 2 000 de sortie au plus, au prix de Sonnet 5.5 (2 $ et 10 $ le million).
    assert cout_maximal("claude-sonnet-5-5", 3000, 2000) == pytest.approx(0.026)


def test_reserver_puis_regler_le_cout_reel():
    budget = Budget()
    decision = budget.reserver("c1", 0.026)
    assert decision.accepte and budget.du_jour() == pytest.approx(0.026)
    budget.regler(decision.reservation, 0.004)
    assert budget.du_jour() == pytest.approx(0.004) and budget.du_client("c1") == pytest.approx(0.004)


def test_le_quota_d_un_client_ne_bloque_pas_les_autres():
    budget = Budget()
    for _ in range(5):
        budget.regler(budget.reserver("bavard", 0.026).reservation, 0.026)
    decision = budget.reserver("bavard", 0.026)
    assert not decision.accepte and decision.motif == "quota_client"
    assert budget.reserver("autre", 0.026).accepte


def test_les_appels_en_cours_comptent():
    # Dix appels lancés ensemble ne peuvent pas dépasser le plafond à eux dix.
    budget = Budget()
    acceptes = [budget.reserver(f"client-{i}", 0.14).accepte for i in range(10)]
    assert acceptes.count(True) == 9  # 9 × 0,14 = 1,26 $ ; le dixième dépasserait 1,30 $


def test_liberer_une_reservation():
    budget = Budget()
    budget.liberer(budget.reserver("c1", 0.10).reservation)
    assert budget.du_jour() == 0


def test_l_alerte_avant_le_plafond():
    budget = Budget()
    assert not budget.reserver("c1", 0.10).alerte
    for i in range(8):
        budget.reserver(f"c{i + 2}", 0.13)
    assert budget.en_alerte()  # 1,14 $ engagés sur 1,30 $ : plus de 80 %


def test_un_nouveau_jour_repart_de_zero_mais_pas_le_mois(monkeypatch):
    monkeypatch.setattr("comptoir.config.BUDGET_MOIS", 1.50)
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 2.0)
    horloge = Horloge(datetime(2026, 10, 20, 23, 0, tzinfo=timezone.utc))
    budget = Budget(horloge=horloge)
    budget.reserver("c1", 0.10)
    budget.regler(budget.reserver("c2", 1.10).reservation, 1.10)
    horloge.instant = datetime(2026, 10, 21, 0, 30, tzinfo=timezone.utc)
    assert budget.du_jour() == 0 and budget.du_mois() == pytest.approx(1.20)
    decision = budget.reserver("c3", 0.40)
    assert not decision.accepte and decision.motif == "budget_mois"
