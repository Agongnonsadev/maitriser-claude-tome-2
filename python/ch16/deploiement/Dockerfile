# Chapitre 16 : l'image du Comptoir en ligne.
# Construire depuis le dossier python/ :  docker build -f ch16/deploiement/Dockerfile -t comptoir-en-ligne .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Les dépendances, figées avec leurs empreintes (uv pip compile --generate-hashes) : pip refuse
# un paquet dont l'empreinte a changé.
COPY ch16/deploiement/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Le serveur du chapitre 15, sa couche en ligne, et le catalogue d'Awa.
COPY ch15/__init__.py ch15/comptoir_pour_awa.py ch15/
COPY comptoir/donnees/delices_awa.json ch15/catalogue.json
COPY ch16/__init__.py ch16/autorisation.py ch16/serveur_en_ligne.py ch16/

# Un utilisateur sans droits ; les bases vivent dans un volume, hors de l'image.
RUN useradd --create-home comptoir && mkdir /donnees && chown comptoir /donnees
USER comptoir
ENV COMPTOIR_BOUTIQUE=/donnees/boutique.sqlite3 COMPTOIR_AUTORISATION=/donnees/autorisation.sqlite3

EXPOSE 8016
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8016/sante')"
# Derrière Caddy, qui termine le HTTPS : uvicorn fait confiance à ses en-têtes X-Forwarded-*.
CMD ["uvicorn", "ch16.serveur_en_ligne:app", "--host", "0.0.0.0", "--port", "8016", "--proxy-headers", "--forwarded-allow-ips", "*"]
