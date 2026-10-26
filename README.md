# Le Comptoir d'Awa — code d'accompagnement du Tome 2

Code des exemples de *Maîtriser Claude, Tome 2 — Développer avec Claude* (Botlyx Academy). Le Comptoir, Awa, Yao et Délices d'Awa sont fictifs.

C'est le dépôt d'accompagnement du livre. Son adresse est donnée sur la page d'accompagnement, academy.botlyx.com/livres/tome-2, avec les mises à jour du livre.

Le code est publié sous licence MIT (fichier `LICENSE`) : vous pouvez le reprendre dans vos projets, même commerciaux, en gardant la mention de copyright. Le texte du livre n'est pas concerné.

## Organisation

```
python/
├── pyproject.toml      ← le paquet « comptoir » et ses dépendances (SDK anthropic 2.x depuis le chapitre 21)
├── CLAUDE.md           ← la mémoire du projet pour Claude Code (chapitre 4)
├── .claude/            ← Claude Code pour le Comptoir : settings.json (permissions, chapitre 4 ; hooks, chapitre 20), hooks/ (garde des fichiers, garde des secrets, journal des outils, tests en fin de tour), rules/ (tests, prompts, coûts), skills/ (verify, relecture, nouvelle-variante, non-regression), agents/ (relecteur, testeur, documentaliste) (chapitre 20)
├── comptoir/           ← le code commun, qui grandit chapitre après chapitre
│   ├── config.py       ← réglages lus dans l'environnement (modèle, taux, journal)
│   ├── couts.py        ← usage → dollars, FCFA, euros (chapitre 2)
│   ├── journal.py      ← une ligne JSON par appel, sans clé ni message (chapitre 2)
│   ├── notation.py     ← noter une réponse avec des critères écrits à l'avance (chapitre 3)
│   ├── prompt.py       ← le prompt système versionné, rempli par le code (chapitre 5)
│   ├── prompts/        ← les versions du prompt système (systeme_v1.md…)
│   ├── donnees/        ← le catalogue et les conditions d'Awa (fictifs) ; atelier/ : ventes, stock, fournisseurs, messages (chapitre 13)
│   ├── connaissances/  ← la base de connaissances d'Awa : FAQ, conditions, fiches, zones, événements (fictifs)
│   ├── assistant.py    ← le Comptoir : requête, message client balisé, consignes d'Awa (chapitre 5)
│   ├── evaluation.py   ← comparer des variantes sur un jeu de cas (chapitre 5)
│   ├── conversations.py ← l'historique des conversations, en ajout seul (chapitre 6)
│   ├── flux.py         ← streamer, garder, reprendre une réponse coupée (chapitre 6)
│   ├── web.py          ← le Comptoir sur le web : FastAPI, SSE, WebSocket (chapitre 6) ; taille maximale, même en morceaux (chapitres 18 et 19)
│   ├── pages/          ← la page du chat (chapitre 6)
│   ├── documents.py    ← images et PDF pour Claude, et leur coût en tokens (chapitre 7)
│   ├── extraction.py   ← bons et factures en données validées : schéma, code, contrôles (chapitre 7)
│   ├── exactitude.py   ← mesurer un extracteur champ par champ (chapitre 7)
│   ├── erreurs.py      ← chaque erreur : réessayer ou corriger, et d'où elle vient (chapitre 8)
│   ├── budget.py       ← plafonds par client, par jour, par mois, avec réservation (chapitre 8)
│   ├── appel.py        ← l'appel robuste : comptage, réservation, journal, diagnostic (chapitre 8)
│   ├── tableau.py      ← lire le journal : coûts, modes d'échec, conversations à reprendre (chapitre 8) ; coût par conversation, latence, alertes (chapitre 19)
│   ├── boutique.py     ← stock, récapitulatifs, commandes, demandes à Awa (chapitre 9)
│   ├── outils.py       ← les trois outils du Comptoir et leur exécution (chapitre 9)
│   ├── boucle.py       ← la boucle d'outils écrite à la main (chapitre 9)
│   ├── commandes.py    ← récapitulatif officiel et confirmation par code (chapitre 9)
│   ├── serveur.py      ← recherche web, lecture de pages, exécution de code : définitions et lecture des réponses (chapitre 10)
│   ├── editeur.py      ← l'éditeur de texte d'Anthropic, exécuté dans un dossier fermé (chapitre 10)
│   ├── ventes.py       ← les totaux de la semaine, calculés par notre code (chapitre 10)
│   ├── connaissances.py ← la base découpée en morceaux citables, en blocs search_result (chapitre 11)
│   ├── recherche.py    ← BM25, embeddings, fusion des rangs, reclassement et contexte par Claude (chapitre 11)
│   ├── documentaire.py ← répondre à partir des documents, avec les sources, et noter la réponse (chapitre 11)
│   ├── routeur.py      ← l'aiguilleur : le code d'abord, puis Claude Haiku 5.5, une catégorie parmi quatre (chapitre 12)
│   ├── trace.py        ← une trace par message : chaque étape, son modèle, sa durée, son coût (chapitre 12)
│   ├── reclamations.py ← la chaîne des réclamations : extraire, vérifier, transmettre, rédiger, évaluer (chapitre 12)
│   ├── aiguillage.py   ← le Comptoir aiguillé : un gestionnaire écrit dans le code, trois services (chapitre 12)
│   ├── atelier.py      ← l'atelier d'Awa : ventes, besoins, contrôle et total d'un bon de commande, par le code (chapitre 13)
│   ├── agent_reappro.py ← l'agent de réapprovisionnement : outils, sous-agent, garde-fous, Tool Runner (chapitre 13)
│   ├── garde.py        ← ce que le code vérifie quoi qu'écrive le modèle : transmissions annoncées, nom et quartier (chapitre 18)
│   ├── limites.py      ← limites par adresse réseau : messages par minute, conversations par heure (chapitre 18)
│   ├── surveillance.py ← le filtre du chapitre 18 en signal : il note les messages suspects, ne bloque rien (chapitre 19)
│   ├── service.py      ← le Comptoir livré derrière ses canaux : conversation en base, budget par message, journal (chapitre 19)
│   ├── whatsapp.py     ← WhatsApp : signature, messages reçus, envoi par l'API de Meta, annuaire des numéros (chapitre 19)
│   └── en_ligne.py     ← le serveur de production : chat web, webhook WhatsApp, tableau de bord, santé (chapitre 19)
├── decisions/         ← les décisions écrites, avec leurs mesures (modele.md, chapitre 3 ; audit-securite.md, chapitre 18 ; optimisation.md, chapitre 19 ; sdk-2.md, chapitre 21)
├── docs/               ← pour exploiter et faire évoluer le Comptoir sans son auteur : exploitation.md (alertes, opérations, incidents), migration.md (modèle, SDK, API) (chapitre 21)
├── ch02/               ← les scripts du chapitre 2
├── ch03/               ← la comparaison des modèles (cas.json, comparer_modeles.py, lister_modeles.py)
├── ch05/               ← l'évaluation des prompts v0 et v1 (cas.json, evaluer_prompt.py, consigne_en_cours.py)
├── ch06/               ← les événements d'un flux, trois clients en parallèle
├── ch07/               ← extraire, valider, mesurer, citer ; documents/ : exemples fictifs et valeurs attendues
├── ch08/               ← provoquer les erreurs, le Comptoir robuste, le tableau de bord
├── ch09/               ← le Comptoir qui prend des commandes, le Tool Runner, les 10 scénarios
├── ch10/               ← veille, lecture de pages, rapport hebdomadaire (PDF et Excel), correction de FAQ
├── ch11/               ← questions aux documents, cache avant et après, diagnostic, recherche, évaluation, Comptoir avec la base
├── ch12/               ← 30 messages de test, l'aiguilleur mesuré, réflexion et citations, ordre des champs, réclamations, Comptoir aiguillé
├── ch13/               ← données de l'atelier, critères, l'agent et son évaluation, validation par Awa, Agent SDK, Managed Agents, planification
├── ch14/               ← copie anonymisée des commandes, DBHub en lecture seule (dbhub.toml), explorateur de serveurs, questions à Claude Code, connecteur MCP, question du soir ; mcp/ : serveurs MCP tiers, versions figées
├── .mcp.json          ← le serveur MCP des commandes, branché dans Claude Code pour tout le projet (chapitre 14)
├── ch15/               ← le serveur MCP « Comptoir pour Awa », son extension de bureau (construire_extension.py), les essais avec Claude Code ; outils/ : inspecteur MCP et CLI mcpb, versions figées
├── ch16/               ← le Comptoir en ligne (serveur_en_ligne.py), son serveur d'autorisation OAuth (autorisation.py), un client OAuth, un client brut, l'API par le connecteur ; deploiement/ : Dockerfile, compose.yaml, Caddyfile, dépendances figées avec empreintes
├── ch17/               ← la suite d'évaluation : 60 cas (cas.json), banc d'essai, notation par le code, juge et ses grilles, étalonnage sur des notes humaines (page de notation), comparaison, registre, non-régression ; resultats/ : séries, transcriptions, registre
├── ch18/               ← l'audit de sécurité : cinq attaques contre Claude (attaques.json, attaquer.py), l'injection vue du côté d'Awa (cote_awa.py), un filtre d'entrée mesuré (filtre.py), cinq attaques contre le code et deux contrôles (audit_code.py), purge et effacement des données (donnees.py) ; resultats/ : séries et audits
├── ch19/               ← le coût par conversation et ses leviers (conversations.json, mesurer_cout.py), le résumé du soir en direct ou par lot (resume_du_soir.py), le juge par lot (juger_par_lot.py) ; deploiement/ : Dockerfile, compose.yaml, Caddyfile, .env.exemple, sauvegarder.sh, restaurer.sh (chapitre 21), dépendances figées avec empreintes ; resultats/ : coûts et résumés
├── ch21/               ← la veille des modèles, du SDK et de la version de l'API (veille.py), l'estimation d'un projet (estimer_projet.py)
└── tests/              ← tests sans appel payant (faux client)
outils-claude/          ← une place de marché de plugins pour Claude Code (outils-yao) : garde-secrets (le hook du Comptoir) et relecture (un sous-agent et /relecture:relire, qui dépend de garde-secrets) (chapitre 20)
.github/workflows/      ← tests.yml (les tests et l'audit à chaque push, gratuit) ; tests-typescript.yml (la même chose pour la version TypeScript, types compris) ; claude.yml (non-régression et relecture par Claude sur chaque demande de fusion, par la fédération d'identité, sans clé stockée) (chapitre 20) ; veille.yml (la veille, chaque lundi, gratuite, pour les deux versions) (chapitre 21)
typescript/             ← l'équivalent TypeScript, chapitre après chapitre (SDK @anthropic-ai/sdk) ; fait : tous les chapitres, 2 à 21
├── package.json        ← le SDK officiel ; TypeScript, tsx et les types de Node pour développer
├── CLAUDE.md           ← la mémoire du projet pour Claude Code (chapitre 4), avec ses outils (chapitre 20)
├── .claude/            ← Claude Code pour cette version : settings.json (permissions, chapitre 4 ; hooks, chapitre 20), hooks/ (les quatre hooks du chapitre 20, en TypeScript sans dépendance, que Node lance seul), rules/, skills/ (verify, relecture, nouvelle-variante, non-regression), agents/ (relecteur, testeur, documentaliste)
├── comptoir/           ← le même code commun qu'en Python : config.ts, couts.ts, journal.ts, notation.ts, prompt.ts, assistant.ts, evaluation.ts, conversations.ts, flux.ts, web.ts (Hono à la place de FastAPI), documents.ts (sharp à la place de Pillow), extraction.ts (Zod à la place de Pydantic), exactitude.ts, sorties.ts (le schéma JSON des sorties structurées, comme transform_schema en Python), tableau.ts, boutique.ts, outils.ts, boucle.ts, commandes.ts, serveur.ts, editeur.ts, ventes.ts, difference.ts (difflib.unified_diff, même algorithme), recherche.ts, documentaire.ts, routeur.ts, trace.ts, reclamations.ts, aiguillage.ts, atelier.ts, agent_reappro.ts (le Tool Runner du SDK), garde.ts et limites.ts (chapitre 18), connaissances.ts (chapitre 11), erreurs.ts, budget.ts, appel.ts (chapitre 8), surveillance.ts, service.ts, whatsapp.ts et en_ligne.ts (le serveur de production, avec Hono, chapitre 19) ; client.ts (ce que le code attend du client du SDK), csv.ts (les fichiers de résultats, au format de Python), arrondi.ts et python.ts (round, repr, ==, sum, statistics.mean, json.dumps et json.loads, :g et repr d'un float de Python, pour les mêmes résultats et le même texte envoyé à Claude), hasard.ts (random.Random de Python : les mêmes tirages, chapitre 17), base.ts (SQLite intégré à Node), dates.ts (les dates comme `date.fromisoformat`), lancement.ts
├── ch02/ … ch16/       ← les mêmes scripts qu'en Python, aux mêmes noms ; les documents d'exemple du chapitre 7, l'export des ventes du chapitre 10, les données de l'atelier du chapitre 13 et l'historique des commandes du chapitre 14 sont ceux de la version Python, que fabriquent python/ch07/fabriquer_exemples.py, python/ch10/fabriquer_ventes.py, python/ch13/fabriquer_donnees.py et python/ch14/fabriquer_commandes.py (pas d'équivalent TypeScript : ils ne se fabriquent qu'une fois) ; au chapitre 14, les serveurs MCP sont ceux de python/ch14/mcp/, lancés depuis le dossier python/, et le client MCP est le SDK officiel @modelcontextprotocol/sdk ; au chapitre 15, le serveur est écrit avec ce même SDK, l'extension est de type « node » (esbuild réunit le serveur, le SDK MCP et Zod en un seul fichier) et se valide et s'empaquette avec le CLI mcpb de python/ch15/outils ; la base d'essai est celle de python/donnees_clients/ ; au chapitre 16, les adresses OAuth sont celles du SDK MCP, servies par Express, et le serveur s'arrête à la révision 2025-11-25 du protocole ; deploiement/ : Dockerfile (les sources lancées par tsx), compose.yaml, Caddyfile, dépendances figées avec empreintes (package-lock.json)
├── ch17/ … ch21/       ← les mêmes scripts qu'en Python, aux mêmes noms ; les cas (cas.json), la liste de non-régression, les grilles du juge et la page de notation du chapitre 17, les attaques du chapitre 18 et les conversations types du chapitre 19 sont ceux de python/, communs aux deux versions ; les séries, le registre et les résultats vont dans le chNN/resultats/ de cette version, aux formats de la version Python (une série de l'une se relit, se résume et se compare avec l'autre) ; au chapitre 18, le côté d'Awa lance le serveur MCP du chapitre 15 de cette version ; ch19/deploiement/ : Dockerfile (les sources lancées par tsx, les données d'Awa par un contexte de construction nommé), compose.yaml, Caddyfile, .env.exemple, sauvegarder.sh, restaurer.sh, dépendances figées avec empreintes (package-lock.json)
└── tests/              ← les mêmes tests sans appel payant (faux client), avec le lanceur de tests de Node, et des comparaisons à la version Python (sautées si python/.venv manque)
```

