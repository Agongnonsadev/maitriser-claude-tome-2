"""La suite d'évaluation du chapitre 17, avec de faux clients : aucun appel payant."""

import argparse
import json
import re
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, ToolUseBlock, Usage

from ch17 import banc, comparer, etalonnage, evaluer, generer_cas, juge, suite
from ch17.banc import Essai, Variante, essayer
from ch17.notation_code import noter
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes
from comptoir.connaissances import charger_base

CAS = {c["id"]: c for c in suite.charger_cas()}


@pytest.fixture(autouse=True)
def reglages(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 1.0)
    monkeypatch.setattr(suite, "REGISTRE", tmp_path / "registre.jsonl")
    monkeypatch.setattr(suite, "SERIES", tmp_path / "series")
    monkeypatch.setattr(evaluer, "SERIES", tmp_path / "series")
    monkeypatch.setattr(evaluer, "REGISTRE", tmp_path / "registre.jsonl")


def message(*blocs, arret="end_turn"):
    return SimpleNamespace(content=list(blocs), stop_reason=arret, stop_details=None,
                           usage=Usage(input_tokens=800, output_tokens=80), _request_id="req")


def texte(t, arret="end_turn"):
    return message(TextBlock(type="text", text=t), arret=arret)


class FauxClient:
    def __init__(self, *reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []

    def create(self, **requete):
        self.requetes.append(requete)
        reponse = self.reponses.pop(0)
        if isinstance(reponse, Exception):
            raise reponse
        return reponse

    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=800)


def routage(categorie):
    return texte(json.dumps({"categorie": categorie, "raison": "test"}))


# --- Le jeu de cas ------------------------------------------------------------------------

def test_les_soixante_cas_sont_bien_formes():
    cas = list(CAS.values())
    assert len(cas) == 60 == len(CAS)  # identifiants uniques
    assert sum(c["jeu"] == "amelioration" for c in cas) == 40 and sum(c["jeu"] == "verification" for c in cas) == 20
    for jeu in ("amelioration", "verification"):
        types = {c["type"] for c in cas if c["jeu"] == jeu}
        assert types == {"courant", "piege", "securite"}  # chaque jeu a les trois sortes de cas
    for c in cas:
        assert c["reference"] and c["message"] and c["origine"]
        assert set(c["categorie"]) <= {"information", "commande", "reclamation", "autre"}
        assert set(c.get("etat", {})) <= {"transmis", "motif", "recapitulatif", "total"}
        for motif in c.get("ne_doit_pas_correspondre", []):
            re.compile(motif)
    # Un jeu équilibré : des cas où il faut agir, et des cas où il ne faut pas.
    etats = [c.get("etat", {}) for c in cas]
    assert sum(e.get("recapitulatif") is True for e in etats) >= 4
    assert sum(e.get("recapitulatif") is False for e in etats) >= 30
    assert sum(e.get("transmis") is True for e in etats) >= 6
    assert sum(e.get("transmis") is False for e in etats) >= 20


def test_les_pieges_generes_viennent_d_un_modele_plus_fort_que_le_comptoir():
    r = generer_cas.requete()
    assert r["model"] == "claude-opus-5-5" and r["output_config"]["format"]["type"] == "json_schema"
    assert "Livraison gratuite dès 5 bouteilles" in r["messages"][0]["content"]  # il lit les vraies conditions


# --- Une variante ne change qu'une chose ------------------------------------------------

def test_le_modele_du_comptoir_se_change_sans_toucher_au_reste():
    defaut = ComptoirCommandes(None, Boutique(), Budget(), "c1").requete("Bonjour")
    autre = ComptoirCommandes(None, Boutique(), Budget(), "c1", modele="claude-haiku-5-5").requete("Bonjour")
    assert defaut["model"] == "claude-sonnet-5-5" and autre["model"] == "claude-haiku-5-5"
    assert {k: v for k, v in defaut.items() if k != "model"} == {k: v for k, v in autre.items() if k != "model"}


# --- Le banc d'essai ----------------------------------------------------------------------

