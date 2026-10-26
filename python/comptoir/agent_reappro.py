"""L'agent de réapprovisionnement : une boucle d'agent encadrée (chapitre 13).

Claude lit les ventes, le stock, les événements, les fiches et les messages des fournisseurs,
fait calculer les besoins par un outil, puis propose un bon de commande. Il choisit lui-même ce
qu'il lit et dans quel ordre : c'est un agent. Le code l'encadre :
- un nombre de tours, un budget en dollars et un délai, vérifiés entre deux appels ;
- en option, un budget de tâche (en bêta), pour que Claude règle lui-même son effort ;
- un seul outil qui écrit, et il n'écrit qu'un projet : le bon est vérifié par le code et reste
  « à valider par Awa » ; rien n'est envoyé ;
- une trace : chaque appel et chaque outil, avec sa durée et son coût ;
- en option : la lecture des messages confiée à un sous-agent, une mémoire d'une semaine à
  l'autre, l'effacement des anciens résultats d'outils.
"""

import json
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import TypedDict

from anthropic import beta_tool
from anthropic.tools import BetaLocalFilesystemMemoryTool, ToolError

from comptoir import config
from comptoir.atelier import Atelier, Bon, BonInvalide, rendre_bon
from comptoir.couts import Cout, cout
from comptoir.journal import noter
from comptoir.trace import Trace

PROMPTS = Path(__file__).parent / "prompts"
SYSTEME = (PROMPTS / "reappro_v2.md").read_text(encoding="utf-8").strip()
LECTEUR = (PROMPTS / "lecteur_v1.md").read_text(encoding="utf-8").strip()
CONSIGNE = "Nous sommes le lundi 19 octobre 2026, 7 h. Prépare le projet de bon de commande de la semaine."
MODELE_LECTEUR = config.MODELE_AUXILIAIRE  # Claude Haiku 5.5 : lire et résumer, sans outils

BETA_BUDGET_DE_TACHE = "task-budgets-2026-03-13"
BETA_CONTEXTE = "context-management-2025-06-27"
BETA_COMPACTION = "compact-2026-09-04"


class LigneBon(TypedDict):
    article: str
    fournisseur: str
    quantite: float
    livraison_souhaitee: str


@dataclass
class Reglages:
    modele: str = config.MODELE
    effort: str | None = None
    sous_agent: bool = True                  # la lecture des messages confiée à Claude Haiku 5.5
    memoire: Path | None = None              # un dossier : l'outil mémoire, d'une semaine à l'autre
    budget_de_tache: int | None = None       # en tokens, 20 000 au moins (bêta)
    effacer_resultats_apres: int | None = None  # tokens d'entrée au-delà desquels les vieux résultats s'effacent
    compacter_apres_tour: int | None = None     # résumer la séance après ce tour (compaction à la demande, bêta)
    max_tokens: int = 8000


@dataclass
class Garde:
    """Les limites que le code vérifie entre deux appels : on s'arrête avant de payer le suivant."""
    tours_max: int = 20
    budget_dollars: float = 0.50
    delai_s: float = 300.0
    tours: int = 0
    depense: float = 0.0
    debut: float = field(default_factory=time.perf_counter)

    def raison_d_arret(self) -> str | None:
        if self.depense >= self.budget_dollars:
            return f"budget de {self.budget_dollars:.2f} $ atteint ({self.depense:.4f} $)"
        if time.perf_counter() - self.debut >= self.delai_s:
            return f"délai de {self.delai_s:.0f} s dépassé"
        if self.tours >= self.tours_max:
            return f"{self.tours_max} tours atteints"
        return None


@dataclass
class Resultat:
    texte: str
    bon: Bon | None
    arret: str | None            # None : l'agent a terminé de lui-même
    tours: int
    depense: float
    duree_s: float
    pic_contexte: int            # la plus grosse requête de la séance, en tokens d'entrée
    outils: list[str]
    cout_sous_agent: float
    effacements: list[dict]
    trace: Trace


@dataclass
class Contexte:
    client: object
    atelier: Atelier
    garde: Garde
    trace: Trace
    bon: Bon | None = None
    outils: list[str] = field(default_factory=list)
    cout_sous_agent: float = 0.0