Les données communes aux deux langages (cas d'évaluation, catalogue, prompts) restent dans `python/` : la version TypeScript les y lit, pour qu'il n'en existe qu'une copie.

## Installer

Python 3.10 ou plus récent. Depuis le dossier `python/` :

```bash
python -m venv .venv
# Windows : .venv\Scripts\Activate.ps1   —   macOS, Linux : source .venv/bin/activate
pip install -e ".[tests]"
pip install -e ".[agents]"   # le Claude Agent SDK, pour le chapitre 13 seulement
pip install -e ".[mcp]"      # le client MCP et anthropic[mcp], pour le chapitre 14
cd ch14/mcp && npm ci && cd ../..   # les serveurs MCP du chapitre 14 (Node 22.5 ou plus)
cd ch15/outils && npm ci && cd ../..   # l'inspecteur MCP et mcpb, pour le chapitre 15 (Node 22.19 ou plus)
pip install uv                     # pour empaqueter l'extension du chapitre 15
python -m pytest
```

Les tests n'appellent jamais l'API et ne coûtent rien.

En TypeScript : Node 22.13 ou plus récent (son module SQLite intégré, sans option depuis cette version). Depuis le dossier `typescript/` :

```bash
npm ci
npm test            # les tests, sans appel payant
npm run typecheck   # la vérification des types
```

`npm ci` installe aussi le Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, version fixée) et le binaire de Claude Code pour votre plateforme : 285 Mo sous Windows. Seul `ch13/avec_agent_sdk.ts` s'en sert. Pour empaqueter l'extension du chapitre 15 (`--paquet`), il faut aussi le CLI mcpb de la version Python : `npm ci` dans `python/ch15/outils`.