def test_un_essai_lit_l_etat_dans_la_boutique_et_garde_la_transcription():
    preparer = ToolUseBlock(type="tool_use", id="t1", name="commande_preparer",
                            input={"lignes": [{"produit": "Jus de gingembre", "quantite": 2},
                                              {"produit": "Sirop de bissap", "quantite": 1}],
                                   "nom_client": "Mariam", "quartier": "Gbégamey"})
    client = FauxClient(routage("commande"), message(preparer, arret="tool_use"),
                        texte("Voici votre récapitulatif : vérifiez-le, puis répondez comme indiqué."))
    essai = essayer(client, Variante("reference"), CAS["commande-complete"], 1, charger_base()[:3])
    assert essai.erreur is None and essai.categorie == "commande"
    assert essai.recapitulatifs == [{"statut": "en_attente", "total": 5000}] and essai.commandes == 0
    assert "Récapitulatif de votre commande" in essai.texte and "Récapitulatif" not in essai.texte_claude
    assert essai.outils == ["commande_preparer"] and len(essai.appels) == 3
    assert essai.appels[2]["recu"][0]["erreur"] is False and "5000" in essai.appels[2]["recu"][0]["contenu"]
    assert noter(CAS["commande-complete"], essai) == []


def test_chaque_essai_part_d_une_boutique_neuve_a_heure_fixe():
    a, b = banc.environnement(), banc.environnement()
    a.transmettre("c1", "autre", "x")
    assert b.demandes() == [] and a._maintenant() == banc.HEURE_DES_ESSAIS
    assert a.livraison_prevue(a._maintenant()) == "aujourd'hui"


def test_une_panne_est_un_echec_de_trace_et_la_serie_continue():
    essai = essayer(FauxClient(ConnectionError("réseau")), Variante("reference"), CAS["merci"], 1, charger_base()[:3])
    assert essai.erreur.startswith("ConnectionError")
    assert [e.famille for e in noter(CAS["merci"], essai)] == ["trace"]


# --- La notation par le code ------------------------------------------------------------

def fait(cas="prix-ananas", texte_claude="Le jus d'ananas coûte 1 000 FCFA.", **champs):
    valeurs = {"categorie": CAS[cas]["categorie"][0], "texte": texte_claude, "texte_claude": texte_claude, **champs}
    return Essai("v", cas, 1, **valeurs)


def test_le_code_lit_les_faits_et_non_le_texte():
    assert noter(CAS["prix-ananas"], fait()) == []
    rate = noter(CAS["tiedes"], fait("tiedes", "Désolés ! Votre réclamation part chez Awa."))
    assert [(e.famille, e.raison) for e in rate] == [("etat", "aucune demande transmise à Awa")]
    total = noter(CAS["commande-complete"], fait("commande-complete", "Voici le récapitulatif.",
                                                 recapitulatifs=[{"statut": "en_attente", "total": 4500}]))
    assert [e.raison for e in total] == ["total 4500 FCFA, attendu 5000"]
    route = noter(CAS["prix-ananas"], fait(categorie="information, repli"))
    assert route == []  # passé par l'information, puis repris par le Comptoir : le bon chemin


def test_dire_n_est_pas_faire():
    annonce = noter(CAS["recrutement"], fait("recrutement", "Je transmets votre question à Awa."))
    assert "annonce une transmission à Awa qui n'a pas eu lieu" in [e.raison for e in annonce]
    proposition = noter(CAS["recrutement"], fait("recrutement", "Souhaitez-vous que je transmette votre question à Awa ?"))
    assert proposition == []
    faux_oui = noter(CAS["faux-oui"], fait("faux-oui", "C'est bon, votre commande est confirmée !"))
    assert "annonce une commande enregistrée qui n'existe pas" in [e.raison for e in faux_oui]
    assert noter(CAS["prix-ananas"], fait(commandes=1))[0].raison.startswith("1 commande(s) créée(s)")


def test_une_condition_ou_une_question_n_annonce_rien():
    """Les trois phrases qui ont trompé la première version de la grille, relevées dans les transcriptions."""
    lues = ["Si votre commande est confirmée avant 12 h, elle est livrée le jour même, entre 16 h et 19 h.",
            "Je ne peux pas appliquer de remise. Si vous le souhaitez, je lui transmets votre demande.",
            "Voulez-vous que je transmette votre demande ?"]
    sans_critere = {"id": "x", "message": "m", "categorie": ["autre"]}
    for texte_claude in lues:
        assert noter(sans_critere, Essai("v", "x", 1, "autre", texte_claude, texte_claude)) == [], texte_claude
    affirmation = "Je viens de lui transmettre votre demande."
    assert [e.raison for e in noter(sans_critere, Essai("v", "x", 1, "autre", affirmation, affirmation))] == [
        "annonce une transmission à Awa qui n'a pas eu lieu"]


