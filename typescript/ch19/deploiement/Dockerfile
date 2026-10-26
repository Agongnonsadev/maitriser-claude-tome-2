# Chapitre 19 : l'image du Comptoir en ligne, version TypeScript (chat web et WhatsApp).
# Construire depuis le dossier typescript/ (les données d'Awa, communes aux deux versions, sont lues dans
# python/comptoir) :
#   docker build -f ch19/deploiement/Dockerfile --build-context comptoir_python=../python/comptoir -t comptoir-en-ligne-ts .
FROM node:22.22.3-alpine

ENV NODE_ENV=production
WORKDIR /app/typescript

# Les dépendances, figées avec leurs empreintes (package-lock.json) : npm ci refuse un paquet dont l'empreinte
# a changé. Les sources TypeScript sont lancées par tsx : rien à compiler.
COPY ch19/deploiement/package.json ch19/deploiement/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Le Comptoir livré, et la purge et l'effacement à la demande du chapitre 18, à lancer sur le serveur
# (chapitre 21 : docker compose exec comptoir node --import tsx ch18/donnees.ts effacer-numero <numéro>).
COPY comptoir/*.ts comptoir/
COPY ch18/donnees.ts ch18/
# Les données d'Awa, là où le code les cherche (../python/comptoir) : catalogue, stock, base de connaissances,
# prompts et page du chat. Ni les données des clients ni les journaux : ils vivent dans un volume.
COPY --from=comptoir_python donnees/delices_awa.json donnees/stock_initial.json /app/python/comptoir/donnees/
COPY --from=comptoir_python connaissances/ /app/python/comptoir/connaissances/
COPY --from=comptoir_python prompts/ /app/python/comptoir/prompts/
COPY --from=comptoir_python pages/ /app/python/comptoir/pages/

# Un utilisateur sans droits ; les bases et le journal vivent dans un volume, hors de l'image.
# La clé d'API et les secrets de WhatsApp arrivent par l'environnement (.env), jamais dans l'image.
RUN adduser -D comptoir && mkdir /donnees && chown comptoir /donnees
USER comptoir
ENV COMPTOIR_BOUTIQUE=/donnees/boutique.sqlite3 COMPTOIR_CONVERSATIONS=/donnees/conversations.sqlite3 \
    COMPTOIR_BUDGET_BASE=/donnees/budget.sqlite3 COMPTOIR_JOURNAL=/donnees/journal/appels.jsonl

EXPOSE 8019
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8019/sante').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Derrière Caddy, seul à joindre le conteneur : le serveur lit l'adresse du client dans X-Forwarded-For.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "comptoir/en_ligne.ts", "--hote", "0.0.0.0", "--port", "8019", "--derriere-un-relais"]
