"""Lire le journal : coûts, modes d'échec, latences, conversations à reprendre (chapitre 8).

Le journal est la trace de chaque appel. Bien lu, il répond aux questions de Yao :
combien a coûté la journée, qu'est-ce qui échoue et d'où ça vient, qui attend encore une
réponse d'Awa.

Chapitre 19 : le Comptoir en ligne laisse un événement « message » par message (comptoir/service.py),
avec le coût de toutes ses étapes et sa durée. Le tableau en tire le coût par conversation, la latence
vue par le client, le taux d'erreur, les événements de sécurité du chapitre 18 et des alertes.
"""

import html
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir import config

# Ce qui laisse un client sans réponse : Awa doit reprendre la conversation à la main.
SANS_REPONSE = {"refus", "hors_budget", "comptage_impossible", "cle_invalide", "facturation", "permission",
                "introuvable", "requete_invalide", "limite_de_depense", "plafond_du_palier", "contexte_plein"}


def charger(chemin: str | None = None) -> list[dict]:
    fichier = Path(chemin or config.JOURNAL)
    if not fichier.exists():
        return []
    return [json.loads(l) for l in fichier.read_text(encoding="utf-8").splitlines() if l.strip()]


# Les événements qui ne sont pas des échecs d'appel : ils ont leur propre rubrique (chapitres 18 et 19).
INFORMATIFS = {"message", "etape", "purge", "garde", "limite", "tentative_suspecte", "whatsapp_envoi",
               "whatsapp_signature_invalide", "surveillance"}


def est_un_echec(ligne: dict) -> bool:
    """Un appel ou un message en erreur, un envoi refusé, ou un événement qui n'est pas une information.
    Une étape en erreur appartient à un message : elle est comptée avec lui, pas deux fois."""
    evenement = ligne.get("evenement")
    if evenement is None or evenement in ("message", "whatsapp_envoi"):
        return bool(ligne.get("erreur"))
    return evenement not in INFORMATIFS


def par_jour(lignes: list[dict]) -> dict[str, dict]:
    jours: dict[str, dict] = defaultdict(lambda: {"appels": 0, "dollars": 0.0, "entree": 0, "sortie": 0, "echecs": 0})
    for ligne in lignes:
        jour = jours[ligne["date"][:10]]
        if "evenement" in ligne:
            jour["echecs"] += est_un_echec(ligne)
            continue
        jour["appels"] += 1
        jour["dollars"] += ligne.get("cout_dollars") or 0.0
        jour["entree"] += (ligne.get("tokens_entree") or 0) + (ligne.get("tokens_lecture_cache") or 0)
        jour["sortie"] += ligne.get("tokens_sortie") or 0
        jour["echecs"] += 1 if ligne.get("erreur") else 0
    return dict(sorted(jours.items()))


def modes_d_echec(lignes: list[dict]) -> Counter:
    """(origine, code) -> nombre. L'origine dit qui doit agir : le réseau, le service, notre code…"""
    compte = Counter()
    for ligne in lignes:
        if est_un_echec(ligne):
            compte[(ligne.get("origine") or "compte", ligne.get("erreur") or ligne.get("evenement"))] += 1
    return compte


def centile(valeurs: list[float], rang: float) -> float | None:
    if not valeurs:
        return None
    ordonnees = sorted(valeurs)
    return ordonnees[min(len(ordonnees) - 1, round(rang / 100 * (len(ordonnees) - 1)))]


def latences(lignes: list[dict]) -> tuple[float | None, float | None]:
    """Médiane et 95e centile de la durée des appels réussis, en millisecondes."""
    durees = [l["duree_ms"] for l in lignes if "duree_ms" in l and not l.get("erreur") and "evenement" not in l]
    return centile(durees, 50), centile(durees, 95)


def a_reprendre(lignes: list[dict]) -> list[dict]:
    """Les conversations restées sans réponse, que Awa doit reprendre elle-même."""
    return [
        {"date": l["date"], "conversation": l.get("client") or l.get("conversation"),
         "motif": l.get("erreur") or l.get("evenement")}
        for l in lignes
        if (l.get("erreur") or l.get("evenement")) in SANS_REPONSE
    ]


