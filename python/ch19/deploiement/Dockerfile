# Chapitre 19 : l'image du Comptoir en ligne (chat web et WhatsApp).
# Construire depuis le dossier python/ :  docker build -f ch19/deploiement/Dockerfile -t comptoir-en-ligne .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Les dépendances, figées avec leurs empreintes (uv pip compile --generate-hashes) : pip refuse un
# paquet dont l'empreinte a changé.
COPY ch19/deploiement/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Le paquet du Comptoir, avec ses prompts, les documents d'Awa et la page du chat. Ni les tests, ni les
# scripts des chapitres, ni les données : .dockerignore les écarte.
COPY comptoir/ comptoir/
# Chapitre 21 : la purge et l'effacement à la demande, à lancer sur le serveur
# (docker compose exec comptoir python -m ch18.donnees effacer-numero <numéro>).
COPY ch18/__init__.py ch18/donnees.py ch18/

# Un utilisateur sans droits ; les bases et le journal vivent dans un volume, hors de l'image.
# La clé d'API et les secrets de WhatsApp arrivent par l'environnement (.env), jamais dans l'image.
RUN useradd --create-home comptoir && mkdir /donnees && chown comptoir /donnees
USER comptoir
ENV COMPTOIR_BOUTIQUE=/donnees/boutique.sqlite3 COMPTOIR_CONVERSATIONS=/donnees/conversations.sqlite3 \
    COMPTOIR_BUDGET_BASE=/donnees/budget.sqlite3 COMPTOIR_JOURNAL=/donnees/journal/appels.jsonl

EXPOSE 8019
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8019/sante')"
# Derrière Caddy, seul à joindre le conteneur : uvicorn lit l'adresse du client dans X-Forwarded-For.
CMD ["uvicorn", "comptoir.en_ligne:app", "--host", "0.0.0.0", "--port", "8019", "--proxy-headers", "--forwarded-allow-ips", "*"]