def lire_par_sous_agent(client, messages: str, question: str) -> tuple[str, float]:
    """Le sous-agent : Claude Haiku 5.5, sans outils, avec les messages et une question. Son contexte est
    à lui : l'agent principal ne reçoit que la réponse, pas les milliers de mots qu'il a fallu lire."""
    requete = {"model": MODELE_LECTEUR, "max_tokens": 1000, "thinking": {"type": "disabled"}, "system": LECTEUR,
               "messages": [{"role": "user", "content": [
                   # Les messages ne changent pas d'une question à l'autre : en cache.
                   {"type": "text", "text": f"<messages>\n{messages}\n</messages>", "cache_control": {"type": "ephemeral"}},
                   {"type": "text", "text": f"<question>{question}</question>"}]}]}
    reponse = client.messages.create(**requete)
    prix = cout(MODELE_LECTEUR, reponse.usage)
    noter(reponse._request_id, MODELE_LECTEUR, prix, prompt="lecteur-v1", stop_reason=reponse.stop_reason)
    texte = "".join(b.text for b in reponse.content if b.type == "text").strip()
    if reponse.stop_reason != "end_turn" or not texte:
        raise ToolError(f"Lecture interrompue (arrêt : {reponse.stop_reason}). Repose une question plus précise.")
    return texte, prix.dollars


