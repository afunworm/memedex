############################################
# CLIENT BUILD (Angular)
############################################
# Angular 22's CLI needs Node >= 22.22.3, so everything builds on Node 24
FROM node:24-bookworm AS client-build
WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/angular.json client/tsconfig*.json client/.postcssrc.json ./
COPY client/src ./src
COPY client/public ./public
RUN npm run build -- --configuration production
# Output: /app/client/dist/client/browser


############################################
# SERVER BUILD (NestJS)
############################################
FROM node:24-bookworm AS server-build
WORKDIR /app/server

# Native modules (better-sqlite3, sharp, onnxruntime-node) are built/downloaded
# here, on the same Debian base as the runtime image
COPY server/package*.json ./
RUN npm ci

COPY server/tsconfig*.json server/nest-cli.json ./
COPY server/src ./src
COPY server/scripts ./scripts
RUN npm run build

# Bake the embedding model (~23 MB) into the image so it never downloads at runtime
ENV MODEL_DIR=/app/server/models
RUN npm run fetch-model

RUN npm prune --omit=dev


############################################
# RUNTIME (one container: API + web app)
############################################
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
	PORT=8080 \
	DATA_DIR=/app/data \
	PUBLIC_DIR=/app/public \
	MODEL_DIR=/app/models

COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/package.json ./package.json
COPY --from=server-build /app/server/models ./models
COPY --from=client-build /app/client/dist/client/browser ./public

# SQLite database + uploaded images live here: mount a volume
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
	CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