## Lancer les exemples

La clé d'API se pose dans la variable d'environnement `ANTHROPIC_API_KEY`, jamais dans le code. Puis, depuis `python/` :

```bash
python -m ch02.appel_http
python -m ch02.premier_appel
python -m ch02.comptoir_cli "Combien coûte le sirop de gingembre ?"
python -m ch02.compter_tokens
python -m ch03.lister_modeles
python -m ch03.comparer_modeles --estimer
python -m ch03.comparer_modeles --repetitions 3 --budget-max 2
python -m ch05.evaluer_prompt --estimer
python -m ch05.evaluer_prompt --repetitions 3 --budget-max 1
python -m ch05.evaluer_prompt --renoter   # gratuit : renote les réponses déjà obtenues
python -m ch05.consigne_en_cours
python -m ch06.evenements "Quels jus avez-vous ?"
python -m ch06.trois_clients
python -m uvicorn comptoir.web:app --reload   # puis http://127.0.0.1:8000
python -m ch07.extraire ch07/documents/bon-01.jpg --estimer
python -m ch07.extraire ch07/documents/bon-02.jpg
python -m ch07.valider_commandes ch07/documents/bon-01.jpg
python -m ch07.mesurer_exactitude --repetitions 3 --budget-max 0.5
python -m ch07.citer_conditions "Sous quel délai dois-je signaler une casse ?"
python -m ch08.provoquer_erreurs
python -m ch08.comptoir_robuste "Combien coûtent 6 bouteilles de bissap ?" --client essai-1
python -m ch08.tableau_de_bord --html journal/tableau.html
python -m ch09.comptoir_commandes
python -m ch09.avec_tool_runner
python -m ch09.jouer_scenarios --budget-max 0.5
python -m ch10.veille "Quels sont les jours fériés au Bénin en novembre et décembre 2026 ?"
python -m ch10.lire_page --max-tokens-lus 2000 https://fr.wikipedia.org/wiki/Bissap "Résume en trois phrases."
python -m ch10.rapport_hebdo
python -m ch10.rapport_excel
python -m ch10.corriger_faq
python -m ch11.demander "Vous livrez le dimanche ?"
python -m ch11.cache_avant_apres --budget-max 0.5
python -m ch11.diagnostiquer_cache
python -m ch11.contextualiser
python -m ch11.mesurer_recherche          # gratuit
python -m ch11.evaluer_documentaire --budget-max 0.8
python -m ch11.comptoir_avec_base --variantes sans 5m 1h
python -m ch11.evaluer_documentaire --modes contexte --modele claude-haiku-5-5 --sans-reflexion --sans-citations --sortie essais-haiku-sans-citations.csv
python -m ch12.evaluer_routeur
python -m ch12.reflexion_et_citations
python -m ch12.ordre_des_champs
python -m ch12.reclamations
python -m ch12.reclamations --effort defaut --repetitions 2
python -m ch12.comptoir_aiguille --budget-max 1
python -m ch13.fabriquer_donnees          # gratuit
python -m ch13.reapprovisionner
python -m ch13.reapprovisionner --tours-max 2
python -m ch13.reapprovisionner --memoire memoire_atelier --bons bons.json
python -m ch13.valider_bon --bons bons.json --lister
python -m ch13.evaluer_agent --repetitions 3 --budget-max 1.5
python -m ch13.avec_agent_sdk --budget-max 0.60
python -m ch13.avec_managed_agents --budget-cents 100
python -m ch13.planifier_lundi --agent AGENT_ID --environnement ENV_ID   # n'appelle rien sans --creer
python -m ch14.fabriquer_commandes        # gratuit
python -m ch14.explorer_serveur commandes # gratuit ; aussi : everything, doc ; --essayer-d-ecrire
python -m ch14.mesurer_claude_code --claude claude --budget-max 0.40
python -m ch14.demander_a_la_doc
python -m ch14.demander_a_la_doc --epingler
python -m ch14.question_du_soir
python -m ch15.construire_extension --paquet   # gratuit
python -m ch15.essayer_avec_claude_code --claude claude --budget-max 0.30
python -m ch16.autorisation hacher        # l'empreinte du mot de passe d'Awa
uvicorn ch16.serveur_en_ligne:app --port 8016   # avec COMPTOIR_URL_PUBLIQUE, COMPTOIR_BOUTIQUE, COMPTOIR_MOT_DE_PASSE_HACHE
python -m ch16.se_connecter http://localhost:8016/mcp
python -m ch16.client_brut http://localhost:8016/mcp
python -m ch16.demander_par_l_api https://<adresse-publique>/mcp
python -m ch17.generer_cas
python -m ch17.evaluer estimer --jeu amelioration --essais 3   # gratuit
python -m ch17.evaluer lancer --variante reference --jeu amelioration --essais 3 --budget-max 1
python -m ch17.evaluer juger <série> --modele claude-haiku-5-5 --budget-max 0.3
python -m ch17.comparer <série A> <série B> --modele-juge claude-haiku-5-5   # gratuit
python -m ch17.echantillon tirer <série> --taille 30 && python -m ch17.echantillon page   # gratuit
python -m ch17.echantillon etalonner <série> --modele claude-haiku-5-5 --moitie etalonnage   # gratuit
python -m ch17.evaluer regression --budget-max 0.3   # la version livrée ; code de sortie 1 au premier échec
python -m uvicorn comptoir.en_ligne:app --port 8019   # le Comptoir en ligne, en local (chat web et webhook WhatsApp)
python -m ch19.mesurer_cout --estimer   # gratuit ; puis --variante livree|effort-low|sans-cache --essais 3 --budget-max 0.2
python -m ch19.resume_du_soir --mode lot --attente-max 3600
python -m ch19.juger_par_lot <série> --estimer   # gratuit ; sans --estimer : le juge du chapitre 17 par la Batch API
python -m ch21.veille --horizon 120   # gratuit (l'API Models ne consomme aucun token) ; code de sortie 1 s'il y a une alerte
python -m ch21.estimer_projet --messages 1500 --whatsapp --hebergement 7   # gratuit
python -m ch18.donnees effacer-numero <numéro>   # gratuit ; efface la conversation, les demandes et le numéro
```

