"""Transformer une photo de bon de commande ou une facture en données validées (chapitre 7).

Trois étages, et aucun ne fait confiance au précédent :
1. le schéma, imposé à Claude par les sorties structurées : la forme est garantie ;
2. la validation Pydantic, par le code : les contraintes que l'API ne vérifie pas ;
3. les contrôles métier, par le code : prix du catalogue, totaux, lignes douteuses.
Puis un humain valide, avant tout enregistrement.
"""

from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Literal

from anthropic import transform_schema
from pydantic import BaseModel, Field, ValidationError

from comptoir import config
from comptoir.couts import Cout, cout
from comptoir.journal import noter
from comptoir.prompt import DOSSIER, PromptSysteme, charger_donnees, rendre_catalogue

MAX_TOKENS = 4000  # réflexion comprise : un bon de vingt lignes doit tenir sans être coupé

Lisibilite = Literal["lisible", "douteux", "illisible"]


# --- Les schémas ------------------------------------------------------------------------
# Les descriptions font partie du prompt : Claude les lit. Les contraintes comme ge=1, que
# l'API n'impose pas, passent dans la description (le SDK s'en charge) ; Pydantic les vérifie.


class LigneDeCommande(BaseModel):
    libelle_lu: str = Field(description="Le produit tel qu'il est écrit sur le bon, recopié sans correction.")
    produit: str | None = Field(
        description="Le nom exact du catalogue qui correspond, seulement si la correspondance est certaine ; sinon null."
    )
    quantite: int | None = Field(ge=1, description="Le nombre de bouteilles ou de flacons ; null si illisible ou absent.")
    prix_unitaire_lu: int | None = Field(
        description="Le prix unitaire écrit sur le bon, en FCFA ; null s'il n'est pas écrit ou illisible."
    )
    lisibilite: Lisibilite
    remarque: str | None = Field(description="Ce qui pose problème sur cette ligne ; null sinon.")


class BonDeCommande(BaseModel):
    type_document: Literal["bon_de_commande", "autre"]
    client: str | None = Field(description="Le nom du client tel qu'il est écrit ; null s'il n'y en a pas.")
    quartier: str | None = Field(description="Le quartier ou l'adresse de livraison ; null s'il n'y en a pas.")
    date_livraison_lue: str | None = Field(description="La date de livraison telle qu'elle est écrite ; null sinon.")
    lignes: list[LigneDeCommande]
    total_lu: int | None = Field(description="Le total écrit sur le bon, en FCFA, recopié sans calcul ; null sinon.")
    remarques: list[str] = Field(description="Les passages illisibles, ambigus ou inhabituels du document.")


class LigneDeFacture(BaseModel):
    designation: str = Field(description="La désignation telle qu'elle est écrite.")
    quantite: int | None = Field(ge=1, description="La quantité facturée ; null si illisible.")
    prix_unitaire: int | None = Field(description="Le prix unitaire écrit, dans la devise de la facture ; null sinon.")
    montant: int | None = Field(description="Le montant de la ligne tel qu'il est écrit ; null sinon.")
    lisibilite: Lisibilite


class Facture(BaseModel):
    type_document: Literal["facture", "autre"]
    fournisseur: str | None = Field(description="Le nom du fournisseur ; null s'il est illisible.")
    numero: str | None = Field(description="Le numéro de la facture ; null s'il n'y en a pas.")
    date_lue: str | None = Field(description="La date de la facture telle qu'elle est écrite ; null sinon.")
    lignes: list[LigneDeFacture]
    total_lu: int | None = Field(description="Le total à payer écrit sur la facture, sans calcul ; null sinon.")
    devise: str | None = Field(description="La devise écrite sur la facture (par exemple FCFA) ; null sinon.")
    remarques: list[str] = Field(description="Les passages illisibles, ambigus ou inhabituels du document.")


CONSIGNES = {
    BonDeCommande: "Voici la photo d'un bon de commande reçue sur WhatsApp. Extrais-en les données.",
    Facture: "Voici une facture de fournisseur. Extrais-en les données.",
}


# --- La requête --------------------------------------------------------------------------


def prompt_extraction(version: str = "v1", donnees: dict | None = None) -> PromptSysteme:
    modele = Template((DOSSIER / "prompts" / f"extraction_{version}.md").read_text(encoding="utf-8"))
    texte = modele.substitute(catalogue=rendre_catalogue(donnees or charger_donnees()))
    return PromptSysteme(texte.strip(), f"extraction-{version}")


def verifier_compatibilite(requete: dict) -> None:
    """Citations et sorties structurées ne se combinent pas : l'API répondrait par une erreur 400."""
    format_impose = "format" in requete.get("output_config", {})
    citations = any(
        isinstance(bloc, dict) and bloc.get("citations", {}).get("enabled")
        for message in requete["messages"]
        if isinstance(message["content"], list)
        for bloc in message["content"]
    )
    if format_impose and citations:
        raise ValueError("Citations et sorties structurées ne se combinent pas : choisissez l'une ou l'autre.")


def requete_extraction(blocs: list[dict], schema: type[BaseModel], prompt: PromptSysteme | None = None) -> dict:
    prompt = prompt or prompt_extraction()
    output_config = {"format": {"type": "json_schema", "schema": transform_schema(schema)}}
    if config.EFFORT:
        output_config["effort"] = config.EFFORT
    requete = {
        "model": config.MODELE,
        "max_tokens": MAX_TOKENS,
        "system": prompt.texte,
        # Le document d'abord, la consigne ensuite : c'est l'ordre recommandé.
        "messages": [{"role": "user", "content": [*blocs, {"type": "text", "text": CONSIGNES[schema]}]}],
        "output_config": output_config,
    }
    verifier_compatibilite(requete)
    return requete


