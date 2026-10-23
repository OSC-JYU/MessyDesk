# The backend with the UI built into public/, so one container serves both on port 8200.
# Built by local/compose.yaml with the MessyDesk-UI checkout as the extra build context "ui".
# Once the UI moves into this repository, the main Dockerfile can do this and this file goes away.

FROM node:23.3-bookworm-slim AS ui-build
WORKDIR /ui
COPY --from=ui package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=ui index.html vite.config.js ./
COPY --from=ui src ./src
COPY --from=ui public ./public
COPY --from=ui lang ./lang
# Served from the root, with API calls relative to it.
ENV VITE_PUBLIC_PATH="" VITE_API_PATH=""
RUN npx vite build

FROM node:23.3-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:23.3-bookworm-slim
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY public ./public
COPY filters ./filters
COPY --from=ui-build /ui/dist ./public
# data/ is the mount point of the shared data volume; DATA_DIR stays at its default data/<DB_NAME>
# so the paths in queue messages (data/<db>/...) resolve on every consumer's MD_PATH too.
RUN mkdir -p data && chown -R node:node /src
USER node
EXPOSE 8200
CMD ["node", "--experimental-sqlite", "dist/src/main.js"]
