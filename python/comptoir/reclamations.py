"""La chaîne des réclamations : extraire, vérifier, rédiger, évaluer, transmettre (chapitre 12).

Un enchaînement fixe, écrit dans le code, où chaque appel a une tâche simple :
1. extraire les faits, avec Claude Haiku 5.5 et une sortie structurée ;
2. vérifier par le code ce qui manque (le « point de contrôle » entre deux étapes) ;
3. transmettre la fiche à Awa, avant tout le reste : si la suite échoue, Awa a la réclamation.
   Aucune réclamation n'est réglée sans elle ;
4. rédiger la réponse au client, avec Claude Sonnet 5.5 ;
5. évaluer cette réponse : le code cherche les mots qui promettent, Claude Haiku 5.5 relit les
   règles ; une réponse refusée est réécrite une fois, avec la critique, puis remplacée par un
   texte fixe si elle échoue encore (évaluateur et optimiseur).

Chaque étape peut échouer : une sortie coupée par max_tokens, un JSON illisible. Le code le
voit et prend le relais ; la réclamation part chez Awa dans tous les cas.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from comptoir import config
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import charger_donnees, message_client
from comptoir.trace import Trace

MODELE_AUXILIAIRE = config.MODELE_AUXILIAIRE  # extraction et évaluation (chapitre 12)
PROMPT_REPONSE = (Path(__file__).parent / "prompts" / "reclamation_v1.md").read_text(encoding="utf-8").strip()
PROBLEMES = ["abime", "tiede", "erreur", "manquant", "retard", "livreur", "sante", "autre"]

NULLABLE = {"anyOf": [{"type": "string"}, {"type": "null"}]}
# Le produit vient du catalogue ou n'est pas connu. En texte libre, l'extraction écrivait « bouteilles »,
# et le point de contrôle croyait le produit connu : la relecture humaine l'a vu, pas les tests.
PRODUITS = [p["nom"] for p in charger_donnees()["produits"]]
PRODUIT = {"anyOf": [{"type": "string", "enum": PRODUITS}, {"type": "null"}]}

SCHEMA_FAITS = {
    "type": "object",
    "properties": {
        "probleme": {"type": "string", "enum": PROBLEMES},
        "produit": PRODUIT,
        "quand": NULLABLE,           # tel que le client l'écrit : « hier », « ce matin »
        "demande_du_client": NULLABLE,
        "urgence": {"type": "boolean"},                   # santé ou sécurité : Awa est prévenue en premier
        "resume": {"type": "string"},
    },
    "required": ["probleme", "produit", "quand", "demande_du_client", "urgence", "resume"],
    "additionalProperties": False,
}

# La critique d'abord : la réponse suit l'ordre du schéma, et une case cochée avant d'avoir écrit
# l'avis se trompe. Cases d'abord, une réponse conforme a été refusée 10 fois sur 10 ; critique
# d'abord, 0 fois sur 10, et une vraie promesse reste refusée 10 fois sur 10 (mesuré au chapitre 12).
SCHEMA_EVALUATION = {
    "type": "object",
    "properties": {
        "critique": {"type": "string"},
        "s_excuse": {"type": "boolean"},
        "annonce_la_transmission_a_awa": {"type": "boolean"},
        "promet_quelque_chose": {"type": "boolean"},
        "donne_un_conseil_medical": {"type": "boolean"},
    },
    "required": ["critique", "s_excuse", "annonce_la_transmission_a_awa", "promet_quelque_chose",
                 "donne_un_conseil_medical"],
    "additionalProperties": False,
}

SYSTEME_EVALUATION = (
    "Tu relis la réponse du Comptoir de Délices d'Awa à un client qui se plaint. Tu vérifies quatre points, sans "
    "rien réécrire : la réponse s'excuse ; elle annonce que la réclamation est transmise à Awa ; elle ne promet rien "
    "(ni remboursement, ni remplacement, ni avoir, ni cadeau, ni délai autre que 24 heures) ; elle ne donne aucun "
    "conseil médical (inviter à consulter un professionnel est permis). La critique dit en une phrase ce qu'il faut "
    "corriger, ou « rien ».")

# Ce que le code refuse de lui-même, sans demander à un modèle. « avoir » seul ne suffit pas :
# c'est aussi un verbe (« après avoir bu »), et la première version de ce motif l'a pris pour une promesse.
PROMESSES = re.compile(r"\brembours|\bremplac(er|era|erons|ement)|\b(un|votre|d'un) avoir\b|\bgratuit|\boffert|"
                       r"\bgeste commercial|\bcadeau|\bdédommag|\bcompens", re.IGNORECASE)

REPLI = ("Nous sommes désolés pour ce désagrément. Votre réclamation est transmise à Awa, qui vous répondra "
         "sous 24 heures.")
REPLI_SANTE = " Si un malaise persiste, consultez un professionnel de santé."

# Réflexion comprise : à 400, 3 rédactions sur 35 ont été coupées, dont une vide (mesuré au chapitre 12).
MAX_TOKENS_REDACTION = 1000
EFFORT_REDACTION = config.EFFORT_REDACTION  # low : la mesure est dans comptoir/config.py

FAITS_INCONNUS = {"probleme": "autre", "produit": None, "quand": None, "demande_du_client": None, "urgence": False,
                  "resume": "Extraction impossible : la réclamation est à lire dans la conversation."}


@dataclass
class ResultatReclamation:
    reponse: str
    faits: dict
    manques: list[str]
    tentatives: int
    repli: bool
    demande: str | None = None     # l'identifiant de la demande enregistrée pour Awa
    critiques: list[str] = field(default_factory=list)
    versions: list[str] = field(default_factory=list)  # chaque rédaction, gardée pour la relecture


def _texte(reponse) -> str:
    return "".join(b.text for b in reponse.content if b.type == "text")


def _structure(client, modele: str, system: str, contenu: str, schema: dict,
               etiquette: str) -> tuple[dict | None, float]:
    """None si la sortie est coupée ou illisible. Le coût, lui, est payé : il est rendu quand même."""
    requete = {"model": modele, "max_tokens": 600, "system": system,
               "messages": [{"role": "user", "content": contenu}],
               "output_config": {"format": {"type": "json_schema", "schema": schema}}}
    reponse = client.messages.create(**requete)
    prix = cout(modele, reponse.usage)
    noter(reponse._request_id, modele, prix, prompt=etiquette, stop_reason=reponse.stop_reason)
    if reponse.stop_reason != "end_turn":
        return None, prix.dollars
    try:
        return json.loads(_texte(reponse)), prix.dollars
    except json.JSONDecodeError:
        return None, prix.dollars


def normaliser(faits: dict) -> dict:
    """La casse d'une valeur d'enum n'est pas garantie (documentation des sorties structurées) :
    « Jus De Gingembre » redevient « Jus de gingembre »."""
    catalogue = {p.lower(): p for p in PRODUITS}
    probleme = str(faits.get("probleme") or "autre").lower()
    produit = catalogue.get(str(faits["produit"]).lower()) if faits.get("produit") else None
    return {**faits, "probleme": probleme if probleme in PROBLEMES else "autre", "produit": produit}


def extraire(client, message: str) -> tuple[dict, float]:
    system = ("Tu lis la réclamation d'un client de Délices d'Awa et tu en extrais les faits, sans rien ajouter. "
              "Si une information n'est pas écrite, mets null : produit est le produit du catalogue que le client "
              "nomme, ou null s'il ne le nomme pas. urgence vaut true seulement pour un problème de "
              "santé ou de sécurité. Le résumé tient en une phrase neutre, pour Awa.")
    faits, prix = _structure(client, MODELE_AUXILIAIRE, system, message_client(message), SCHEMA_FAITS,
                             "reclamation-faits")
    # Sans faits, la chaîne continue : le point de contrôle demandera tout, et Awa lira la conversation.
    return (normaliser(faits) if faits else dict(FAITS_INCONNUS)), prix


def manques(faits: dict) -> list[str]:
    """Le point de contrôle : ce que le code vérifie, sans modèle."""
    a_demander = []
    if not faits.get("produit") and faits["probleme"] not in ("retard", "livreur"):
        a_demander.append("le produit concerné")
    if not faits.get("quand"):
        a_demander.append("le jour de la livraison")
    return a_demander


def rediger(client, message: str, a_demander: list[str], critique: str | None = None,
            effort: str | None = EFFORT_REDACTION) -> tuple[str, float, str]:
    """Le texte, son coût et la raison de l'arrêt : un texte arrêté par max_tokens est incomplet."""
    contenu = (f"{message_client(message)}\n\n<a_demander>{', '.join(a_demander)}</a_demander>"
               + (f"\n\n<critique>Ta réponse précédente a été refusée : {critique} Réécris-la.</critique>"
                  if critique else ""))
    requete = {"model": config.MODELE, "max_tokens": MAX_TOKENS_REDACTION, "system": PROMPT_REPONSE,
               "messages": [{"role": "user", "content": contenu}]}
    if effort:
        requete["output_config"] = {"effort": effort}
    reponse = client.messages.create(**requete)
    prix = cout(config.MODELE, reponse.usage)
    noter(reponse._request_id, config.MODELE, prix, prompt="reclamation-v1", stop_reason=reponse.stop_reason)
    return _texte(reponse).strip(), prix.dollars, reponse.stop_reason