def creer_outils(ctx: Contexte, reglages: Reglages) -> list:
    atelier = ctx.atelier

    @beta_tool
    def lire_ventes() -> str:
        """Renvoie les ventes habituelles des huit dernières semaines, produit par produit et semaine par semaine,
        leurs moyennes calculées par le code, et à part les commandes d'événement passées. À lire pour prévoir la
        production des deux semaines qui viennent."""
        with ctx.trace.etape("lire_ventes") as e:
            ctx.outils.append("lire_ventes")
            e.noter(0, "8 semaines")
            return atelier.resume_ventes()

    @beta_tool
    def lire_stock() -> str:
        """Renvoie le stock de ce matin : les produits finis (bouteilles et flacons prêts à vendre) et les articles
        (ingrédients et emballages), dans l'unité de leurs fiches."""
        with ctx.trace.etape("lire_stock") as e:
            ctx.outils.append("lire_stock")
            e.noter(0, "stock du matin")
            return json.dumps({k: v for k, v in atelier.stock().items() if k != "_note"}, ensure_ascii=False)

    @beta_tool
    def lire_evenements() -> str:
        """Renvoie les commandes d'événement à venir, avec leur date, leurs bouteilles et leur statut : confirmé
        (acompte versé) ou simple devis."""
        with ctx.trace.etape("lire_evenements") as e:
            ctx.outils.append("lire_evenements")
            e.noter(0, f"{len(atelier.evenements())} événements")
            return json.dumps(atelier.evenements(), ensure_ascii=False)

    @beta_tool
    def lire_fournisseurs() -> str:
        """Renvoie les fiches des fournisseurs : pour chaque article, qui le vend, le délai habituel de livraison en
        jours, le minimum de commande, le conditionnement et le prix unitaire en FCFA. Les fiches ne mentionnent ni
        les ruptures, ni les retards exceptionnels, ni les hausses de prix annoncées : voir les messages."""
        with ctx.trace.etape("lire_fournisseurs") as e:
            ctx.outils.append("lire_fournisseurs")
            e.noter(0, f"{len(atelier.offres())} offres")
            return json.dumps(atelier.offres(), ensure_ascii=False)

    @beta_tool
    def calculer_besoins(production: dict[str, int]) -> str:
        """Calcule, pour une production de bouteilles et de flacons, les articles nécessaires (ingrédients et
        emballages), le stock de chaque article, ce qui manque, et la quantité à commander chez chaque fournisseur
        selon ses fiches (minimum et conditionnement). Ne tient compte ni des ruptures ni des délais : le choix du
        fournisseur et de la date te revient.

        Args:
            production: Le nombre de bouteilles ou de flacons à produire, par produit, avec les noms exacts des
                produits, par exemple {"Jus de bissap": 90}. Retire les produits finis déjà en stock.
        """
        with ctx.trace.etape("calculer_besoins") as e:
            ctx.outils.append("calculer_besoins")
            try:
                besoins = atelier.besoins(production)
            except ValueError as erreur:
                raise ToolError(str(erreur)) from erreur
            e.noter(0, f"{sum(production.values())} unités à produire")
            return json.dumps(besoins, ensure_ascii=False)

    @beta_tool
    def deleguer_lecture_messages(question: str) -> str:
        """Confie la lecture des messages WhatsApp des fournisseurs (deux mois, plusieurs milliers de mots) à un
        assistant de lecture, qui répond à ta question en quelques phrases datées. À utiliser pour connaître les
        ruptures, retards, délais exceptionnels, hausses de prix et arrivages annoncés par les fournisseurs. Une
        question précise donne une réponse précise ; tu peux en poser plusieurs.

        Args:
            question: Ce que tu veux savoir, par exemple : « Quels fournisseurs annoncent une rupture ou un retard ? »
        """
        with ctx.trace.etape("lecture_messages", MODELE_LECTEUR) as e:
            ctx.outils.append("deleguer_lecture_messages")
            reponse, prix = lire_par_sous_agent(ctx.client, atelier.messages_fournisseurs(), question)
            ctx.garde.depense += prix
            ctx.cout_sous_agent += prix
            e.noter(prix, f"{len(reponse.split())} mots")
            return reponse

    @beta_tool
    def lire_messages_fournisseurs() -> str:
        """Renvoie tous les messages WhatsApp des fournisseurs des deux derniers mois, du plus ancien au plus récent
        (plusieurs milliers de mots). On y trouve les ruptures, retards, délais exceptionnels, hausses de prix et
        arrivages, qui ne figurent pas dans les fiches."""
        with ctx.trace.etape("lire_messages") as e:
            ctx.outils.append("lire_messages_fournisseurs")
            texte = atelier.messages_fournisseurs()
            e.noter(0, f"{len(texte.split())} mots")
            return texte

    @beta_tool
    def proposer_bon_de_commande(lignes: list[LigneBon], justification: str, alertes: list[str]) -> str:
        """Enregistre le projet de bon de commande de la semaine, à valider par Awa. Rien n'est envoyé aux
        fournisseurs. Le code vérifie chaque ligne avec les fiches (le fournisseur vend-il l'article, minimum,
        conditionnement, délai) et le plafond d'Awa, puis calcule les montants. Si une règle n'est pas respectée,
        le bon est refusé avec la liste des erreurs : corrige-le et propose-le à nouveau. Un nouveau bon remplace
        le précédent.

        Args:
            lignes: Les lignes du bon : l'article et le fournisseur écrits exactement comme dans les fiches, la
                quantité dans l'unité de la fiche, et la date de livraison souhaitée au format AAAA-MM-JJ.
            justification: Pour Awa, en quelques phrases : la production prévue, les choix de fournisseurs et de dates.
            alertes: Ce qu'Awa doit savoir : ruptures à prévoir, retards, hausses de prix, messages suspects,
                incertitudes. Une liste vide s'il n'y en a pas.
        """
        with ctx.trace.etape("proposer_bon") as e:
            ctx.outils.append("proposer_bon_de_commande")
            try:
                bon = atelier.proposer([dict(ligne) for ligne in lignes], justification, alertes)
            except BonInvalide as erreur:
                e.noter(0, f"refusé, {len(erreur.erreurs)} erreurs")
                raise ToolError("Bon refusé : " + " ; ".join(erreur.erreurs)) from erreur
            if ctx.bon is not None:
                atelier.retirer(ctx.bon.code, bon.code)
            ctx.bon = bon
            e.noter(0, f"{bon.code}, {bon.total_fcfa} FCFA")
            return rendre_bon(bon) + "\nLe bon attend la validation d'Awa."

    outils = [lire_ventes, lire_stock, lire_evenements, lire_fournisseurs, calculer_besoins,
              deleguer_lecture_messages if reglages.sous_agent else lire_messages_fournisseurs,
              proposer_bon_de_commande]
    if reglages.memoire is not None:
        outils.append(BetaLocalFilesystemMemoryTool(base_path=str(reglages.memoire)))
    return outils


