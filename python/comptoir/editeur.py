"""L'outil éditeur de texte d'Anthropic, exécuté par votre code dans un dossier fermé (chapitre 10).

Anthropic définit l'outil (text_editor_20250728, nommé str_replace_based_edit_tool) : son
schéma, et la façon dont Claude s'en sert. Votre code l'exécute. Il a donc toutes les
responsabilités d'un accès à des fichiers : rester dans son dossier, refuser un
remplacement ambigu, sauvegarder avant de modifier.
"""

from pathlib import Path

OUTIL = {"type": "text_editor_20250728", "name": "str_replace_based_edit_tool", "max_characters": 20000}


class RefusEditeur(Exception):
    pass


class Editeur:
    def __init__(self, racine: str | Path):
        self.racine = Path(racine).resolve()

    def _chemin(self, chemin: str) -> Path:
        """Un chemin relatif, qui reste dans la racine. Pas de « .. », pas de chemin absolu."""
        candidat = (self.racine / chemin).resolve()
        if Path(chemin).is_absolute() or not candidat.is_relative_to(self.racine):
            raise RefusEditeur(f"Error: Path outside the allowed folder: {chemin}")
        return candidat

    def _sauvegarder(self, fichier: Path) -> None:
        if fichier.exists():
            fichier.with_name(fichier.name + ".backup").write_text(fichier.read_text(encoding="utf-8"), encoding="utf-8")

    def executer(self, entree: dict) -> str:
        commande = entree.get("command")
        fichier = self._chemin(entree["path"])
        if commande == "view":
            if fichier.is_dir():
                return "\n".join(sorted(p.relative_to(self.racine).as_posix() for p in fichier.iterdir()))
            if not fichier.exists():
                raise RefusEditeur("Error: File not found")
            lignes = fichier.read_text(encoding="utf-8").splitlines()
            debut, fin = entree.get("view_range") or [1, -1]
            fin = len(lignes) if fin == -1 else fin
            # Des numéros de ligne, pour que Claude puisse viser une insertion.
            return "\n".join(f"{n}: {lignes[n - 1]}" for n in range(debut, fin + 1) if 0 < n <= len(lignes))
        if commande == "str_replace":
            if not fichier.exists():
                raise RefusEditeur("Error: File not found")
            contenu = fichier.read_text(encoding="utf-8")
            nombre = contenu.count(entree["old_str"])
            if nombre == 0:
                raise RefusEditeur("Error: No match found for replacement. Please check your text and try again.")
            if nombre > 1:
                raise RefusEditeur(f"Error: Found {nombre} matches for replacement text. "
                                   "Please provide more context to make a unique match.")
            self._sauvegarder(fichier)
            fichier.write_text(contenu.replace(entree["old_str"], entree["new_str"]), encoding="utf-8")
            return "Successfully replaced text at exactly one location."
        if commande == "create":
            if fichier.exists():
                raise RefusEditeur("Error: File already exists. Use str_replace to modify it.")
            fichier.parent.mkdir(parents=True, exist_ok=True)
            fichier.write_text(entree["file_text"], encoding="utf-8")
            return f"File created: {entree['path']}"
        if commande == "insert":
            if not fichier.exists():
                raise RefusEditeur("Error: File not found")
            lignes = fichier.read_text(encoding="utf-8").splitlines(keepends=True)
            position = entree["insert_line"]
            if not 0 <= position <= len(lignes):
                raise RefusEditeur(f"Error: insert_line must be between 0 and {len(lignes)}.")
            self._sauvegarder(fichier)
            texte = entree["insert_text"] if entree["insert_text"].endswith("\n") else entree["insert_text"] + "\n"
            fichier.write_text("".join(lignes[:position] + [texte] + lignes[position:]), encoding="utf-8")
            return f"Text inserted after line {position}."
        raise RefusEditeur(f"Error: Unknown command {commande!r}.")

    def resultat(self, appel) -> dict:
        """Un bloc tool_use de l'éditeur en entrée, un tool_result en sortie."""
        try:
            return {"type": "tool_result", "tool_use_id": appel.id, "content": self.executer(appel.input)}
        except (RefusEditeur, KeyError, UnicodeDecodeError) as erreur:
            return {"type": "tool_result", "tool_use_id": appel.id, "content": str(erreur), "is_error": True}
