FROM node:23.3-bookworm-slim

# Install app dependencies
# RUN apt update && apk add bash
COPY package.json /src/package.json
RUN cd /src; npm install

COPY --chown=node:node . /src
WORKDIR /src
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE  8100

# change user
USER node

CMD ["node", "index.mjs"]
