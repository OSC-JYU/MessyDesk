# Local Development Setup

Prerequisites: Node.js ≥ 22.3, Docker or Podman, Nomad.

## 1. Start ArcadeDB and Solr

```bash
docker compose up -d
```

This starts ArcadeDB (`:2480`) and Solr (`:8983`).

## 2. Start the backend

```bash
npm install
MODE=development DB_PASSWORD=node_master node src/index.mjs
```

Runs on `http://localhost:8200`.

## 3. Start the UI

```bash
cd ../MessyDesk-UI
npm install
npm run dev
```

Runs on `http://localhost:3000`, proxies API to `:8200`.

The system is now up but it is totally useless without any services.


## 4. Services

Each service needs adapter  that connects it to MessyDesk. see [MD-consumers](https://github.com/OSC-JYU/MD-consumers)

