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
RUN chown -R node:node /src
USER node
EXPOSE 8200
# node:23.3 still gates node:sqlite behind this flag.
CMD ["node", "--experimental-sqlite", "dist/src/main.js"]
