# Running MessyDesk locally

`compose.yaml` runs MessyDesk with its base services on one Linux machine, without Nomad.

## Start

Clone the repositories side by side (the compose file builds from the sibling directories):

```bash
git clone https://github.com/OSC-JYU/MessyDesk-UI.git
git clone https://github.com/OSC-JYU/MD-consumers.git
git clone https://github.com/OSC-JYU/MD-sharp.git
git clone https://github.com/OSC-JYU/MD-poppler.git
git clone https://github.com/OSC-JYU/MD-pypdf_fs.git
git clone https://github.com/OSC-JYU/MD-zip_fs.git
git clone https://github.com/OSC-JYU/MD-text-base_fs.git
git clone https://github.com/OSC-JYU/MD-tesseract.git
git clone https://github.com/OSC-JYU/MD-lingua.git
git clone https://github.com/OSC-JYU/MD-LibreTranslate.git
git clone https://github.com/OSC-JYU/MD-gensim.git          # only for --profile linguistics
git clone https://github.com/OSC-JYU/MD-Gliner2.git         # only for --profile machine_learning
# and this repository (MessyDesk, branch rewrite)
```

Then:

```bash
cd MessyDesk/local
cp .env.example .env        # set DB_PASSWORD and SERVICE_TOKEN
podman-compose up -d --build
```

`docker compose up -d --build` works the same way. Open http://localhost:8200 (`MD_PORT` in `.env`).
The first build takes a while; later starts are quick.

## What runs

| Container | Purpose |
|---|---|
| `backend` | The API, with the UI built into it (one port for both) |
| `arcadedb`, `solr`, `solr-init` | Graph database and search index (the schema is created on first start) |
| `md-sharp`, `md-poppler`, `md-pypdf`, `md-zip`, `md-text-base`, `md-tesseract` | Base services |
| `md-lingua`, `libretranslate` | Language detection, and machine translation (the upstream LibreTranslate image; MD-LibreTranslate only supplies its descriptor) |
| `md-gensim` | Only with `--profile linguistics`: word counts, TF-IDF similarity indexes (text reuse) and topic models (LDA, NMF, LSI, HDP, k-means) |
| `md-gliner2` | Only with `--profile machine_learning`: zero-shot entity extraction and classification |
| `consumer-*` | One MD-consumers instance per queue topic: `md-thumbnailer` and `md-sharp` (md-sharp), `md-poppler`, `md-pypdf_fs`, `md-zip_fs`, `md-text-base_fs`, `md-tesseract`, `md-lingua`, `md-libretranslate`, `md-solr` (Solr directly) |

Each consumer finds its service by `DEV_URL`, so Nomad is not needed. Everything shares the `md-data`
volume: the backend sees it as `data/` and the services and consumers as `$MD_PATH/data`, so the `_fs`
services read and write files on disk.

LibreTranslate loads only `LIBRETRANSLATE_LANGUAGES` (default `en,fi,sv,de`). Their models are downloaded
on the first start, so translation is unavailable for a few minutes; they are kept in a volume after that.

`MODE=development` means there is no login: every request is `DEV_USER`.

## Optional services

Text analysis services are behind the `linguistics` profile and heavier ones behind
`machine_learning`; neither starts by default:

```bash
podman-compose --profile linguistics up -d --build
podman-compose --profile linguistics --profile machine_learning up -d --build    # both
```

Pass the same `--profile` flags to `down`, `logs` and `ps` as well, or podman-compose leaves those
containers out. MD-Gliner2's model is part of its image: the first build downloads it (the image
is about 2.5 GB), and the service then runs without network access. The old `gliner2-models`
volume is no longer used; `podman volume rm messydesk_gliner2-models` frees its space.

## Day to day

```bash
podman-compose logs -f backend consumer-thumbnailer    # follow logs
podman-compose down                                    # stop (data is kept in volumes)
podman-compose down -v                                 # stop and delete all data
```

After changing code in any of the repositories, rebuild and restart the whole stack:

```bash
podman-compose down && podman-compose up -d --build
```

podman-compose turns `depends_on` into hard container dependencies, so a single service cannot be
recreated while the rest run. With Docker, `docker compose up -d --build backend` rebuilds just one.

Uploading a PDF splits it into pages (md-pypdf_fs) and then deletes the original PDF; that is the
import pipeline, not a lost file.

To use ArcadeDB Studio or the Solr admin, add a `ports:` entry to `arcadedb` (2480) or `solr` (8983).

## Adding a service

Add the service container with the shared volume and `MD_PATH: /md`, and a `consumer-*` entry with
its `TOPIC` and `DEV_URL`. Copy an existing pair; `md-tesseract` and `consumer-tesseract` are the
simplest.

## Later

- Once the UI is in this repository, the main `Dockerfile` can build it and `local/Dockerfile` goes away.
- With images published to a registry (for example ghcr.io), the `build:` entries can become `image:`
  references and a new user needs only this directory, not the sibling checkouts.
