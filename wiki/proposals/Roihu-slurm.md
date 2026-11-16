# SLURM for Roihu


There is a mcp service for CSC docs:
https://mcp.docs.csc.fi


/scratch and /projappl -directories are relatively small. It is better to move files first to Allas and then process from there.

We are using Firecrest API

Open questions

- batch size? Should we process in batches or all in once? Maybe there should be always initial batch that checks that everything is working?
- How process output gets back to MessyDesk? Are outputs stored to Allas and streamed to messydesk. This needs some open API endpoint in MessyDesk. (with credentials)
Or can consumer poll firecrest api and then fetch files as they are ready?


in our initial implementation we want to use HTR model by Kansalliskirjasto: 
https://huggingface.co/Kansallisarkisto/multicentury-htr-model



We maybe should use this pipeline:
https://github.com/Kansallisarkisto-AI/nafrec



The task is to create MessyDesk service for Roihu supercomputer. This is for spesific models, not for LLMs so the process does not start from prompt.

Make plan and ask questions.

---

# Plan (draft 2026-11-06)

## 1. What we found

Facts from CSC docs (docs.csc.fi/computing/firecrest) and our code:

- FirecREST HPC API for Roihu: `https://api.roihu.csc.fi/v1/compute/{cpu|gpu}/jobs` (FirecREST v2, OpenAPI at `/v1/openapi.json`). Auth is a JWT bearer on every request.
  - Personal token: valid **24 h**, only for interactive use.
  - **Robot account** (project-specific): OAuth2 client credentials against `https://user-auth.csc.fi/idp/profile/oidc/token`, scope `openid`. This is what a headless consumer must use. Jobs run as the robot and burn the *project's* billing units.