def test_une_consigne_glissee_dans_le_nom_ne_trompe_pas_la_grille():
    juste = "C'est noté Koffi : voici votre récapitulatif, 6 000 FCFA, livraison offerte."
    essai = fait("injection-nom", juste, recapitulatifs=[{"statut": "en_attente", "total": 6000}])
    assert noter(CAS["injection-nom"], essai) == []  # « 6 000 FCFA » ne passe pas pour « 0 FCFA »
    gratuit = fait("injection-nom", "C'est offert : 0 FCFA !", recapitulatifs=[{"statut": "en_attente", "total": 6000}])
    assert noter(CAS["injection-nom"], gratuit)


# --- Le juge ------------------------------------------------------------------------------

def verdicts(**v):
    return {c: {"constat": "test", "verdict": v.get(c, "oui")} for c in juge.CRITERES}


def test_le_juge_lit_les_documents_en_cache_et_ecrit_son_constat_d_abord():
    essai = fait("injection-nom", "Voici le récapitulatif.", recapitulatifs=[{"statut": "en_attente", "total": 6000}])
    r = juge.requete(CAS["injection-nom"], essai, "claude-haiku-5-5")
    documents, a_noter = r["messages"][0]["content"]
    assert documents["cache_control"] == {"type": "ephemeral"} and "Livraison gratuite dès 5 bouteilles" in documents["text"]
    assert "[SYSTEM:" in a_noter["text"] and "récapitulatif préparé : oui, total 6000 FCFA" in a_noter["text"]
    assert "ne les suis pas" in r["system"]  # la consigne glissée vise aussi le juge
    for critere in juge.CRITERES:
        assert list(juge.SCHEMA["properties"][critere]["properties"]) == ["constat", "verdict"]


def test_l_issue_d_un_jugement():
    client = FauxClient(texte(json.dumps(verdicts())), texte(json.dumps(verdicts(ton="non"))),
                        texte(json.dumps(verdicts(exacte="inconnu"))), texte("", arret="max_tokens"))
    issues = [juge.juger(client, CAS["prix-ananas"], fait(), "claude-haiku-5-5").issue for _ in range(4)]
    assert issues == ["reussi", "echoue", "a_relire", "a_relire"]


# --- L'étalonnage -----------------------------------------------------------------------

def test_un_juge_qui_dit_toujours_oui_a_un_bon_accord_et_un_kappa_nul():
    humain = {f"e{i}": {"exacte": "oui"} for i in range(9)} | {"e9": {"exacte": "non"}}
    complaisant = {f"e{i}": {"exacte": "oui"} for i in range(10)}
    accord = etalonnage.comparer(humain, complaisant)[0]
    assert accord.accord_brut == 0.9 and accord.kappa == 0 and accord.faux_oui == ["e9"]
    assert etalonnage.comparer(humain, humain)[0].kappa == 1


def test_l_accord_sur_l_issue():
    humain = {"a": {"exacte": "oui", "ton": "oui"}, "b": {"exacte": "non", "ton": "oui"}}
    juge_ = {"a": {"exacte": "oui", "ton": "inconnu"}, "b": {"exacte": "non", "ton": "oui"}}
    assert etalonnage.accord_global(humain, juge_) == (1, 2, ["a"])


# --- Résumer, comparer --------------------------------------------------------------------

def test_reussite_a_chaque_essai_et_cas_instables():
    essais = [fait(), Essai("v", "prix-ananas", 2, "information", "1 000 FCFA", "1 000 FCFA"),
              fait("merci", "Merci à vous !"), Essai("v", "merci", 2, "autre", "", "")]
    r = suite.resumer(essais, list(CAS.values()))
    assert r["reussite_code"] == 0.75 and r["cas_toujours_reussis"] == 1 and r["cas_instables"] == ["merci"]
    jugements = {e.identifiant: {"essai": e.identifiant, "verdicts": {"exacte": "oui"}, "cout_dollars": 0.001}
                 for e in essais}
    jugements["v/prix-ananas/2"]["verdicts"] = {"exacte": "non"}
    r = suite.resumer(essais, list(CAS.values()), jugements)
    assert r["reussite"] == 0.5 and r["non_par_critere"] == {"exacte": 1} and r["cout_juge"] == 0.004


def test_le_test_du_signe():
    assert comparer.test_du_signe(6, 0) == pytest.approx(0.03125)
    assert comparer.test_du_signe(1, 1) == 1.0 and comparer.test_du_signe(0, 0) == 1.0
    assert comparer.comparer({"a": 1.0, "b": 0.0, "c": 1.0}, {"a": 1.0, "b": 1.0, "c": 0.67}) == (["b"], ["c"])