# --- Le Comptoir en ligne (chapitre 19) -------------------------------------------------------------

def messages(lignes: list[dict]) -> list[dict]:
    return [l for l in lignes if l.get("evenement") == "message"]


def par_conversation(lignes: list[dict]) -> dict[str, dict]:
    """conversation -> canal, nombre de messages, coût total. Toutes étapes comprises, d'après la trace, et
    la surveillance du chapitre 18 quand elle est activée (chapitre 20)."""
    conversations: dict[str, dict] = defaultdict(lambda: {"canal": "", "messages": 0, "dollars": 0.0})
    for l in messages(lignes):
        c = conversations[l.get("conversation", "?")]
        c["canal"], c["messages"] = l.get("canal", ""), c["messages"] + 1
        c["dollars"] += l.get("cout_dollars") or 0.0
    for l in lignes:
        if l.get("evenement") == "surveillance" and l.get("conversation") in conversations:
            conversations[l["conversation"]]["dollars"] += l.get("cout_dollars") or 0.0
    return dict(conversations)


def cout_par_conversation(lignes: list[dict]) -> dict:
    totaux = [c["dollars"] for c in par_conversation(lignes).values()]
    if not totaux:
        return {"conversations": 0, "moyenne": None, "mediane": None}
    return {"conversations": len(totaux), "moyenne": sum(totaux) / len(totaux), "mediane": centile(totaux, 50)}


def latences_messages(lignes: list[dict]) -> tuple[float | None, float | None]:
    """Médiane et 90e centile de la durée d'un message, toutes étapes comprises : ce que le client attend."""
    durees = [l["duree_ms"] for l in messages(lignes) if "duree_ms" in l and not l.get("erreur")]
    return centile(durees, 50), centile(durees, 90)


def taux_d_erreur(lignes: list[dict]) -> float | None:
    tous = messages(lignes)
    return sum(1 for l in tous if l.get("erreur")) / len(tous) if tous else None


def evenements(lignes: list[dict]) -> Counter:
    """Les événements de sécurité et d'exploitation, par nom (chapitres 18 et 19)."""
    return Counter(l["evenement"] for l in lignes
                   if l.get("evenement") in {"garde", "limite", "tentative_suspecte", "hors_budget", "purge",
                                             "whatsapp_signature_invalide"}
                   or (l.get("evenement") == "whatsapp_envoi" and l.get("erreur")))


def recidivistes(lignes: list[dict], seuil: int = 3) -> list[tuple[str, int]]:
    """Les conversations signalées au moins `seuil` fois par la surveillance : à regarder de près."""
    compte = Counter(l.get("conversation") for l in lignes if l.get("evenement") == "tentative_suspecte")
    return [(c, n) for c, n in compte.most_common() if n >= seuil]


def alertes(lignes: list[dict], maintenant: datetime | None = None) -> list[str]:
    """Ce qui doit faire réagir Awa ou Yao, sur les dernières 24 heures."""
    instant = maintenant or datetime.now(timezone.utc)
    recentes = [l for l in lignes if l.get("date", "") >= (instant - timedelta(hours=24)).isoformat(timespec="seconds")]
    sortie = []
    depense = sum(l.get("cout_dollars") or 0.0 for l in recentes if l.get("evenement") in ("message", "surveillance"))
    if depense >= config.SEUIL_ALERTE * config.BUDGET_JOUR:
        sortie.append(f"Dépense des dernières 24 heures : {depense:.2f} $, pour un plafond du jour de {config.BUDGET_JOUR:.2f} $.")
    taux = taux_d_erreur(recentes)
    if taux is not None and len(messages(recentes)) >= 10 and taux > 0.05:
        sortie.append(f"{taux:.0%} des messages des dernières 24 heures ont échoué.")
    if any(l.get("evenement") == "hors_budget" for l in recentes):
        sortie.append("Des clients ont reçu « le Comptoir ne peut pas répondre » faute de budget.")
    for conversation, n in recidivistes(recentes):
        sortie.append(f"La conversation {conversation[:8]}… a été signalée {n} fois par la surveillance.")
    if any(l.get("evenement") == "whatsapp_non_configure" for l in recentes):
        sortie.append("WhatsApp n'est pas configuré (le sel des empreintes manque) : les messages attendent chez Meta.")
    if any(l.get("evenement") in ("whatsapp_envoi", "whatsapp_traitement") and l.get("erreur") for l in recentes):
        sortie.append("Des messages WhatsApp sont restés sans réponse : envoi refusé ou traitement impossible.")
    return sortie