Les mêmes exemples en TypeScript, depuis `typescript/` :

```bash
npx tsx ch02/appel_http.ts
npx tsx ch02/premier_appel.ts
npx tsx ch02/comptoir_cli.ts "Combien coûte le sirop de gingembre ?"
npx tsx ch02/compter_tokens.ts
npx tsx ch03/lister_modeles.ts
npx tsx ch03/comparer_modeles.ts --estimer
npx tsx ch03/comparer_modeles.ts --repetitions 3 --budget-max 2
npx tsx ch05/evaluer_prompt.ts --estimer
npx tsx ch05/evaluer_prompt.ts --repetitions 3 --budget-max 1
npx tsx ch05/evaluer_prompt.ts --renoter --essais ../python/ch05/resultats/essais.csv   # gratuit
npx tsx ch05/consigne_en_cours.ts
npx tsx ch06/evenements.ts "Quels jus avez-vous ?"
npx tsx ch06/trois_clients.ts
npm run web   # le Comptoir sur le web, puis http://127.0.0.1:8000 (la page de la version Python)
npx tsx ch07/extraire.ts ../python/ch07/documents/bon-01.jpg --estimer
npx tsx ch07/extraire.ts ../python/ch07/documents/bon-02.jpg
npx tsx ch07/valider_commandes.ts ../python/ch07/documents/bon-01.jpg
npx tsx ch07/mesurer_exactitude.ts --repetitions 3 --budget-max 0.5
npx tsx ch07/citer_conditions.ts "Sous quel délai dois-je signaler une casse ?"
npx tsx ch08/provoquer_erreurs.ts
npx tsx ch08/comptoir_robuste.ts "Combien coûtent 6 bouteilles de bissap ?" --client essai-1
npx tsx ch08/tableau_de_bord.ts --html journal/tableau.html
npx tsx ch09/comptoir_commandes.ts
npx tsx ch09/avec_tool_runner.ts
npx tsx ch09/jouer_scenarios.ts --budget-max 0.5
npx tsx ch10/veille.ts "Quels sont les jours fériés au Bénin en novembre et décembre 2026 ?"
npx tsx ch10/lire_page.ts --max-tokens-lus 2000 https://fr.wikipedia.org/wiki/Bissap "Résume en trois phrases."
npx tsx ch10/rapport_hebdo.ts
npx tsx ch10/rapport_excel.ts
npx tsx ch10/corriger_faq.ts
npx tsx ch11/demander.ts "Vous livrez le dimanche ?"
npx tsx ch11/cache_avant_apres.ts --budget-max 0.5
npx tsx ch11/diagnostiquer_cache.ts
npx tsx ch11/contextualiser.ts
npx tsx ch11/mesurer_recherche.ts          # gratuit
npx tsx ch11/evaluer_documentaire.ts --budget-max 0.8
npx tsx ch11/comptoir_avec_base.ts --variantes sans 5m 1h
npx tsx ch12/evaluer_routeur.ts
npx tsx ch12/reflexion_et_citations.ts
npx tsx ch12/ordre_des_champs.ts
npx tsx ch12/reclamations.ts
npx tsx ch12/reclamations.ts --effort defaut --repetitions 2
npx tsx ch12/comptoir_aiguille.ts --budget-max 1
npx tsx ch13/reapprovisionner.ts
npx tsx ch13/reapprovisionner.ts --tours-max 2
npx tsx ch13/reapprovisionner.ts --memoire memoire_atelier --bons bons.json
npx tsx ch13/valider_bon.ts --bons bons.json --lister
npx tsx ch13/evaluer_agent.ts --repetitions 3 --budget-max 1.5
npx tsx ch13/avec_agent_sdk.ts --budget-max 0.60
npx tsx ch13/avec_managed_agents.ts --budget-cents 100
npx tsx ch13/planifier_lundi.ts --agent AGENT_ID --environnement ENV_ID   # n'appelle rien sans --creer
npx tsx ch14/explorer_serveur.ts commandes  # gratuit ; aussi : everything, doc ; --essayer-d-ecrire
npx tsx ch14/mesurer_claude_code.ts --claude claude --budget-max 0.40
npx tsx ch14/demander_a_la_doc.ts
npx tsx ch14/demander_a_la_doc.ts --epingler
npx tsx ch14/question_du_soir.ts
npx tsx ch15/construire_extension.ts --paquet   # gratuit
npx tsx ch15/essayer_avec_claude_code.ts --claude claude --budget-max 0.30
npx tsx ch16/autorisation.ts hacher        # l'empreinte du mot de passe d'Awa (la même forme qu'en Python)
npx tsx ch16/serveur_en_ligne.ts --port 8016   # avec COMPTOIR_URL_PUBLIQUE, COMPTOIR_BOUTIQUE, COMPTOIR_MOT_DE_PASSE_HACHE
npx tsx ch16/se_connecter.ts http://localhost:8016/mcp
npx tsx ch16/client_brut.ts http://localhost:8016/mcp --revision 2025-11-25
npx tsx ch16/demander_par_l_api.ts https://<adresse-publique>/mcp
npx tsx ch17/generer_cas.ts
npx tsx ch17/evaluer.ts estimer --jeu amelioration --essais 3   # le comptage du juge est gratuit
npx tsx ch17/evaluer.ts lancer --variante reference --jeu amelioration --essais 3 --budget-max 1
npx tsx ch17/evaluer.ts juger <série> --modele claude-haiku-5-5 --budget-max 0.3
npx tsx ch17/comparer.ts <série A> <série B> --modele-juge claude-haiku-5-5   # gratuit ; une série de la version Python se compare aussi
npx tsx ch17/echantillon.ts tirer <série> --taille 30   # gratuit ; puis : page, etalonner <série> --moitie etalonnage
npx tsx ch17/evaluer.ts regression --budget-max 0.3   # la version livrée ; code de sortie 1 au premier échec
npx tsx ch18/attaquer.ts --estimer   # gratuit ; puis --etiquette avant --essais 3 --budget-max 0.3
npx tsx ch18/cote_awa.ts --estimer   # gratuit ; puis --etiquette avant --essais 3 --budget-max 0.4
npx tsx ch18/filtre.ts --estimer     # gratuit ; puis --budget-max 0.1
npx tsx ch18/audit_code.ts --etiquette avant   # gratuit : un faux client
npx tsx ch18/donnees.ts effacer-numero <numéro>   # gratuit ; efface la conversation, les demandes et le numéro
npx tsx comptoir/en_ligne.ts --port 8019   # le Comptoir en ligne, en local (chat web et webhook WhatsApp)
npx tsx ch19/mesurer_cout.ts --estimer   # gratuit ; puis --variante livree|effort-low|sans-cache --essais 3 --budget-max 0.2
npx tsx ch19/resume_du_soir.ts --mode lot --attente-max 3600
npx tsx ch19/juger_par_lot.ts <série> --estimer   # gratuit ; sans --estimer : le juge du chapitre 17 par la Batch API
npx tsx ch21/veille.ts --horizon 120   # gratuit (l'API Models ne consomme aucun token) ; code de sortie 1 s'il y a une alerte
npx tsx ch21/estimer_projet.ts --messages 1500 --whatsapp --hebergement 7   # gratuit
```

