"""Chapitre 20 : les hooks, les Skills, les sous-agents, le plugin et les workflows du Comptoir.
Aucun appel à l'API : les hooks tournent sur des événements fabriqués, dans des dépôts Git temporaires."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON = Path(__file__).resolve().parents[1]           # le dossier python/, racine du projet
DEPOT = PYTHON.parent                                    # tome-2/code, le futur dépôt d'accompagnement
HOOKS = PYTHON / ".claude" / "hooks"
# Une clé au format réel, construite à l'exécution : écrite d'un bloc ici, elle bloquerait le commit de ce fichier.
CLE = "sk-ant-" + "api03-" + "Zx9" * 12


def hook(nom: str, evenement: dict, racine: Path = PYTHON, **env) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HOOKS / f"{nom}.py")], input=json.dumps(evenement).encode("utf-8"),
                          capture_output=True, env={**os.environ, "CLAUDE_PROJECT_DIR": str(racine), **env})


def decision(resultat: subprocess.CompletedProcess) -> tuple[str, str] | None:
    sortie = resultat.stdout.decode("utf-8").strip()
    if not sortie:
        return None
    donnees = json.loads(sortie)["hookSpecificOutput"]
    return donnees["permissionDecision"], donnees["permissionDecisionReason"]


def depot_git(tmp_path: Path) -> Path:
    for commande in (["init", "-q"], ["config", "user.email", "yao@exemple.test"], ["config", "user.name", "Yao"],
                     ["config", "core.autocrlf", "false"]):
        subprocess.run(["git", *commande], cwd=tmp_path, check=True)
    (tmp_path / "comptoir.py").write_text("def total():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "départ"], cwd=tmp_path, check=True)
    return tmp_path


def commit(depot: Path, commande: str = "git commit -m essai") -> subprocess.CompletedProcess:
    return hook("garde_secrets", {"tool_name": "Bash", "tool_input": {"command": commande}, "cwd": str(depot)})


# --- Le garde des fichiers -----------------------------------------------------------------------------

def test_une_version_publiee_de_prompt_ne_se_modifie_pas_mais_la_suivante_s_ecrit():
    existante = {"tool_name": "Edit", "tool_input": {"file_path": str(PYTHON / "comptoir/prompts/systeme_v5.md"),
                                                    "old_string": "a", "new_string": "b"}}
    nature, raison = decision(hook("garde_fichiers", existante))
    assert nature == "deny" and "systeme_v6.md" in raison
    neuve = {"tool_name": "Write", "tool_input": {"file_path": str(PYTHON / "comptoir/prompts/systeme_v99.md"),
                                                 "content": "Nouvelle version"}}
    assert decision(hook("garde_fichiers", neuve)) is None


@pytest.mark.parametrize("contenu, refuse", [
    ("client = anthropic.Anthropic()", True),
    ("client = creer_client()", True),
    ('AsyncAnthropic(api_key="x", base_url="https://api.anthropic.com")', True),
    ('AsyncAnthropic(api_key="cle-factice", base_url=f"http://127.0.0.1:{port}", max_retries=0)', False),  # chapitre 6
    ("client = FauxClient(texte('Bonjour'))", False),
])
def test_un_test_n_appelle_jamais_l_api(contenu, refuse):
    evenement = {"tool_name": "Write", "tool_input": {"file_path": str(PYTHON / "tests/test_nouveau.py"),
                                                     "content": contenu}}
    resultat = decision(hook("garde_fichiers", evenement))
    assert (resultat is not None and resultat[0] == "deny") is refuse
    # Hors de tests/, le même code est permis : c'est le Comptoir.
    evenement["tool_input"]["file_path"] = str(PYTHON / "comptoir/appel.py")
    assert decision(hook("garde_fichiers", evenement)) is None


def test_une_modification_des_prix_est_confirmee_par_yao():
    evenement = {"tool_name": "Edit", "tool_input": {"file_path": str(PYTHON / "comptoir/couts.py"),
                                                    "old_string": "0.10", "new_string": "0.12"}}
    nature, raison = decision(hook("garde_fichiers", evenement))
    assert nature == "ask" and "source datée" in raison


# --- Le garde des secrets ------------------------------------------------------------------------------

def test_une_cle_indexee_bloque_le_commit_sans_etre_recopiee(tmp_path):
    depot = depot_git(tmp_path)
    (depot / "reglages.py").write_text(f'CLE = "{CLE}"\n', encoding="utf-8")
    subprocess.run(["git", "add", "reglages.py"], cwd=depot, check=True)
    resultat = commit(depot)
    message = resultat.stderr.decode("utf-8")
    assert resultat.returncode == 2 and "reglages.py:1" in message and "clé d'API Anthropic" in message
    assert CLE not in message  # le message montre le début, jamais la clé


def test_un_fichier_env_bloque_le_commit_mais_pas_l_exemple(tmp_path):
    depot = depot_git(tmp_path)
    (depot / ".env.exemple").write_text("ANTHROPIC_API_KEY=remplacez-moi\n", encoding="utf-8")
    subprocess.run(["git", "add", ".env.exemple"], cwd=depot, check=True)
    assert commit(depot).returncode == 0
    (depot / ".env").write_text("ANTHROPIC_API_KEY=une-vraie-valeur-de-cle\n", encoding="utf-8")
    subprocess.run(["git", "add", ".env"], cwd=depot, check=True)
    resultat = commit(depot)
    assert resultat.returncode == 2 and "fichier de secrets" in resultat.stderr.decode("utf-8")


def test_les_fichiers_que_la_commande_ajoute_elle_meme_sont_lus(tmp_path):
    depot = depot_git(tmp_path)
    (depot / "notes.txt").write_text(f"ma cle : {CLE}\n", encoding="utf-8")  # pas encore indexé
    assert commit(depot, "git commit -m seul").returncode == 0           # ce commit ne l'emporte pas
    assert commit(depot, "git add -A && git commit -m tout").returncode == 2
    assert commit(depot, f"git commit -m '{CLE}'").returncode == 2        # ni dans le message


@pytest.mark.parametrize("ligne", [
    'TABLEAU_JETON = os.environ.get("COMPTOIR_TABLEAU_JETON", "")',     # une lecture, pas une valeur
    'SECRET, VERIFICATION, SEL, JETON = "secret-de-test", "verif", "sel", "j"',  # valeurs de test
    'r = poster(http, message, secret="un-autre-secret")',              # un argument, pas une constante
    'monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-cle-de-test")',    # pas le format d'une vraie clé
])
def test_le_code_ordinaire_ne_bloque_rien(tmp_path, ligne):
    depot = depot_git(tmp_path)
    (depot / "module.py").write_text(ligne + "\n", encoding="utf-8")
    subprocess.run(["git", "add", "module.py"], cwd=depot, check=True)
    assert commit(depot).returncode == 0


def test_une_autre_commande_que_git_commit_passe(tmp_path):
    depot = depot_git(tmp_path)
    (depot / "notes.txt").write_text(f"{CLE}\n", encoding="utf-8")
    subprocess.run(["git", "add", "notes.txt"], cwd=depot, check=True)
    assert commit(depot, "git status").returncode == 0


# --- Le hook de fin de tour ----------------------------------------------------------------------------

def fin_de_tour(depot: Path, code: int) -> subprocess.CompletedProcess:
    commande = f'"{sys.executable}" -c "import sys; print(\'1 failed\'); sys.exit({code})"'
    return hook("fin_de_tour", {"hook_event_name": "Stop", "stop_hook_active": False}, racine=depot,
                COMPTOIR_HOOK_TESTS=commande)


def test_des_tests_rouges_empechent_claude_de_rendre_la_main(tmp_path):
    depot = depot_git(tmp_path)
    assert fin_de_tour(depot, 1).stdout == b""                 # rien n'a changé : pas de tests
    (depot / "comptoir.py").write_text("def total():\n    return 2\n", encoding="utf-8")
    sortie = json.loads(fin_de_tour(depot, 1).stdout.decode("utf-8"))
    assert sortie["decision"] == "block" and "1 failed" in sortie["reason"]
    assert fin_de_tour(depot, 0).stdout == b""                 # vert : l'empreinte est notée
    assert fin_de_tour(depot, 1).stdout == b""                 # même état : la suite ne repasse pas
    (depot / "nouveau.py").write_text("x = 1\n", encoding="utf-8")
    assert json.loads(fin_de_tour(depot, 1).stdout.decode("utf-8"))["decision"] == "block"


def test_le_journal_des_outils_note_la_commande_mais_jamais_le_contenu(tmp_path):
    hook("journal_outils", {"session_id": "s1", "tool_name": "Write",
                            "tool_input": {"file_path": "notes.md", "content": "un contenu privé"}}, racine=tmp_path)
    hook("journal_outils", {"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "python -m pytest -q"},
                            "tool_response": {"stdout": "452 passed"}}, racine=tmp_path)
    lignes = [json.loads(l) for l in (tmp_path / ".claude/journal-outils.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(l["outil"], l["cible"]) for l in lignes] == [("Write", "notes.md"), ("Bash", "python -m pytest -q")]
    assert "privé" not in json.dumps(lignes, ensure_ascii=False) and "452" not in json.dumps(lignes)


# --- La configuration : réglages, Skills, sous-agents, plugin ------------------------------------------

def entete(chemin: Path) -> dict:
    """Les champs simples de l'en-tête YAML d'un fichier Markdown (clé: valeur)."""
    texte = chemin.read_text(encoding="utf-8")
    assert texte.startswith("---\n"), chemin
    bloc = texte.split("---\n", 2)[1]
    return {m.group(1): m.group(2).strip().strip('"') for m in re.finditer(r"^([a-zA-Z-]+):\s*(.*)$", bloc, re.M)}


def test_chaque_hook_des_reglages_pointe_vers_un_script_qui_existe():
    reglages = json.loads((PYTHON / ".claude/settings.json").read_text(encoding="utf-8"))
    commandes = [h["command"] for groupes in reglages["hooks"].values() for g in groupes for h in g["hooks"]]
    assert commandes
    for commande in commandes:
        nom = re.search(r"lancer\.sh\" (\w+)$", commande).group(1)
        assert (HOOKS / f"{nom}.py").exists(), nom
    assert "Bash(python -m ch*)" in reglages["permissions"]["ask"]  # les scripts payants demandent toujours


def test_les_skills_et_les_sous_agents_sont_complets():
    skills = {d.name: entete(d / "SKILL.md") for d in (PYTHON / ".claude/skills").iterdir()}
    agents = {f.stem: entete(f) for f in (PYTHON / ".claude/agents").glob("*.md")}
    assert set(skills) == {"verify", "relecture", "nouvelle-variante", "non-regression"}
    assert all(s.get("description") for s in skills.values())
    # Les Skills qui coûtent, ou qui ont un effet, ne se lancent que sur demande.
    assert skills["non-regression"]["disable-model-invocation"] == "true"
    assert skills["nouvelle-variante"]["disable-model-invocation"] == "true"
    assert skills["relecture"]["context"] == "fork" and skills["relecture"]["agent"] in agents
    assert all(a.get("name") and a.get("description") and a.get("tools") for a in agents.values())
    assert "Edit" not in agents["relecteur"]["tools"] and "Write" not in agents["relecteur"]["tools"]


def test_les_regles_par_dossier_visent_des_fichiers_qui_existent():
    for regle in (PYTHON / ".claude/rules").glob("*.md"):
        motifs = re.findall(r'^\s+- "([^"]+)"', regle.read_text(encoding="utf-8"), re.M)
        assert motifs, regle.name
        assert all(list(PYTHON.glob(m)) for m in motifs), regle.name


def test_le_plugin_reprend_le_garde_du_comptoir_et_declare_sa_dependance():
    marche = DEPOT / "outils-claude"
    catalogue = json.loads((marche / ".claude-plugin/marketplace.json").read_text(encoding="utf-8"))
    for entree in catalogue["plugins"]:
        manifeste = json.loads((marche / entree["source"] / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
        assert manifeste["name"] == entree["name"]
    relecture = json.loads((marche / "plugins/relecture/.claude-plugin/plugin.json").read_text(encoding="utf-8"))
    assert relecture["dependencies"] == ["garde-secrets"]
    copie = marche / "plugins/garde-secrets/scripts/garde_secrets.py"
    assert copie.read_bytes() == (HOOKS / "garde_secrets.py").read_bytes()  # une seule version du garde


# --- Les workflows -------------------------------------------------------------------------------------

def test_les_workflows_n_ont_aucune_cle_et_bornent_ce_qui_coute():
    tests = (DEPOT / ".github/workflows/tests.yml").read_text(encoding="utf-8")
    claude = (DEPOT / ".github/workflows/claude.yml").read_text(encoding="utf-8")
    assert "secrets." not in tests + claude                       # fédération d'identité, aucune clé stockée
    assert "id-token" not in tests and "anthropic" not in tests.lower()  # les tests n'ont pas accès à Claude
    assert claude.count("id-token: write") == 2
    # Ni copie du dépôt (fork) ni brouillon ; un plafond de dépense ; une durée maximale pour chaque job.
    assert claude.count("github.event.pull_request.head.repo.full_name == github.repository") == 2
    assert "--budget-max 0.3" in claude and "--max-turns" in claude
    assert claude.count("timeout-minutes:") == 2 and tests.count("timeout-minutes:") == 1
    # La consigne du relecteur vient de main, pas de la demande de fusion qu'il relit.
    assert 'git checkout "origin/${{ github.base_ref }}" -- "$chemin"' in claude