def en_html(lignes: list[dict]) -> str:
    """Une page autonome, sans bibliothèque ni appel réseau, à ouvrir dans un navigateur."""
    jours = par_jour(lignes)
    plus_cher = max((j["dollars"] for j in jours.values()), default=0) or 1
    rangees = "".join(
        f"<tr><td>{jour}</td><td>{j['appels']}</td><td>{j['dollars']:.4f} $</td>"
        f"<td>{j['dollars'] * config.TAUX_FCFA:.0f} FCFA</td><td>{j['echecs']}</td>"
        f"<td><div class='barre' style='width:{100 * j['dollars'] / plus_cher:.0f}%'></div></td></tr>"
        for jour, j in jours.items()
    )
    echecs = "".join(f"<tr><td>{html.escape(o)}</td><td>{html.escape(c)}</td><td>{n}</td></tr>"
                     for (o, c), n in modes_d_echec(lignes).most_common())
    reprendre = "".join(f"<tr><td>{html.escape(r['date'])}</td><td>{html.escape(str(r['conversation']))}</td>"
                        f"<td>{html.escape(r['motif'])}</td></tr>" for r in a_reprendre(lignes))
    mediane, p95 = latences(lignes)
    conv = cout_par_conversation(lignes)
    med_msg, p90_msg = latences_messages(lignes)
    taux = taux_d_erreur(lignes)
    duree_msg = (f"médiane {med_msg:.0f} ms, 90e centile {p90_msg:.0f} ms" if med_msg is not None
                 else "aucun message réussi")
    en_ligne = (f"<p>{conv['conversations']} conversation{'s' if conv['conversations'] > 1 else ''} ; coût moyen {conv['moyenne']:.4f} $, médian "
                f"{conv['mediane']:.4f} $ ; un message : {duree_msg} ; "
                f"erreurs : {taux:.1%}.</p>" if conv["conversations"] else "<p>Aucun message en ligne pour l'instant.</p>")
    # Les appels du Comptoir aiguillé n'ont pas de durée dans le journal (elle est sur les étapes) : rien à afficher.
    latence_appels = (f"médiane {mediane:.0f} ms, 95e centile {p95:.0f} ms" if mediane is not None
                      else "aucune durée d'appel dans le journal")
    alarmes = "".join(f"<li>{html.escape(a)}</li>" for a in alertes(lignes)) or "<li>Aucune.</li>"
    securite = "".join(f"<tr><td>{html.escape(nom)}</td><td>{n}</td></tr>" for nom, n in evenements(lignes).most_common())
    return f"""<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Le Comptoir : tableau de bord</title>
<style>body{{font-family:system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem;color:#2b2118;background:#fdf8f3}}
table{{border-collapse:collapse;width:100%;margin-bottom:1.5rem}}td,th{{border-bottom:1px solid #ead9c8;padding:.35rem;text-align:left}}
.barre{{background:#d9772b;height:.8rem;border-radius:.2rem}}</style></head><body>
<h1>Le Comptoir : tableau de bord</h1>
<h2>Alertes (24 heures)</h2><ul>{alarmes}</ul>
<h2>En ligne</h2>{en_ligne}
<h2>Sécurité et exploitation</h2><table><tr><th>Événement</th><th>Nombre</th></tr>{securite}</table>
<p>Latence des appels réussis : {latence_appels}.</p>
<h2>Par jour</h2><table><tr><th>Jour</th><th>Appels</th><th>Coût</th><th></th><th>Échecs</th><th></th></tr>{rangees}</table>
<h2>Modes d'échec</h2><table><tr><th>Origine</th><th>Code</th><th>Nombre</th></tr>{echecs}</table>
<h2>Conversations à reprendre par Awa</h2><table><tr><th>Date</th><th>Conversation</th><th>Motif</th></tr>{reprendre}</table>
</body></html>"""