Avec Claude Code, dans le dossier `python/` ou `typescript/` : `/verify` avant un commit (gratuit), `/relecture` pour une relecture par le sous-agent, `/nouvelle-variante <changement>` pour préparer une variante du chapitre 17, `/non-regression` (payant, environ 0,03 $). Les hooks de `.claude/settings.json` sont des programmes sans dépendance, lancés par `sh` (Git Bash sous Windows) : en Python dans `python/`, en TypeScript dans `typescript/`, que Node lance seul (il retire les types).

Pour mettre le Comptoir en ligne : `python/ch19/deploiement/`, ou `typescript/ch19/deploiement/` pour la version TypeScript (copier `.env.exemple` en `.env`, le remplir, puis `docker compose up -d --build`, depuis ce dossier, sur le serveur). Pour le faire tourner ensuite : `python/docs/exploitation.md` (avec la version TypeScript, les commandes lancées dans le conteneur deviennent `node --import tsx ch18/donnees.ts …` et `npx tsx ch21/veille.ts`) ; pour changer de modèle, de SDK ou de version d'API : `python/docs/migration.md`.

Les rapports téléchargés vont dans `rapports/`, exclu de Git. L'export de ventes de `ch10/donnees/` est fictif, fabriqué par `python -m ch10.fabriquer_ventes`.