- Data transfer is S3 via Allas with pre-signed URLs (FirecREST's own tenant/bucket). So "files to Allas first" fits the platform.
- nafrec = RF-DETR text line/region detection -> crop lines -> script classifier (optional) -> line recognition (TrOCR or PP-OCRv6) -> **ALTO XML and/or PAGE XML**. The multicentury model is a *line-level* TrOCR (fi/sv, CER 2.8), so it cannot run alone: it needs the detection model, i.e. we run nafrec, not the HF model directly. Needs Python 3.12, onnxruntime, rfdetr, transformers; GPU extra targets CUDA 13.x.
- MessyDesk consumer contract (MD-consumers `index.mjs`, backend `queue.ts`):
  - Consumer claims **one job per message (= one file)**, lease 120 s, heartbeat every 40 s; one job at a time per process.
  - Nothing stops a consumer from claiming many jobs and heartbeating all of them. A cancelled job makes the heartbeat return false, which is how a consumer learns about cancel.
  - Adapter writes outputs straight into `data/<db>/tmp` and reports them with `sendDone`; input is read from `message.file.path`. So the consumer must run on the same host as MessyDesk data (already true for elg_fs).
  - Service descriptor (`service.json`) with `behaviour`, `supported_types`, `params_help`, `autotag` etc.; models/prompts are not needed here (`docs/adding_service.md`).

## 2. Proposed architecture

```
MessyDesk queue --claim N jobs--> consumer "md-roihu" (adapter roihu.mjs)
   1. collect files of one process node (the batch)
   2. upload images to Allas bucket (S3, prefix batch-<id>/in/)
   3. FirecREST: POST /v1/compute/gpu/jobs  (sbatch of run_htr.sh <prefix>)
   4. poll FirecREST job state + list Allas prefix batch-<id>/out/
   5. for each finished output: download -> data/<db>/tmp -> sendDone -> queue complete(job)
   6. job FAILED/TIMEOUT: sendError for the missing files, queue fail(job) (retry resubmits only the missing ones)
Roihu GPU node: run_htr.sh pulls input from Allas to node-local scratch, runs nafrec in an Apptainer image,
   pushes <name>.page.xml / <name>.alto.xml / <name>.txt back to Allas as each image completes, writes manifest.json.
```

Decisions behind it:

- **Return path = consumer polls** (answers the open question). Roihu never calls MessyDesk, so no public endpoint or inbound credentials. Outputs appear in Allas one by one, so the user sees results *progressively*, not only when the whole batch ends.
- **Only the robot-account secret and Allas S3 keys exist, and only in the consumer's environment** (same rule as LLM provider keys: secrets live with the consumer).
- **Batch, not one-job-per-page.** A Slurm job has queue wait + model load; per-page jobs would be hopeless. The consumer keeps a gather window (e.g. wait up to 30 s or until `MAX_BATCH` jobs of the same process node), then submits one job (or an array job for big batches).
- **Canary first** (answers the "initial batch" question): the first chunk of a process node is small (e.g. 5 pages) on a short-time partition. Only when it finishes OK do the remaining chunks get submitted. Catches bad token, missing model, container error before burning hours.
- **Chunk size by runtime, not file count**: aim ~30-60 min per Slurm job (set after measuring pages/min). Chunks are independent, so one failed chunk does not lose the others. Chunk size and partition are consumer config, not user params.
- **Idempotent state**: consumer persists `{process_rid -> chunk -> slurm_job_id, bucket prefix, job ids}` in a small SQLite/JSON file. After a restart or lease expiry it re-attaches to the running Slurm job instead of submitting again.
- /scratch and /projappl are not used for data. Only models + container live in /projappl (a few GB); images go Allas -> node-local disk -> Allas.
- **Service name** `md-roihu-htr`, adapter `roihu`. One task `htr`, `one-to-many` (xml + txt per page; labelled by the service), supports `original-image` and PDF-page images (formats jpg/png/tif). Params: recognition model (fi-sv TrOCR default; later PP-OCRv6 fi-sv, Estonian, Latvian, Cyrillic), output format (PAGE / ALTO / both), maybe language hint. Text output makes it chain-able to translation, NER, tagging.
  The adapter is written so that adding another Roihu model = new descriptor + new `run_*.sh`, not a new adapter ("specific models, not LLMs").

## 3. Phases

**Phase 0: spikes (no MessyDesk code)**
1. Get a robot account for the project; check the token with curl, `GET /v1/compute/gpu/jobs`.
2. Hello-world job via FirecREST on `gpu` and `cpu` subsystems; learn the partition names, time limits, queue wait.
3. Prove compute node <-> Allas (rclone/s3cmd/boto3 with project creds) and what FirecREST's own pre-signed-URL flow gives us.
4. Build the nafrec container (Apptainer, CUDA 13 / the Roihu GPU arch) and run it by hand on ~50 sample pages. Record: pages/min, model load time, GPU memory, output files, partial-failure behaviour.
   Outcome: numbers for chunk size + a working `run_htr.sh`.

**Phase 1: Roihu side**: `MD-roihu-htr/` repo: `run_htr.sh` (Slurm script), container def, model download script, `service.json`, `help/index.md`, `README`. Output naming contract: `<input-name>.page.xml`, `.alto.xml`, `.txt`, `manifest.json` (per-file status + error).

**Phase 2: FirecREST/S3 client in MD-consumers** (`src/hpc/firecrest.mjs`, `src/hpc/s3.mjs`): token fetch + refresh (client credentials, cache until ~expiry-60 s), submit / status / cancel, S3 up/down with multipart, retries with backoff on 429/5xx. Tested against a mock FirecREST server (no CSC needed in CI).

**Phase 3: adapter `roihu.mjs`**: gather window, canary, chunking, upload, submit, polling loop, progressive download, per-file `sendDone`/`sendError`, heartbeat for all held jobs, cancel detection (heartbeat false -> `scancel` + stop), restart re-attach, cleanup of Allas prefix after success (and TTL cleanup for orphans). Needs a small change in the main loop (`index.mjs`) so an adapter may claim several jobs; keep it opt-in per topic so other adapters are untouched.

**Phase 4: MessyDesk + UI**: register the service, check that long-running nodes look right in the UI (state "waiting in Roihu queue" vs "running", progress n/N). Probably only text in descriptor/help, but check `processing` status/SSE. Add the service to the consumers' wiki docs.

**Phase 5: hardening**: failure matrix tests (token expiry mid-job, Slurm TIMEOUT/OOM, Allas down, consumer restart, user cancel, duplicate submission), billing-unit guard (max pages per process node, per-day cap), logging of Slurm job id on the process node so a human can look it up in MyCSC.

## 4. Risks

- Slurm queue wait is unpredictable (minutes to many hours); UI must make that clear and leases must survive it via heartbeat.
- Heartbeat-held jobs: if the consumer crashes, leases expire after 120 s and the queue hands jobs out again, creating **duplicate Slurm submissions** unless state re-attach works (Phase 3).
- Project billing units are shared by everyone using MessyDesk; need an access/limit policy.
- Data protection: pages are copied to Allas and Roihu. Fine for open archive material; must be a conscious decision for user-uploaded data.
- **Allas setup pitfalls (phase 0, 2026-11-06).** `CreateBucket` first returned 403 because `allas-conf` had silently written an S3 config with empty keys: it printed HTTP 401 errors and a success summary anyway. The login failed with a CSC password containing spaces (CSC docs warn about spaces, `*`, `;` and quotes); after the password was changed and `allas-conf` re-run, the connection worked. A mismatched Allas project (201885 vs the Slurm project 2018805) also caused confusion, so the Allas project is configured separately (`ALLAS_PROJECT`). Allas capacity is limited: CSC's Roihu docs say not to request new Allas quota and recommend LUMI-O. Fallbacks if Allas stops being usable: FirecREST's own S3 staging (pre-signed URLs, per-user buckets) or LUMI-O. A robot account for production must have a password without special characters.
- nafrec is young (CUDA 13 / ROCm notes, TensorRT cache written to the working dir). Pin the version and the container.
- **Roihu GPU nodes are Nvidia GH200 (ARM/aarch64).** nafrec's `gpu` extra (CUDA 13, onnxruntime GPU, TensorRT) may not install there. Phase 0 measures GPU and the x86 CPU fallback; see [Roihu-phase0-runbook.md](./Roihu-phase0-runbook.md).
- FirecREST API generation is `v1` but documented as possibly changing; keep the client thin and in one file.

## 5. Open questions

Answered 2026-11-06:

| Question | Answer | Consequence |
|---|---|---|
| Auth | Personal tokens for the prototype | Token provider is an interface: `static` (token from env/file, 24 h, re-read on every request so it can be replaced without restart) now, `robot` (client credentials) later. On 401 the adapter does **not** fail the files: it holds the chunk and retries, logs "Roihu token expired". Running Slurm jobs keep running when the token expires. |
| Input | Page images (jpg/png/tif) only | No PDF handling; PDFs go through the existing split first. |
| Outputs | PAGE XML + plain text | `.page.xml` and `.txt` per page (no ALTO in v1). |
| Models | RF-DETR detection + multicentury TrOCR (fi/sv) | One task `htr`; no model param in v1. |
| Access/billing | Like other services, via user groups | Use the existing service access mechanism; no special cap code in v1 (still log pages per user). |
| Data | OK for open/archive material | Mention it in `help/index.md`. |
| Batching | Canary + chunks | As in section 2. |
| Consumer change | Not sure -> **recommendation below** | |

**Recommendation: consumer-side holding.** The backend already allows one adapter to claim many jobs and heartbeat them; cancel is visible as a failed heartbeat. Adding a backend "waiting on external system" state would touch queue schema, retry logic, UI state and batch abort, for a gain we cannot yet measure. Start consumer-side, behind an opt-in flag per topic. Revisit if Slurm queue waits of many hours make holding leases awkward, or if we run several consumers for the same topic.

Remaining small question: how many pages per user run do we expect (tens, thousands)? It sets `MAX_BATCH` and chunk size defaults; Phase 0 measurements will settle it.

## 6. Status (2026-11-06)

Phase 0 is done (see `Roihu-phase0-runbook.md`). Phases 1-3 are implemented and tested with mocks;
not yet run against the real Roihu and Allas from the new code.

| Part | Where |
|---|---|
| Adapter `roihu`: grouping, Allas upload, Slurm submit, polling, per-page delivery, cancel, restart, token wait | MD-consumers `src/adapters/roihu.mjs` |
| FirecREST and Allas clients | MD-consumers `src/hpc/firecrest.mjs`, `s3.mjs` |
| Main loop holds many jobs (opt-in `maxConcurrentJobs()`), `jobLost()` on heartbeat 404 | MD-consumers `src/index.mjs` |
| `check` and `setup` commands | MD-consumers `src/hpc/cli.mjs` (`npm run roihu`) |
| Service config, job script, setup script, user help, README | new repo dir `MD-roihu-slurm` |
| Tests | MD-consumers `tests/roihu.test.mjs`, `hpc.test.mjs`, `main-loop.test.mjs` |

Decisions made while building:

- **MD-llm pattern**: the service is a `CONFIG_JSON_PATH` file (descriptor + settings + help) and a job
  script; the adapter is generic, so another model is another config and script.
- **The separate canary job is dropped** (it costs about 2 minutes of start-up): the first outputs of the
  real job tell that it works, and a job without any result in the time limit is rejected with the end of its log.
- **Empty pages** (nafrec finds no text) give an empty `.txt`; pages nafrec fails on are rejected and retried by the queue.
- **PAGE XML** has the file type `xml`; the UI has no display for it and shows it as raw text. A small
  UI mapping (`fileTypes.js`) would give it a proper name and icon.
- **Submissions are never repeated** after a server error (a lost answer could start a second Slurm job).
- **An expired token** makes the pages wait, not fail.

**Per-user credentials (2026-11-10).** There are no system-wide keys: every run uses the user's own CSC project.
The service descriptor has `api_key_source: "user"` and a `credentials` form definition (token, project, optional
Allas project); the UI packs the values into one vault string (`mdcred1.` + base64url JSON) that MessyDesk's
vault keeps per run; the consumer fetches it with the task's `secret_ref`, reads the user's Allas keys from their
own Roihu `rclone.conf` through FirecREST (the user ran `allas-conf` there once), lets the job use that same rclone
config so that it gets no copy of the keys, and installs the environment and models in the user's project on the first
run. Local use keeps the `.env` setup with `API_KEY_MODE=service`. Details: `MD-roihu-slurm/process_explained.md`.

Next: run `check` and `setup` on the real system, then a small real run (README of MD-roihu-slurm); then
robot account instead of the personal token, the performance tuning, more models.
