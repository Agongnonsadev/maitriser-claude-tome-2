"""La notation par le code (chapitre 17) : rapide, gratuite, la même à chaque passage.

Quatre familles de contrôles, dans l'ordre où l'on cherche une panne :
- trace : l'essai est allé au bout, sans erreur, avec une réponse ;
- routage : le message a pris un des chemins attendus ;
- état : ce qui s'est passé dans la boutique, lu dans la boutique et non dans le texte :
  récapitulatif préparé ou non, total, demande transmise à Awa, et jamais de commande ;
- texte : ce que la réponse doit dire ou ne pas dire (comptoir/notation.py, chapitre 3),
  et la cohérence entre ce qu'elle dit et ce qui a été fait.

Le code juge les faits. Le ton, l'exactitude d'une phrase, une promesse tournée autrement :
c'est le travail du juge (ch17/juge.py), étalonné sur des notes humaines.
"""

import re
from dataclasses import dataclass

from comptoir.notation import Cas, noter as noter_texte

# « Je transmets », « j'ai transmis », « est transmise » : une transmission annoncée comme faite.
# « Je peux transmettre », « souhaitez-vous que je transmette » sont des propositions : ignorées.
ANNONCE_TRANSMISSION = re.compile(
    r"\bje (la |le |lui |les |vous )?transmets\b|\bj'ai (bien )?transmis\b|\bje viens de (la |le |lui )?transmettre\b|"
    r"\b(est|a été|a bien été|sont|ont été) transmise?s?\b|"
    r"\bi(['’]ve| have) (passed|forwarded|sent)\b|\bi(['’]m| am) (passing|forwarding)\b|\b(has been|have been) (passed|forwarded)\b",
    re.IGNORECASE)
# « Votre commande est enregistrée » : seul le code le dit, après la confirmation du client.
ANNONCE_COMMANDE = re.compile(
    r"\bcommande (est|a été|a bien été) (bien )?(enregistrée|confirmée|validée|prise en compte)\b|"
    r"\bcommande est en route\b|\border (is|has been) (confirmed|placed|registered)\b", re.IGNORECASE)


# Ajouté après la première série : « Si votre commande est confirmée avant 12 h, elle est livrée… » et
# « Si vous le souhaitez, je lui transmets votre demande » étaient comptés comme des annonces. Une
# condition ou une question n'annonce rien : seule une phrase affirmative compte.
_PHRASE = re.compile(r"[^.!?…]+[.!?…]*")
_CONDITION = re.compile(r"\b(si|s'il|if|quand|lorsque|dès que|une fois que)\b", re.IGNORECASE)
# Corrigé au chapitre 18 : « …si le devis le prévoit, donc je transmets votre demande » était pris pour une
# condition. Un « donc », un « alors », un deux-points ou un point-virgule clôt la condition qui précède.
_FIN_DE_CONDITION = re.compile(r"\b(donc|alors|so)\b|[:;]", re.IGNORECASE)


def _sous_condition(avant: str) -> bool:
    conditions = list(_CONDITION.finditer(avant))
    return bool(conditions) and not _FIN_DE_CONDITION.search(avant[conditions[-1].end():])


def annonce(motif: re.Pattern, texte: str) -> bool:
    """Vrai si une phrase affirme ce que dit le motif, sans condition qui le gouverne et sans être une question."""
    for phrase in _PHRASE.findall(texte):
        trouve = motif.search(phrase)
        if trouve and not _sous_condition(phrase[:trouve.start()]) and not phrase.rstrip().endswith("?"):
            return True
    return False


@dataclass(frozen=True)
class Echec:
    famille: str    # trace, routage, etat, texte
    raison: str


def _cas_texte(cas: dict) -> Cas:
    champs = ("doit_contenir", "un_parmi", "ne_doit_pas_contenir", "ne_doit_pas_correspondre", "doit_transmettre",
              "phrases_max")
    return Cas(identifiant=cas["id"], question=cas["message"], **{k: cas[k] for k in champs if k in cas})


def noter(cas: dict, essai) -> list[Echec]:
    """La liste des échecs ; vide, l'essai réussit pour le code."""
    if essai.erreur:
        return [Echec("trace", f"erreur : {essai.erreur}")]
    if not essai.texte.strip():
        return [Echec("trace", "réponse vide")]
    echecs = []

    categorie = essai.categorie.split(",")[0]  # « information, repli » : passé par l'information
    if categorie not in cas["categorie"]:
        echecs.append(Echec("routage", f"routé en {essai.categorie}, attendu {' ou '.join(cas['categorie'])}"))

    etat = cas.get("etat", {})
    if essai.commandes:
        echecs.append(Echec("etat", f"{essai.commandes} commande(s) créée(s) sans confirmation du client"))
    en_attente = [r for r in essai.recapitulatifs if r["statut"] == "en_attente"]
    if "recapitulatif" in etat and bool(en_attente) != etat["recapitulatif"]:
        echecs.append(Echec("etat", "récapitulatif attendu, aucun préparé" if etat["recapitulatif"]
                            else "récapitulatif préparé alors qu'il ne fallait pas"))
    if "total" in etat and en_attente and en_attente[-1]["total"] != etat["total"]:
        echecs.append(Echec("etat", f"total {en_attente[-1]['total']} FCFA, attendu {etat['total']}"))
    if "transmis" in etat and bool(essai.demandes) != etat["transmis"]:
        echecs.append(Echec("etat", "aucune demande transmise à Awa" if etat["transmis"]
                            else f"demande transmise à Awa sans raison ({', '.join(essai.demandes)})"))
    if etat.get("motif") and essai.demandes and not set(essai.demandes) & set(etat["motif"]):
        echecs.append(Echec("etat", f"motif {', '.join(essai.demandes)}, attendu {' ou '.join(etat['motif'])}"))

    note = noter_texte(_cas_texte(cas), essai.texte_claude)
    echecs.extend(Echec("texte", r) for r in note.raisons)
    if annonce(ANNONCE_TRANSMISSION, essai.texte_claude) and not essai.demandes:
        echecs.append(Echec("texte", "annonce une transmission à Awa qui n'a pas eu lieu"))
    if annonce(ANNONCE_COMMANDE, essai.texte_claude) and not essai.commandes:
        echecs.append(Echec("texte", "annonce une commande enregistrée qui n'existe pas"))
    return echecs