Les documents de `ch07/documents/` sont fictifs, fabriqués par `python -m ch07.fabriquer_exemples` (sans appel à l'API).

Chaque appel est noté dans `journal/appels.jsonl` (identifiant de requête, modèle, tokens, coût). Les conversations du chat web vivent dans `donnees_clients/` : ce sont des données de clients, supprimées après 30 jours. Ces deux dossiers sont exclus de Git.

## Versions vérifiées

| Chapitre | Python | SDK `anthropic` | Tests sans appel | Appels réels |
|---|---|---|---|---|
| 2 | 3.13 | 1.15.0 | 12 réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 4 appels, 0,0075 $ |
| 3 | 3.13 | 1.15.0 | 13 de plus (25 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 270 appels, 0,6247 $ |
| 4 | 3.13 | 1.15.0 | 5 de plus (30 au total) réussis le 20 octobre 2026 | séance de Claude Code rejouée le 20 octobre 2026 (`claude -p`, Opus 5.5) : 3,0257 $ |
| 5 | 3.13 | 1.15.0 | 15 de plus (45 au total) réussis le 20 octobre 2026 ; 2 de plus après la mesure | faits le 20 octobre 2026 : 122 appels, 0,5258 $ |
| 6 | 3.13 | 1.15.0, FastAPI 0.150.0, uvicorn 0.54.0 | 27 de plus (72 au total) réussis le 20 octobre 2026 ; interface essayée dans un navigateur avec un faux client | faits le 20 octobre 2026 : 10 appels, 0,0576 $, dont le chat web avec Claude |
| 7 | 3.13 | 1.15.0, Pillow 13.0.0 | 40 de plus (112 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 39 appels, 0,4502 $ |
| 8 | 3.13 | 1.15.0 | 38 de plus (150 au total) réussis le 20 octobre 2026 ; tableau de bord essayé sur un journal fictif | faits le 20 octobre 2026 : 3 appels facturés, ≈ 0,0091 $ |
| 9 | 3.13 | 1.15.0 | 30 de plus (180 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 27 appels, 0,2500 $ |
| 10 | 3.13 | 1.15.0 | 18 de plus (198 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 10 appels, 0,4563 $ |
| 11 | 3.13 | 1.15.0 | 31 de plus (231 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 162 appels, 0,8497 $ ; embeddings Voyage AI non mesurés (pas de clé) |
| 12 | 3.13 | 1.15.0 | 21 de plus (252 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 1 095 appels journalisés, 1,1265 $, essais avant corrections compris |
| 13 | 3.13 | 1.15.0, claude-agent-sdk 0.2.168 (Claude Code 2.1.301) | 22 de plus (274 au total) réussis le 20 octobre 2026 | faits le 20 octobre 2026 : 105 appels journalisés (1,1887 $), une séance Agent SDK (0,0771 $) et une séance Managed Agents (0,0842 $) : 1,35 $ ; déploiement planifié non créé |
| 14 | 3.13 | 1.15.0, mcp 2.3.0, Claude Code 2.1.304 ; Node 22.20, DBHub 1.5.0, server-everything 1.0.0 | 17 de plus (291 au total) réussis le 21 octobre 2026 | faits le 21 octobre 2026 : 8 appels journalisés (0,0548 $) et 3 séances de Claude Code (0,1493 $) : 0,20 $ |
| 15 | 3.13 | 1.15.0, mcp 2.3.0, Claude Code 2.1.304 ; uv 0.13.4, @anthropic-ai/mcpb 2.1.2, inspecteur MCP 2.11.0 | 13 de plus (304 au total) réussis le 21 octobre 2026 ; paquet .mcpb validé, fabriqué et lancé par uv | faits le 21 octobre 2026 : 3 séances de Claude Code, 0,1379 $ |
| 16 | 3.13 | 1.15.0, mcp 2.3.0, httpx2 2.15.1 ; Docker 29.7.2, cloudflared 2026.10.2 | 18 de plus (322 au total) réussis le 21 octobre 2026 ; parcours OAuth complet en local et par un tunnel ; image Docker lancée | faits le 21 octobre 2026 : 1 appel, 0,0005 $ |
| 17 | 3.13 | 1.15.0 | 27 de plus (349 au total) réussis le 21 octobre 2026 ; page de notation essayée par l'auteur (40 réponses notées) | faits le 21 octobre 2026 : 513 essais, 2 037 appels, 2,59 $ ; le Comptoir aiguillé passe sur Claude Haiku 5.5 (`COMPTOIR_MODELE_COMPTOIR`) |
| 18 | 3.13 | 1.15.0, mcp 2.3.0, FastAPI 0.150.0 | 56 de plus (405 au total) réussis le 21 octobre 2026 ; audit du code avant et après (`ch18.audit_code`), gratuit | faits le 21 octobre 2026 : 965 appels et 12 séances côté Awa, 0,3875 $ ; le Comptoir livré passe au prompt v5 |
| 19 | 3.13 (image : python:3.13-slim) | 1.15.0, FastAPI 0.150.0, uvicorn 0.54.0, httpx2 2.15.1 ; Caddy 2.11.7 | 26 de plus (431 au total) réussis le 22 octobre 2026 ; image construite et jouée en local derrière Caddy en HTTPS ; WhatsApp essayé avec des notifications signées fabriquées et un faux expéditeur (aucun vrai message) | faits le 22 octobre 2026 : 876 appels, 0,3311 $ ; l'effort du Comptoir reste à `medium` |
| 20 | 3.13 | 1.15.0 ; Claude Code 2.1.304 | 22 de plus dans `test_ch20.py`, 6 dans `test_ch19.py` (459 au total) réussis le 22 octobre 2026 ; plugins validés et installés ; workflows analysés, non lancés sur GitHub | faits le 22 octobre 2026 : 12 séances de Claude Code (Claude Sonnet 5.5), 0,9394 $, et une non-régression, 0,0336 $ ; quatre corrections dans le code du chapitre 19, trouvées par la relecture |
| 21 | 3.13 (image : python:3.13-slim) | **2.1.0** (API `2026-10-21`) | 10 de plus (469 au total) réussis le 22 octobre 2026 ; migration essayée dans un environnement séparé (465 réussis) ; image reconstruite ; effacement par numéro et restauration joués en local | faits le 22 octobre 2026 : non-régression, huit conversations, agent du chapitre 13, appels d'essai, image : 0,0507 $ ; la veille, gratuite ; `veille.yml` non lancé sur GitHub |

Après les mesures du 21 octobre 2026 : 349 tests réussis. Le détail des mesures, chapitre par chapitre, est dans `tome-2/verifications.md`.

La version TypeScript :

| Chapitre | Node | SDK `@anthropic-ai/sdk` | Tests sans appel | Appels réels |
|---|---|---|---|---|
| 2 et 3 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (API `2026-10-21`) | 34 réussis le 22 octobre 2026, dont la comparaison au prompt de la version Python ; types vérifiés (`tsc --noEmit`) | pas encore : les mesures du livre sont celles de la version Python |
| 5 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 21 de plus (55 au total) réussis le 22 octobre 2026, dont deux comparaisons à la version Python : les cinq prompts assemblés ont la même empreinte, et les 120 vraies réponses du chapitre, renotées, reçoivent les mêmes verdicts (116 réussies) | pas encore |
| 6 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; Hono 4.13.13, @hono/node-server 2.1.5, ws 8.22.0, zod 4.6.7 | 1.1.0 | 73 de plus (128 au total) réussis le 22 octobre 2026, dont ceux des modules du chapitre 8 et des limites du chapitre 18 dont le serveur dépend, et le comportement du SDK TypeScript face à trois coupures de flux, contre un faux serveur local ; chat essayé dans un navigateur avec un faux client (réponse au fil de l'eau, deuxième tour dans la même conversation) | pas encore |
| 7 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; zod 4.6.7, sharp 0.35.5 | 1.1.0 | 42 de plus (170 au total) réussis le 22 octobre 2026, dont le schéma envoyé comparé à celui de la version Python (identique, aux titres près) ; scripts lancés sans clé : la requête se prépare, photo réduite comprise, puis s'arrête avant tout envoi | pas encore |
| 8 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 10 de plus (180 au total) réussis le 22 octobre 2026 (erreurs, budget et appel robuste étaient venus avec le chapitre 6), dont le tableau comparé à celui de la version Python sur un même journal ; tableau de bord essayé sur un journal fictif : sortie et page HTML identiques, octet pour octet, à celles de la version Python | pas encore |
| 9 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; zod 4.6.7 | 1.1.0 (Tool Runner : `client.beta.messages.toolRunner`, `betaZodTool`) | 77 de plus (257 au total) réussis le 22 octobre 2026, dont les gardes du chapitre 18 et la base d'Awa du chapitre 11, comparée morceau par morceau à celle de la version Python ; scénarios lancés sans clé : arrêt avant tout appel, dépense 0 $ | pas encore |
| 10 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (Files API hors bêta : `client.files`, `toFile`) | 33 de plus (290 au total) réussis le 23 octobre 2026, dont quatre comparaisons à la version Python : l'éditeur (mêmes réponses à 18 commandes, mêmes fichiers), les totaux et les écarts des ventes, `difflib.unified_diff` sur 60 cas, les feuilles de classeurs écrits par `zipfile` et de celui qu'a produit la Skill xlsx ; scripts lancés sans clé : arrêt au premier envoi, aucun fichier laissé | pas encore |
| 11 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (diagnostic du cache : `client.beta.messages`, `diagnostics`) | 30 de plus (320 au total) réussis le 23 octobre 2026, dont six comparaisons à la version Python : les classements BM25 des 20 questions (mêmes morceaux, mêmes rangs ; scores à 10⁻¹² près, le logarithme de V8 différant parfois au dernier bit), les scores cosinus et la fusion des rangs (identiques), les requêtes (six réglages, reclassement, contexte), les verdicts sur les 160 vraies réponses du chapitre, 3 000 arrondis et 610 écritures de nombres ; rappel mesuré sans appel : 56, 75 et 88 % pour BM25, 62, 75 et 81 % avec les contextes, comme la version Python ; scripts lancés sans clé : arrêt au premier envoi, aucun fichier de résultats écrit | pas encore |
| 12 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 | 31 de plus (351 au total) réussis le 23 octobre 2026, dont les quatre tests de la garde « dire contre faire » du chapitre 18 qui attendaient le Comptoir aiguillé, et quatre comparaisons à la version Python : la requête de routage (trois réglages), les schémas, prompts, promesses et faits des réclamations, la chaîne des réclamations sur trois scénarios scriptés (mêmes requêtes envoyées, même résultat), le Comptoir aiguillé sur trois conversations de deux messages (mêmes requêtes, outils et points de cache compris, mêmes réponses, mêmes étapes) ; scripts lancés sans clé : arrêt au premier envoi, aucun fichier de résultats écrit | pas encore |
| 13 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.309 (binaire de Claude Code 0.3.309), `@modelcontextprotocol/sdk` 1.32.1 | 1.1.0 (Tool Runner `client.beta.messages.toolRunner`, `betaTool`, `ToolError`, `compactBeforeNextTurn`, outil mémoire `BetaLocalFilesystemMemoryTool` ; Managed Agents `client.beta.environments`, `agents`, `sessions`, `deployments`) | 31 de plus (382 au total) réussis le 23 octobre 2026, dont une séance complète avec le vrai Tool Runner (réponses d'un faux `fetch`, sans réseau), le serveur MCP de l'atelier interrogé par un vrai client MCP en mémoire, et six comparaisons à la version Python : les sorties des outils et les erreurs d'un bon, les dates et les nombres écrits (`date.fromisoformat`, `:g`), le fichier des bons, les définitions des outils (aux `type: "custom"` près, que le SDK TypeScript ajoute) et leurs sorties sur neuf appels, les outils personnalisés de Managed Agents et la planification, les décisions du hook et les outils MCP du Claude Agent SDK ; `planifier_lundi` lancé sans `--creer` dans les deux langages : même sortie ; scripts d'appel lancés sans clé : arrêt au premier envoi, sauf `avec_agent_sdk`, pas lancé depuis la séance (voir verifications.md) | pas encore |
| 14 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; `@modelcontextprotocol/sdk` 1.32.1 (le plus récent du registre au 23 octobre 2026 : protocole 2025-11-25 au plus) ; serveurs DBHub 1.5.0 et server-everything 1.0.0 de la version Python | 1.1.0 (`mcpTools` de `@anthropic-ai/sdk/helpers/beta/mcp` pour le Tool Runner ; connecteur MCP : `mcp_servers`, `mcp_toolset`, bêtas `mcp-client-2025-11-20` et `mcp-client-2026-09-15`) | 17 de plus (399 au total) réussis le 23 octobre 2026, dont trois comparaisons à la version Python : alertes, vérification des réponses de Claude Code, requêtes du connecteur, comparaison des prix et trace ; bonnes réponses calculées sur la copie ; outil du Tool Runner tiré d'un outil MCP ; `explorer_serveur` lancé dans les deux langages sur les trois serveurs (gratuit) : mêmes sorties, sauf la version négociée avec DBHub (2025-11-25 en TypeScript, 2026-07-28 en Python ; 2025-11-25 des deux côtés avec les deux autres) ; écriture refusée par DBHub, copie intacte ; `question_du_soir` et `demander_a_la_doc` lancés sans clé : arrêt au premier envoi ; `mesurer_claude_code` pas lancé (il appelle Claude Code, payant) | pas encore |
| 15 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; `@modelcontextprotocol/sdk` 1.32.1 (serveur `McpServer`), zod 4.6.7, esbuild 0.28.2, sharp 0.35.5 ; `@anthropic-ai/mcpb` 2.1.2 de la version Python | 1.1.0 (le serveur n'appelle pas l'API) | 15 de plus (414 au total) réussis le 23 octobre 2026, dont deux comparaisons à la version Python : l'annonce du serveur (outils, annotations, `_meta`, schémas aux différences de forme près, ressources, prompts, instructions) et ses réponses à 13 appels, 2 ressources et 3 prompts, sur une même copie de la base, à la même heure (identiques, textes d'erreur compris, jetons tirés au hasard mis à part) ; serveur lancé en stdio par tsx, et une fois empaqueté, depuis une copie : sortie standard propre ; paquet .mcpb validé et fabriqué (256,6 kB) ; extension pas installée dans l'application Claude ; `essayer_avec_claude_code` pas lancé (il appelle Claude Code, payant) | pas encore |
| 16 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; `@modelcontextprotocol/sdk` 1.32.1 (serveur OAuth `mcpAuthRouter`, `requireBearerAuth`, transport HTTP sans état), Express 5.3.0 (`@types/express` 5.0.6) ; uvicorn 0.54.0 de la version Python, pour les essais croisés | 1.1.0 (`demander_par_l_api` : connecteur MCP avec `authorization_token`) | 30 de plus (444 au total) réussis le 23 octobre 2026, dont le parcours OAuth complet sur un port local, et cinq comparaisons à la version Python : l'annonce du serveur, ses réponses (rapport, progression, formulaire de confirmation), 32 étapes du parcours OAuth réponse par réponse (mêmes statuts, mêmes redirections, mêmes pages ; textes d'erreur propres à chaque SDK mis à part), la requête du connecteur, et les scripts TypeScript face au serveur Python lancé par uvicorn (mot de passe haché par l'une, vérifié par l'autre, dans les deux sens) ; scripts lancés contre le serveur TypeScript local : `se_connecter --automatique`, `client_brut` dans les deux révisions ; page de connexion essayée dans un navigateur : la redirection vers l'adresse de retour passe ; Dockerfile contrôlé par `docker build --check`, image pas construite ; `demander_par_l_api` pas lancé (payant) | pas encore |
| 17 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 | 1.1.0 (le juge : `output_config` avec un schéma JSON ; la génération des cas : flux et `withOptions`) | 34 de plus (478 au total) réussis le 25 octobre 2026, dont des comparaisons à la version Python : `random.Random` (codes de confirmation, tirages) et `statistics.mean` ; la notation par le code et les résumés, sur les 13 séries mesurées du livre (toutes leurs réponses réelles, avec et sans le juge) ; l'échantillon tiré et l'étalonnage sur les notes de l'auteur ; les requêtes du juge ; le banc d'essai sur quatre cas scriptés (mêmes requêtes, mêmes codes de confirmation) ; l'empreinte des cas au registre ; `evaluer.ts resumer`, `comparer.ts` et `echantillon.ts tirer` lancés dans les deux langages sur les séries du livre : mêmes sorties ; `estimer` et `generer_cas` lancés sans clé : arrêt au premier envoi, rien d'écrit | pas encore |
| 18 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; `@modelcontextprotocol/sdk` 1.32.1 (le côté d'Awa, sur le serveur du chapitre 15 de cette version) | 1.1.0 (Tool Runner, `mcpTools`, `betaTool`) | 15 de plus (493 au total) réussis le 25 octobre 2026, dont des comparaisons à la version Python : les notes des attaques sur les quatre séries mesurées du livre ; les messages étiquetés du filtre, sa requête, et la boutique du côté d'Awa (mêmes codes, mêmes totaux, mêmes instants) ; audit du code lancé (gratuit) : les sept points tiennent, avec les chiffres de l'audit Python « après » (10 messages acceptés puis 429, 20 sur 60, 413) ; `--estimer` des trois scripts payants : mêmes sorties qu'en Python | pas encore |
| 19 | 22.20 ; TypeScript 7.0.2, tsx 4.23.15 ; Hono 4.13.13, @hono/node-server 2.1.5 ; image `node:22.22.3-alpine` | 1.1.0 (Batch API : `messages.batches`) | 34 de plus (527 au total) réussis le 25 octobre 2026, dont des comparaisons à la version Python : signatures, empreintes, messages et découpages de WhatsApp ; les faits du soir et leur requête ; le service sur une conversation de deux messages (mêmes requêtes, même conversation gardée, mêmes événements au journal) ; les requêtes du juge par lot sur une série du livre ; le résumé des quatre mesures de coût du livre ; serveur en ligne essayé sur un vrai port HTTP, avec un faux client et un faux expéditeur (chat en SSE, webhook signé, tableau de bord, adresse lue derrière un relais) ; `--estimer` des trois scripts : mêmes sorties ; Dockerfile contrôlé par `docker build --check`, `docker compose config` valide, image pas construite | pas encore |
| 20 | 22.20 (les hooks, lancés par Node seul, sans tsx : `--experimental-strip-types`) | — | 15 de plus (542 au total) réussis le 25 octobre 2026 : hooks essayés sur des événements fabriqués, dans des dépôts Git temporaires, et par `lancer.sh` comme Claude Code les lance ; réglages, Skills, sous-agents et règles contrôlés ; workflow `tests-typescript.yml` analysé, pas lancé sur GitHub | pas encore |
| 21 | 22.20 | 1.1.0 (API `2026-10-21`, depuis la 1.0.0) ; 1.3.0 disponible le 25 octobre 2026 | 12 de plus (554 au total) réussis le 25 octobre 2026, dont la comparaison des rapports de veille et des estimations à la version Python ; job de veille TypeScript de `veille.yml` pas lancé sur GitHub | la veille, gratuite, le 25 octobre 2026, dans les deux langages : mêmes modèles, mêmes dates, aucune alerte |