# --- L'appel et ses issues ---------------------------------------------------------------


@dataclass
class Extraction:
    donnees: BaseModel | None
    erreur: str | None
    stop_reason: str | None
    cout: Cout
    identifiant: str | None


def extraire(client, blocs: list[dict], schema: type[BaseModel], prompt: PromptSysteme | None = None) -> Extraction:
    """Appelle Claude et rend des données validées, ou une erreur explicite. Jamais une donnée douteuse
    sans le dire.

    On n'utilise pas client.messages.parse() : en cas de refus ou de réponse coupée, il lève
    une exception avant de rendre le message, et l'appel, pourtant payé, échappe au journal.
    """
    prompt = prompt or prompt_extraction()
    requete = requete_extraction(blocs, schema, prompt)
    message = client.messages.create(**requete)
    prix = cout(requete["model"], message.usage)
    noter(message._request_id, requete["model"], prix, prompt=prompt.identifiant)

    def echec(raison: str) -> Extraction:
        return Extraction(None, raison, message.stop_reason, prix, message._request_id)

    # Le schéma n'est garanti que si la réponse est allée au bout normalement.
    if message.stop_reason == "refusal":
        return echec("Claude a refusé de traiter ce document.")
    if message.stop_reason == "max_tokens":
        return echec("Réponse coupée avant la fin : augmentez max_tokens ou découpez le document.")
    texte = "".join(b.text for b in message.content if b.type == "text")
    try:
        return Extraction(schema.model_validate_json(texte), None, message.stop_reason, prix, message._request_id)
    except ValidationError as erreur:
        champs = ", ".join(".".join(str(p) for p in e["loc"]) for e in erreur.errors())
        return echec(f"Réponse refusée par la validation du code ({champs}).")


# --- Les contrôles métier ----------------------------------------------------------------


@dataclass
class Controle:
    anomalies: list[str] = field(default_factory=list)
    montant_calcule: int | None = None  # calculé par le code, jamais par le modèle

    @property
    def a_relire(self) -> bool:
        return bool(self.anomalies)


def controler_bon(bon: BonDeCommande, donnees: dict | None = None) -> Controle:
    prix = {p["nom"]: p["prix_fcfa"] for p in (donnees or charger_donnees())["produits"]}
    controle = Controle()
    if bon.type_document != "bon_de_commande":
        controle.anomalies.append("Ce document n'est pas un bon de commande.")
        return controle
    if not bon.lignes:
        controle.anomalies.append("Aucune ligne de commande lue.")

    complet = bool(bon.lignes)
    total = 0
    for rang, ligne in enumerate(bon.lignes, start=1):
        nom = f"Ligne {rang} (« {ligne.libelle_lu} »)"
        if ligne.lisibilite != "lisible":
            controle.anomalies.append(f"{nom} : lecture {ligne.lisibilite}.")
        if ligne.produit is None or ligne.produit not in prix:
            controle.anomalies.append(f"{nom} : produit absent du catalogue ou incertain.")
            complet = False
            continue
        if ligne.quantite is None:
            controle.anomalies.append(f"{nom} : quantité illisible.")
            complet = False
            continue
        if ligne.prix_unitaire_lu is not None and ligne.prix_unitaire_lu != prix[ligne.produit]:
            controle.anomalies.append(
                f"{nom} : prix écrit {ligne.prix_unitaire_lu} FCFA, catalogue {prix[ligne.produit]} FCFA."
            )
        total += ligne.quantite * prix[ligne.produit]

    if complet:
        controle.montant_calcule = total
        if bon.total_lu is not None and bon.total_lu != total:
            controle.anomalies.append(f"Total écrit {bon.total_lu} FCFA, total calculé {total} FCFA.")
    controle.anomalies.extend(f"Remarque de lecture : {r}" for r in bon.remarques)
    return controle


def controler_facture(facture: Facture) -> Controle:
    controle = Controle()
    if facture.type_document != "facture":
        controle.anomalies.append("Ce document n'est pas une facture.")
        return controle
    if facture.devise and facture.devise.upper() not in ("FCFA", "XOF", "F CFA"):
        controle.anomalies.append(f"Devise inhabituelle : {facture.devise}.")

    complet = bool(facture.lignes)
    total = 0
    for rang, ligne in enumerate(facture.lignes, start=1):
        nom = f"Ligne {rang} (« {ligne.designation} »)"
        if ligne.lisibilite != "lisible":
            controle.anomalies.append(f"{nom} : lecture {ligne.lisibilite}.")
        if ligne.quantite is None or ligne.prix_unitaire is None:
            controle.anomalies.append(f"{nom} : quantité ou prix illisible.")
            complet = False
            continue
        attendu = ligne.quantite * ligne.prix_unitaire
        if ligne.montant is not None and ligne.montant != attendu:
            controle.anomalies.append(f"{nom} : montant écrit {ligne.montant}, calculé {attendu}.")
        total += attendu

    if complet:
        controle.montant_calcule = total
        if facture.total_lu is not None and facture.total_lu != total:
            controle.anomalies.append(f"Total écrit {facture.total_lu}, total calculé {total}.")
    controle.anomalies.extend(f"Remarque de lecture : {r}" for r in facture.remarques)
    return controle


def schema_pour(chemin: str | Path) -> type[BaseModel]:
    """Le Comptoir range ses exemples par nom : bon-*.jpg, facture-*.pdf."""
    return Facture if Path(chemin).name.startswith("facture") else BonDeCommande
