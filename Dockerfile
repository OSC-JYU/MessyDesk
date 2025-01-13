FROM node:23.3-bookworm-slim

# Install app dependencies
# RUN apt update && apk add bash
COPY package.json /src/package.json
RUN cd /src; npm install

COPY . /src
WORKDIR /src
RUN chown -R node:node /src
EXPOSE  8100

# change user
USER node

CMD ["node", "index.js"]
