"""Les limites du Comptoir sur le web (chapitre 18) : qui envoie, combien, et quelle taille.

Le budget du chapitre 8 compte par conversation : un script qui ouvre une conversation neuve à chaque
message ne le voit jamais revenir. Il vide le budget du jour, et les vrais clients reçoivent « le
Comptoir ne peut pas répondre ». L'audit du chapitre 18 l'a fait : 512 messages, depuis une seule
adresse, avant le refus. D'où trois limites par adresse réseau, devant le budget :
- des messages par minute : une rafale s'arrête ;
- des conversations neuves par heure : le contournement du quota par client s'arrête ;
- un quota en dollars par jour (comptoir/budget.py, groupe) : une adresse ne prend jamais tout le jour.

Une adresse n'est pas une personne : derrière celle d'un opérateur mobile, il y a souvent beaucoup
d'abonnés. Les limites sont larges, faites pour un script ; l'identité solide viendra du numéro de
téléphone, avec WhatsApp (chapitre 19).

Les compteurs vivent en mémoire : un redémarrage les remet à zéro, ce qui est acceptable pour arrêter
une rafale. Le quota en dollars, lui, est dans la base du budget.
"""

import threading
import time
from collections import defaultdict, deque


class Limiteur:
    """Une fenêtre glissante par clé : au plus `maximum` événements pendant `fenetre_s` secondes."""

    def __init__(self, maximum: int, fenetre_s: float, horloge=time.monotonic):
        self.maximum, self.fenetre_s, self._horloge = maximum, fenetre_s, horloge
        self._evenements: dict[str, deque] = defaultdict(deque)
        self._verrou = threading.Lock()

    def accepter(self, cle: str) -> float | None:
        """None si l'événement est accepté (et compté) ; sinon, le nombre de secondes à attendre."""
        maintenant = self._horloge()
        with self._verrou:
            file = self._evenements[cle]
            while file and file[0] <= maintenant - self.fenetre_s:
                file.popleft()
            if len(file) >= self.maximum:
                return round(file[0] + self.fenetre_s - maintenant, 1)
            file.append(maintenant)
            return None


def adresse_du_client(hote: str | None, transfere_pour: str | None, proxies_de_confiance: list[str]) -> str:
    """L'adresse du client. Derrière un relais de confiance (Caddy), c'est la dernière adresse que ce relais a
    ajoutée à X-Forwarded-For ; sans relais de confiance, l'en-tête est ignoré : n'importe qui peut l'écrire."""
    if hote in proxies_de_confiance and transfere_pour:
        return transfere_pour.split(",")[-1].strip()
    return hote or "inconnue"