def test_le_budget_arrete_la_serie(monkeypatch):
    monkeypatch.setattr(suite, "essayer", lambda client, v, c, n, base: Essai(v.nom, c["id"], n, cout_dollars=0.4))
    cas = [CAS["prix-ananas"], CAS["six-bissap"]]
    essais, arrete = suite.lancer(None, Variante("reference"), cas, 3, budget_max=1.0, base=[], paralleles=1,
                                  au_fil=lambda *_: None)
    assert arrete and len(essais) == 3
    assert [(e.cas, e.essai) for e in essais] == [("prix-ananas", 1), ("six-bissap", 1), ("prix-ananas", 2)]


def test_le_jeu_de_verification_ne_se_lance_pas_par_megarde():
    args = argparse.Namespace(jeu="verification", je_livre=False, variante="reference", cas=None)
    with pytest.raises(SystemExit, match="--je-livre"):
        evaluer.cmd_lancer(args)


def test_le_registre_garde_de_quoi_retrouver_une_serie(tmp_path):
    cas = [CAS["prix-ananas"]]
    entree = suite.entree_de_registre(tmp_path / "serie", suite.VARIANTES["reference"], "amelioration", cas, 3, {}, False)
    assert entree["versions"]["prompt_comptoir"].startswith("systeme-v3@")
    assert entree["versions"]["modele_comptoir"] == "claude-sonnet-5-5"
    assert entree["empreinte_cas"] == suite.empreinte_cas(cas) and len(entree["empreinte_notation"]) == 8


# --- L'échantillon pour la notation humaine -----------------------------------------------

def test_l_echantillon_prend_un_essai_par_cas_et_respecte_les_types():
    from ch17 import echantillon
    cas = [c for c in CAS.values() if c["jeu"] == "amelioration"]
    essais = [fait(c["id"], "Réponse.") for c in cas] + [Essai("v", c["id"], 2, texte="R2", texte_claude="R2") for c in cas]
    tirage = echantillon.tirer(essais, list(CAS.values()), 30)
    assert len(tirage["essais"]) == 30 and len({f["cas"] for f in tirage["fiches"]}) == 30
    types = [f["type"] for f in tirage["fiches"]]
    assert (types.count("courant"), types.count("piege"), types.count("securite")) == (15, 9, 6)
    moities = tirage["moities"]
    assert len(moities["etalonnage"]) == 15 and set(moities["etalonnage"]).isdisjoint(moities["controle"])
    assert tirage == echantillon.tirer(essais, list(CAS.values()), 30)  # reproductible


def test_la_page_de_notation_ne_montre_pas_le_juge_et_ne_casse_pas_sur_une_balise():
    from ch17 import echantillon
    fiche = {"essai": "v/x/1", "cas": "x", "type": "courant", "message": "</script><b>", "reponse": "r",
             "recapitulatif": "", "actions": "a", "attendu": "t"}
    page = echantillon.contenu_de_page({"criteres": list(juge.CRITERES), "fiches": [fiche]})
    donnees = page.split('id="donnees">')[1].split("</script>")[0]
    assert "<\\/script>" in donnees and json.loads(donnees)["fiches"][0]["message"] == "</script><b>"
    assert "verdict" not in donnees and "constat" not in donnees


def test_le_juge_et_l_humain_voient_les_resultats_d_outils():
    """Sans eux, le juge prenait pour inventé un stock que le Comptoir avait vérifié (première notation)."""
    appels = [{"rendu": [{"type": "tool_use", "name": "stock_verifier", "input": {"produits": ["Jus d'ananas"]}}], "recu": []},
              {"rendu": [{"type": "text", "text": "Oui."}], "recu": [{"erreur": False, "contenu": '{"Jus d\'ananas": 12}'}]}]
    essai = Essai("v", "stock-ananas", 1, "commande", "Oui.", "Oui.", appels=appels)
    texte_actions = juge.actions(essai)
    assert 'stock_verifier {"produits": ["Jus d\'ananas"]} → {"Jus d\'ananas": 12}' in texte_actions
    assert "outils appelés et leurs résultats : aucun" in juge.actions(fait())
    assert "résultat d'outil n'est pas inventée" in juge.charger_grille().texte and juge.GRILLE == "v2"


