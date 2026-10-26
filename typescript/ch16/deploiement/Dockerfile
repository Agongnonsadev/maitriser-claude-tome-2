# Chapitre 16 : l'image du Comptoir en ligne, version TypeScript.
# Construire depuis le dossier typescript/ (le catalogue d'Awa est lu dans python/comptoir/donnees) :
#   docker build -f ch16/deploiement/Dockerfile --build-context donnees=../python/comptoir/donnees -t comptoir-en-ligne-ts .
FROM node:22.22.3-alpine

ENV NODE_ENV=production
WORKDIR /app

# Les dépendances, figées avec leurs empreintes (package-lock.json) : npm ci refuse un paquet dont l'empreinte
# a changé. Les sources TypeScript sont lancées par tsx : rien à compiler.
COPY ch16/deploiement/package.json ch16/deploiement/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Le serveur du chapitre 15, sa couche en ligne, le code commun dont ils dépendent, et le catalogue d'Awa.
COPY comptoir/arrondi.ts comptoir/dates.ts comptoir/lancement.ts comptoir/python.ts comptoir/
COPY ch15/comptoir_pour_awa.ts ch15/schemas.ts ch15/
COPY ch16/autorisation.ts ch16/schemas.ts ch16/serveur_en_ligne.ts ch16/
COPY --from=donnees delices_awa.json ch15/catalogue.json

# Un utilisateur sans droits ; les bases vivent dans un volume, hors de l'image.
RUN adduser -D comptoir && mkdir /donnees && chown comptoir /donnees
USER comptoir
ENV COMPTOIR_BOUTIQUE=/donnees/boutique.sqlite3 COMPTOIR_AUTORISATION=/donnees/autorisation.sqlite3

EXPOSE 8016
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8016/sante').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Derrière Caddy, qui termine le HTTPS : le serveur fait confiance à son en-tête X-Forwarded-For (un relais).
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "ch16/serveur_en_ligne.ts", "--hote", "0.0.0.0", "--port", "8016", "--derriere-un-relais"]