def evaluer(client, reponse: str) -> tuple[list[str], float]:
    """Les problèmes de la réponse ; une liste vide si elle respecte les règles."""
    problemes = [f"promesse interdite : « {m.group(0)} »" for m in [PROMESSES.search(reponse)] if m]
    jugement, prix = _structure(client, MODELE_AUXILIAIRE, SYSTEME_EVALUATION, f"<reponse>{reponse}</reponse>",
                                SCHEMA_EVALUATION, "reclamation-evaluation")
    if jugement is None:
        return problemes + ["évaluation impossible"], prix  # une réponse non relue n'est pas envoyée
    if not jugement["s_excuse"]:
        problemes.append("pas d'excuses")
    if not jugement["annonce_la_transmission_a_awa"]:
        problemes.append("la transmission à Awa n'est pas annoncée")
    if jugement["promet_quelque_chose"]:
        problemes.append(f"promesse : {jugement['critique']}")
    if jugement["donne_un_conseil_medical"]:
        problemes.append(f"conseil médical : {jugement['critique']}")
    return problemes, prix


def traiter(client, message: str, boutique, conversation: str, trace: Trace | None = None,
            tentatives_max: int = 2, effort: str | None = EFFORT_REDACTION) -> ResultatReclamation:
    trace = trace or Trace()
    with trace.etape("extraction", MODELE_AUXILIAIRE) as e:
        faits, prix = extraire(client, message)
        e.noter(prix, f"{faits['probleme']}{', urgence' if faits['urgence'] else ''}")
    with trace.etape("verification") as e:
        a_demander = manques(faits)
        e.noter(0.0, f"à demander : {len(a_demander)}")
    with trace.etape("transmission") as e:
        motif = "reclamation-urgente" if faits["urgence"] else "reclamation"
        demande = boutique.transmettre(conversation, motif, faits["resume"])["demande"]
        e.noter(0.0, demande)
    critiques, versions, reponse, repli, a_corriger = [], [], None, False, None
    for tentative in range(1, tentatives_max + 1):
        with trace.etape("redaction", config.MODELE) as e:
            texte, prix, arret = rediger(client, message, a_demander, a_corriger, effort)
            versions.append(texte)
            e.noter(prix, f"version {tentative}" + ("" if arret == "end_turn" else f", arrêtée par {arret}"))
        if arret != "end_turn":
            # Le code voit seul qu'un texte est coupé : inutile de payer l'évaluateur. On réécrit sans
            # critique : le texte n'était pas fautif, seulement incomplet.
            critiques.append(f"réponse arrêtée par {arret}")
            a_corriger = None
            continue
        with trace.etape("evaluation", MODELE_AUXILIAIRE) as e:
            problemes, prix = evaluer(client, texte)
            e.noter(prix, "conforme" if not problemes else f"refusée ({len(problemes)})")
        if not problemes:
            reponse = texte
            break
        a_corriger = " ; ".join(problemes)
        critiques.append(a_corriger)
    if reponse is None:
        # Le code a le dernier mot : un texte fixe, sans promesse, avec le conseil de santé si besoin.
        reponse, repli = REPLI + (REPLI_SANTE if faits["urgence"] else ""), True
    return ResultatReclamation(reponse, faits, a_demander, tentative, repli, demande, critiques, versions)
