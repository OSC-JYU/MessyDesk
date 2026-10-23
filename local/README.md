# Running MessyDesk locally

`compose.yaml` runs MessyDesk with its base services on one Linux machine, without Nomad.

## Start

Clone this repository (branch `rewrite`) and let the script clone the rest next to it (the compose file
builds from the sibling directories):

```bash
git clone -b rewrite https://github.com/OSC-JYU/MessyDesk.git
cd MessyDesk/local
./clone-all.sh              # add --all for MD-gensim and MD-Gliner2 (the optional profiles)
```

Then:

```bash
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
| `md-sharp`, `md-poppler`, `md-pypdf`, `md-zip`, `md-text-base`, `md-tesseract`, `md-docori` | Base services (`md-docori` detects page orientation) |
| `md-lingua`, `libretranslate` | Language detection, and machine translation (the upstream LibreTranslate image; MD-LibreTranslate only supplies its descriptor) |
| `md-gensim` | Only with `--profile linguistics`: word counts, TF-IDF similarity indexes (text reuse) and topic models (LDA, NMF, LSI, HDP, k-means) |
| `md-gliner2` | Only with `--profile machine_learning`: zero-shot entity extraction and classification |
| `consumer-*` | One MD-consumers instance per queue topic: `md-thumbnailer` and `md-sharp` (md-sharp), `md-poppler`, `md-pypdf_fs`, `md-zip_fs`, `md-text-base_fs`, `md-tesseract`, `md-docori`, `md-lingua`, `md-libretranslate`, `md-solr` (Solr directly) |

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

## Start from a clean database and a clean search index

The data lives in four named volumes: `md-data` (uploaded files and everything the services write),
`arcadedb-data` (the database), `solr-data` (the search index) and `libretranslate-models` (downloaded
translation models). The database and `md-data` belong together: the database points at files in
`md-data`, so wipe both or neither.

To wipe everything and start over (all desks, files, tags and the search index are lost):

```bash
podman-compose --profile linguistics --profile machine_learning down    # stop and remove the containers
podman volume rm messydesk_md-data messydesk_arcadedb-data messydesk_solr-data
podman-compose up -d --build                                            # new, empty database and index
```

Pass the same `--profile` flags to `down` as to `up`, otherwise the containers of those profiles stay
behind and block removing the volumes ("volume is being used"; podman-compose makes them depend on the
backend and Solr). `down -v` does the same in one command but also deletes `libretranslate-models`, so the
translation models are downloaded again on the next start.

The first start creates the database and the Solr schema, and the development user (`DEV_USER`) again.

### Only the search index

Solr is rebuilt from the database and the files, so it can be wiped alone. The `solr-init` container keeps
the index when the stack restarts; it deletes documents only when `SOLR_RESET=true` is set on it (add
it under `environment:` of `solr-init`, for one start). To wipe just the documents by hand:

```bash
podman-compose exec solr curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"delete":{"query":"*:*"},"commit":{}}' http://localhost:8983/solr/messydesk/update
```

After that, run "Re-index search" from each desk's menu in the desk list: it indexes the texts again, restores the tag
fields and rebuilds the ROI label documents (labels of NER and language runs, used by the Tag Filter).
To drop the index and its schema as well, remove `messydesk_solr-data` after `down` (as above) and start
again; `solr-init` creates the schema.

## Rebuilding after code changes

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
