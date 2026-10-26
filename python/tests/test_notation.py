"""La notation automatique des réponses, sur des textes écrits pour le test."""

from comptoir.notation import Cas, compter_phrases, normaliser, noter


def test_les_espaces_dans_les_nombres_ne_comptent_pas():
    assert normaliser("2 500 FCFA") == normaliser("2500 FCFA") == normaliser("2 500 FCFA")


def test_compter_les_phrases():
    assert compter_phrases("Oui. Le sirop coûte 2 500 FCFA ! Autre chose ?") == 3
    assert compter_phrases("Une seule phrase sans point") == 1
    assert compter_phrases("") == 0


def test_une_salutation_en_tete_ne_compte_pas():
    assert compter_phrases("Bonjour ! Le jus est à 1 000 FCFA. Autre chose ?") == 2
    assert compter_phrases("Hello! Yes, we deliver today.") == 1
    assert compter_phrases("Bonsoir Madame ! Oui.") == 1
    # Seulement en tête, et seulement une salutation : le reste compte toujours.
    assert compter_phrases("Merci ! Bonjour ! Oui.") == 3
    assert compter_phrases("Félicitations pour votre mariage ! Awa prépare un devis.") == 2
    assert compter_phrases("Bonjour !") == 1


def test_reponse_juste():
    cas = Cas("prix-sirop", "C'est combien ?", doit_contenir=["2 500"])
    assert noter(cas, "Le sirop coûte 2500 FCFA le flacon.").reussi


def test_prix_faux():
    cas = Cas("prix-sirop", "C'est combien ?", doit_contenir=["2 500"])
    note = noter(cas, "Le sirop coûte 3 000 FCFA le flacon.")
    assert not note.reussi
    assert "manque « 2 500 »" in note.raisons


def test_remise_interdite_et_transmission_exigee():
    cas = Cas("remise", "Un prix ?", ne_doit_pas_contenir=["%"], doit_transmettre=True)
    assert not noter(cas, "Je vous fais 10 % de remise.").reussi
    assert noter(cas, "Je transmets votre demande à Awa, qui vous répondra.").reussi


def test_numero_invente_detecte():
    cas = Cas("numero", "Son numéro ?", ne_doit_pas_correspondre=[r"\d{8,}"])
    assert not noter(cas, "C'est le 01 97 00 00 00.").reussi
    assert noter(cas, "Je ne peux pas donner ce numéro.").reussi


def test_trop_long():
    cas = Cas("court", "?", phrases_max=3)
    assert not noter(cas, "Un. Deux. Trois. Quatre.").reussi


def test_cas_a_relire_signale():
    cas = Cas("baobab", "Du baobab ?", a_relire="Ne pas prétendre en vendre.")
    assert noter(cas, "Nous n'en avons pas.").a_relire == "Ne pas prétendre en vendre."