def options_de_requete(reglages: Reglages) -> dict:
    """Les options de la requête selon les réglages : budget de tâche, effort, effacement des résultats."""
    options, betas, sortie = {}, [], {}
    if reglages.effort:
        sortie["effort"] = reglages.effort
    if reglages.budget_de_tache:
        betas.append(BETA_BUDGET_DE_TACHE)
        sortie["task_budget"] = {"type": "tokens", "total": reglages.budget_de_tache}
    if sortie:
        options["output_config"] = sortie
    if reglages.compacter_apres_tour:
        betas.append(BETA_COMPACTION)
    if reglages.effacer_resultats_apres:
        betas.append(BETA_CONTEXTE)
        options["context_management"] = {"edits": [{
            "type": "clear_tool_uses_20250919",
            "trigger": {"type": "input_tokens", "value": reglages.effacer_resultats_apres},
            "keep": {"type": "tool_uses", "value": 3},
            "exclude_tools": ["proposer_bon_de_commande"],  # le dernier état du bon reste visible
        }]}
    if betas:
        options["betas"] = betas
    return options


def cout_du_message(modele: str, message) -> Cout:
    """Le coût d'un message du runner. Une compaction n'a rien dans les champs du haut de usage : son
    coût est dans usage.iterations, qu'il faut additionner (documentation de la compaction)."""
    iterations = getattr(message.usage, "iterations", None)
    if message.stop_reason == "compaction" and iterations:
        parts = [cout(modele, iteration) for iteration in iterations]
        return Cout(*(sum(getattr(p, champ.name) for p in parts) for champ in fields(Cout)))
    return cout(modele, message.usage)


def lancer(client, atelier: Atelier, reglages: Reglages | None = None, garde: Garde | None = None) -> Resultat:
    """Une séance de l'agent, du premier appel au bon proposé, ou jusqu'à une limite."""
    reglages, garde = reglages or Reglages(), garde or Garde()
    ctx = Contexte(client, atelier, garde, Trace())
    runner = client.beta.messages.tool_runner(
        model=reglages.modele, max_tokens=reglages.max_tokens, max_iterations=garde.tours_max, system=SYSTEME,
        tools=creer_outils(ctx, reglages), messages=[{"role": "user", "content": CONSIGNE}],
        cache_control={"type": "ephemeral"},  # le cache automatique : chaque tour relit le précédent
        **options_de_requete(reglages))

    arret, dernier, pic, effacements = None, None, 0, []
    instant, deja = time.perf_counter(), 0
    for message in runner:  # un message par appel à Claude ; les outils tournent entre deux messages
        garde.tours += 1
        prix = cout_du_message(reglages.modele, message)
        garde.depense += prix.dollars
        noter(getattr(message, "_request_id", None), reglages.modele, prix, prompt="reappro-v2",
              stop_reason=message.stop_reason)
        u = message.usage
        pic = max(pic, (u.input_tokens or 0) + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0))
        gestion = getattr(message, "context_management", None)
        if gestion is not None and gestion.applied_edits:
            effacements += [e.model_dump() for e in gestion.applied_edits]
        # La durée de l'appel : le temps écoulé, moins celui des outils exécutés entre-temps (déjà tracés).
        maintenant = time.perf_counter()
        outils_ms = sum(e.duree_ms for e in ctx.trace.etapes[deja:])
        appels = [b.name for b in message.content if b.type == "tool_use"]
        ctx.trace.ajouter(f"tour {garde.tours}", reglages.modele, max(0, round((maintenant - instant) * 1000) - outils_ms),
                          prix.dollars, ", ".join(appels) or str(message.stop_reason))
        instant, deja, dernier = maintenant, len(ctx.trace.etapes), message
        if reglages.compacter_apres_tour == garde.tours and message.stop_reason == "tool_use":
            runner.compact_before_next_turn()  # après les outils de ce tour, l'historique devient un résumé
        if message.stop_reason == "tool_use":
            arret = garde.raison_d_arret()
            if arret:
                break  # aucun outil de ce tour n'est exécuté : rien n'est à moitié fait
    if dernier is not None and dernier.stop_reason == "tool_use" and arret is None:
        arret = f"{garde.tours_max} tours atteints"  # le runner s'est arrêté de lui-même, à max_iterations
    texte = "".join(b.text for b in dernier.content if b.type == "text").strip() if dernier else ""
    return Resultat(texte, ctx.bon, arret, garde.tours, garde.depense, time.perf_counter() - garde.debut, pic,
                    ctx.outils, ctx.cout_sous_agent, effacements, ctx.trace)