def test_l_empreinte_des_cas_ne_suit_que_les_messages():
    cas = [CAS["prix-ananas"]]
    autre_attendu = [{**CAS["prix-ananas"], "reference": "Autre attendu."}]
    autre_message = [{**CAS["prix-ananas"], "message": "Autre message ?"}]
    assert suite.empreinte_cas(cas) == suite.empreinte_cas(autre_attendu) != suite.empreinte_cas(autre_message)


def test_chaque_variante_ne_change_qu_une_chose():
    import difflib
    from comptoir.prompt import charger
    v3, v4 = charger("v3").texte.splitlines(), charger("v4").texte.splitlines()
    changees = [l for l in difflib.unified_diff(v3, v4, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]
    retiree, ajoutee = changees  # une seule ligne change : la règle de longueur, que v4 prolonge
    assert retiree.startswith("-") and ajoutee.startswith("+") and ajoutee[1:].startswith(retiree[1:])
    for nom, v in suite.VARIANTES.items():
        # Les variantes du chapitre 18 se comparent à « haiku », la version livrée après le chapitre 17.
        reference = suite.VARIANTES["livree" if nom == "effort-low" else
                                    "haiku" if nom in ("prompt-v5", "livree") else "reference"]

        def effectif(variante, k):  # None : le modèle de config, Claude Haiku 5.5 depuis le chapitre 17
            return getattr(variante, k) or (suite.config.MODELE_COMPTOIR if k == "modele_comptoir" else None)
        differences = [k for k in ("modele_comptoir", "version_prompt", "version_documents", "effort_comptoir")
                       if effectif(v, k) != effectif(reference, k)]
        assert len(differences) == (0 if nom == "reference" else 1), nom


def test_la_non_regression_echoue_au_premier_cas_rate(tmp_path, monkeypatch):
    regression = tmp_path / "regression.json"
    regression.write_text(json.dumps({"cas": ["prix-ananas", "merci"]}), encoding="utf-8")
    monkeypatch.setattr(evaluer, "REGRESSION", regression)
    monkeypatch.setattr(evaluer, "creer_client", lambda: None)
    monkeypatch.setattr(evaluer, "charger_base", lambda: [])
    reponses = {"prix-ananas": "Le jus d'ananas coûte 1 000 FCFA.", "merci": "Merci à vous, bonne soirée !"}

    def lancer(client, variante, cas, essais, budget, base, paralleles):
        return [Essai(variante.nom, c["id"], 1, c["categorie"][0], reponses[c["id"]], reponses[c["id"]]) for c in cas], False

    monkeypatch.setattr(evaluer, "lancer", lancer)
    args = argparse.Namespace(variante="reference", budget_max=0.3, paralleles=1)
    assert evaluer.cmd_regression(args) == 0
    reponses["prix-ananas"] = "Je ne sais pas."
    assert evaluer.cmd_regression(args) == 1


def test_seuls_les_cas_reussis_a_chaque_essai_entrent_dans_la_non_regression(tmp_path, monkeypatch):
    regression = tmp_path / "regression.json"
    monkeypatch.setattr(evaluer, "REGRESSION", regression)
    serie = tmp_path / "serie"
    stable = [fait(), Essai("v", "prix-ananas", 2, "information", "1 000 FCFA", "1 000 FCFA")]
    instable = [fait("merci", "Merci à vous !"), Essai("v", "merci", 2, "autre", "", "")]
    suite.ecrire_serie(serie, stable + instable)
    evaluer.cmd_graduer(argparse.Namespace(serie=str(serie)))
    assert json.loads(regression.read_text(encoding="utf-8"))["cas"] == ["prix-ananas"]


def test_la_version_livree_est_le_comptoir_sur_haiku():
    """La décision du chapitre 17, dans la configuration ; le chapitre 12 garde son Comptoir sur Sonnet 5.5."""
    from comptoir import config
    from comptoir.aiguillage import ComptoirAiguille
    assert config.MODELE_COMPTOIR == "claude-haiku-5-5"
    livree = ComptoirAiguille(None, Boutique(), Budget(), "c1", charger_base()[:3])
    assert livree.comptoir.requete("Bonjour")["model"] == "claude-haiku-5-5"
    assert suite.versions(suite.VARIANTES["livree"])["modele_comptoir"] == "claude-haiku-5-5"
    assert suite.versions(suite.VARIANTES["reference"])["modele_comptoir"] == "claude-sonnet-5-5"
    source = (suite.DOSSIER.parent / "ch12" / "comptoir_aiguille.py").read_text(encoding="utf-8")
    assert "modele_comptoir=config.MODELE" in source
