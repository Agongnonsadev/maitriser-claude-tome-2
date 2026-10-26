"""Chapitre 21 : estimer ce que coûtera, chaque mois, un assistant comme le Comptoir pour un client.

Depuis le dossier python/ (gratuit, aucun appel) :
    python -m ch21.estimer_projet --messages 1500 --whatsapp --hebergement 7
    python -m ch21.estimer_projet --messages 1500 --cout-message 0.0009

Une estimation, pas une mesure : elle part des prix unitaires mesurés dans ce livre, pour une application qui
ressemble au Comptoir (Claude Haiku 5.5, outils, cache, réclamations rédigées par Claude Sonnet 5.5). Pour
une autre application, mesurez d'abord son coût par message (chapitre 19), puis passez-le en --cout-message.
L'hébergement n'a pas été mesuré dans ce livre : c'est à vous de le donner.
"""

import argparse
import sys
from dataclasses import dataclass

from comptoir import config

# Chapitre 19 : huit conversations types, trois essais, le 22 octobre 2026 (0,00075 $ par message).
COUT_PAR_MESSAGE = 0.00075
# Chapitre 19 : tarif d'un message de service WhatsApp, région « Reste de l'Afrique », relevé le 22 octobre 2026,
# et les 1 000 messages de service gratuits par mois et par numéro.
TARIF_WHATSAPP, GRATUITS_WHATSAPP = 0.0040, 1000
MARGE = 0.5  # chapitre 1 : la moitié en plus, pour ce que la mesure n'a pas vu (pics, conversations longues)


@dataclass
class Estimation:
    claude: float
    claude_avec_marge: float
    whatsapp: float
    hebergement: float | None

    @property
    def total(self) -> float | None:
        return None if self.hebergement is None else self.claude_avec_marge + self.whatsapp + self.hebergement


def estimer(messages: int, cout_message: float = COUT_PAR_MESSAGE, whatsapp: bool = False,
            tarif_whatsapp: float = TARIF_WHATSAPP, hebergement: float | None = None) -> Estimation:
    claude = messages * cout_message
    canal = max(0, messages - GRATUITS_WHATSAPP) * tarif_whatsapp if whatsapp else 0.0
    return Estimation(claude, claude * (1 + MARGE), canal, hebergement)


def en_texte(e: Estimation, messages: int) -> str:
    def ligne(nom, dollars):
        if dollars is None:
            return f"{nom:<38} [à mesurer]"
        return f"{nom:<38} {dollars:8.2f} $  {dollars * config.TAUX_FCFA:8.0f} FCFA  {dollars * config.TAUX_EUR:7.2f} €"
    lignes = [f"Pour {messages} messages par mois :",
              ligne("Claude (prix unitaire mesuré)", e.claude),
              ligne(f"Claude, avec {MARGE:.0%} de marge", e.claude_avec_marge),
              ligne("WhatsApp (messages de service)", e.whatsapp),
              ligne("Hébergement", e.hebergement),
              ligne("Total par mois", e.total)]
    if e.total is not None and messages:
        lignes.append(f"{'Par message':<38} {e.total / messages:8.4f} $")
    return "\n".join(lignes)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--messages", type=int, required=True, help="messages de clients par mois")
    parser.add_argument("--cout-message", type=float, default=COUT_PAR_MESSAGE, help="en dollars, mesuré pour votre application")
    parser.add_argument("--whatsapp", action="store_true", help="les clients écrivent sur WhatsApp")
    parser.add_argument("--tarif-whatsapp", type=float, default=TARIF_WHATSAPP, help="en dollars, pour votre pays")
    parser.add_argument("--hebergement", type=float, help="en dollars par mois")
    args = parser.parse_args()
    print(en_texte(estimer(args.messages, args.cout_message, args.whatsapp, args.tarif_whatsapp, args.hebergement),
                   args.messages))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
