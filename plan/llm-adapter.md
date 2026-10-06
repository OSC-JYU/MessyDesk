# LLM adapter plan

Status: plan only, no code. Questions answered by ari on 2026-10-06 (section 6): his answers for
Q11, Q13 and Q14, the recommendations for the rest. Repos read: MessyDesk (`rewrite`), MD-consumers (`rewrite`),
MessyDesk-UI (`rewrite`), MD-Gliner2. Claims are marked **[verified]** with a file reference or
**[inferred]** / **[check]**.

## 1. Goal

One way to run prompts against LLMs and vision-language models (VLMs) from any provider:
Ollama, OpenAI, Azure OpenAI, vLLM and other OpenAI-compatible servers, and Google Gemini. Plus an
LLM autotagger that works like MD-Gliner2's `classify_text`, where the user can give existing tags.

User flow asked for: **cruncher list → prompt → model → provider**. Prompts are `text` (text to
text) or `image` (image to text).

Architecture rules this plan keeps:

- The MessyDesk backend never calls services or providers. Consumers claim jobs and call providers.
- Provider settings and API keys live outside MessyDesk, with the consumer.
- Every service has its own `/config` and `/help` (`help/index.md` is the user help). An LLM
  provider is not our service, so section 4.4 says how the LLM consumers meet this rule.

## 2. What exists today

### MD-consumers: three separate adapters, no shared code

| Adapter | Calls | Key | Notes |
|---|---|---|---|
| `ollama.mjs` | `POST {DEV_URL}/api/chat` (or `/api/generate`) with `got` | none | JSON output through `format` (real JSON Schema), `temperature` from params, model fallback `OLLAMA_MODEL` |
| `azure-ai.mjs` | `AzureOpenAI` SDK, `chat.completions.create` | `AZURE_OPENAI_API_KEY` | `DEV_URL` is the Azure endpoint, `task.model.id` is the deployment, `task.model.version` the api-version. JSON output through `response_format: json_schema`, schema built from an **example object** (`createSchema`) |
| `gemini-ai.mjs` | `@google/genai` SDK | `GOOGLE_API_KEY` | `DEV_URL` ignored, images uploaded with `files.upload` |

All three send `result` as `.txt`/`.json` to `/api/nomad/process/files` and token counts as
`response.json` to `/api/nomad/process/files/metadata` **[verified]** adapters, `plan/consumer-calls.md`.
The three services were registered as `md-azure-ai`, `md-gemini` (and an Ollama topic), each with
`external_tasks: "prompts"` and a `models` map **[verified]** MessyDesk git history
`90df50c:services/md-azure-ai/service.json`, `6898ddc:services/md-gemini/service.json`. Those
descriptors are no longer in any local repo **[verified: not found]**.

### MessyDesk backend

- `Prompt` vertices: `name, content, description, type (text|image), output_type (text|json),
  json_schema, owner (user rid or "public")` **[verified]** `src/modules/prompts/prompts.ts`.
- A service with `external_tasks` offers the user's prompts as its tasks, filtered by the node
  type, and only if one of its `models` supports the node's format **[verified]**
  `src/modules/services/matching.ts:24-50`.
- `prepareTask` resolves `task.model` from `service.models` and, for single files, sets
  `task.params = task.system_params` **[verified]** `src/modules/processing/processing.ts:131-137`.
- Autotag: `results.ts:269` calls `tags.autotag` when `task.autotag` is set; `tags.autotag`
  understands `rois`, `file_tags` and Gliner's classification shape `{result: {category}}`
  **[verified]** `src/modules/tags/tags.ts:436-463`.

### MessyDesk-UI

- Prompts page with two sections, "Image to text" and "Text to text"; a prompt can have JSON output
  with a JSON schema **[verified]** `features/services/PromptsPage.vue`, `PromptDialog.vue`.
- Cruncher list shows each service as its own panel; a service with several models shows a model
  radio list first, then tasks (here: prompts) **[verified]** `crunchers/CruncherService.vue:16-18`.
  So today's order is **provider → model → prompt**, the reverse of what is wanted.
- `buildProcess` sends `params: task.values` (the user's values, e.g. temperature) and
  `system_params: {prompts, output_type, json_schema}` **[verified]** `crunchers/crunchers.js:127-139`.
- Tag picker param (`display: "tagpicker"`) gives either a comma string or
  `[{label, description}]` of existing tags **[verified]** `crunchers/TagPickerField.vue`.

### MD-Gliner2 pattern to copy

`classify_text` has `autotag: true` and a `labels` param shown as `tagpicker`. With existing tags
picked, the model only chooses among those labels and gets their descriptions as hints; output is
`{task, params, result: {category: "x" | ["x","y"]}}`, which the backend turns into tags
**[verified]** `MD-Gliner2/service.json`, `api.py:117-135, 208-218`.

## 3. Defects in the current path

These are reasons to rewrite rather than patch the three adapters.

1. **Input text is silently cut** to 2 000 characters (Ollama, Azure) or 4 000 (Gemini)
   **[verified]** `ollama.mjs:90`, `azure-ai.mjs:129`, `gemini-ai.mjs:107`. A user prompting a
   20-page text gets an answer about its first page and is not told.
2. **The user's per-run params are dropped** for single files: `prepareTask` replaces
   `task.params` (temperature etc.) with `system_params` **[verified]** `processing.ts:136`,
   UI `crunchers.js:128`. So the temperature field the old Gemini descriptor showed never arrived.
3. **`json_schema` means two different things**: Ollama passes it as a JSON Schema, Azure treats it
   as an example object and converts it **[verified]** `ollama.mjs:28-44`, `azure-ai.mjs:37-85`. A
   prompt that works on one provider breaks on the other.
4. **Gemini ignores JSON output** (always writes `result.txt`), ignores temperature, and **never
   deletes the files it uploads to Google** **[verified]** `gemini-ai.mjs:83, 133-148`.
5. Azure hard-codes `temperature: 1` and 4 096 output tokens, and labels every image
   `image/png` **[verified]** `azure-ai.mjs:148, 175-176`.
6. No retry or back-off on 429/5xx, no concurrency limit: a set of 500 files hits rate limits and
   fails file by file **[inferred]** from the adapters (no retry code).
7. A service with `external_tasks` can only offer prompts; it cannot also have fixed tasks such as
   an autotagger, and `prepareTask` returns before the autotag flag is set **[verified]**
   `matching.ts:46-49`, `processing.ts:134-137`.
8. Set matching still knows a `pdf` prompt type the UI cannot create **[verified]** `matching.ts:32`.

## 4. Proposed design

### 4.1 Two adapters, one shared core

In MD-consumers:

| File | Covers |
|---|---|
| `adapters/llm/core.mjs` | Everything provider-neutral: read input (text or image), build the chat request from prompt + input, input-size check, output writing (`.txt` / `.json` / autotag JSON), `response.json` metadata, retry with back-off honouring `Retry-After`, error mapping |
| `adapters/llm-openai.mjs` | **OpenAI-compatible** Chat Completions: OpenAI, Azure OpenAI (v1 endpoint `https://<res>.openai.azure.com/openai/v1/`, or classic deployment + api-version), Ollama (`/v1`), vLLM, LM Studio, LiteLLM, Mistral and others. One `openai` SDK client with `baseURL`, key and extra headers from config |
| `adapters/llm-gemini.mjs` | Google Gemini with `@google/genai`: inline image data (files API only for large files, always deleted after), native JSON schema, token metadata |

Grouping Ollama, OpenAI and Azure into one adapter works: all three speak the Chat Completions
format, including images as `image_url` data URLs and `response_format: json_schema` **[check]**
Ollama's structured-output support in its `/v1` endpoint and Azure's v1 endpoint for the deployed
API version. Ollama's native `/api/chat` is not needed.

Gemini gets its own adapter because its native API handles PDFs, large files and metadata better.
Gemini also has an OpenAI-compatible endpoint, so `llm-openai` could talk to it as a stopgap
(see Q6).

The old adapters (`ollama`, `azure-ai`, `gemini-ai`) and their service ids (`md-azure-ai`,
`md-gemini`) are not kept: no aliases, new `md-llm-*` ids only (Q13).

### 4.2 One consumer per provider, same adapter

Each provider deployment is its own topic and consumer, e.g. `md-llm-ollama`, `md-llm-openai`,
`md-llm-azure`, `md-llm-gemini`, `md-llm-vllm`. This keeps what already works per service:
`location` (on-premise / external) and `access` (open / proprietary) badges, `service_groups`
gating (who may send texts to external APIs), separate API keys, and separate queues so a slow
provider does not block another.

### 4.3 Config: `CONFIG_JSON_PATH`

One JSON file per provider deployment, outside MessyDesk:

```json
{
  "service": {
    "id": "md-llm-azure",
    "adapter": "llm-openai",
    "name": "Azure OpenAI",
    "category": "generative",
    "location": "external",
    "access": "proprietary",
    "service_groups": ["AZURE-AI"],
    "external_tasks": "prompts",
    "params_help": { "temperature": { "...": "..." }, "max_output_tokens": { "...": "..." } },
    "tasks": { "autotag": { "...": "see 4.7" } },
    "models": {
      "gpt-5.1": {
        "name": "GPT-5.1",
        "family": "gpt-5.1",
        "supported_types": ["text", "image"],
        "supported_formats": ["txt", "jpg", "jpeg", "png"],
        "max_input_tokens": 200000,
        "structured_output": true
      }
    }
  },
  "provider": {
    "base_url": "https://<resource>.openai.azure.com/openai/v1/",
    "api_key_env": "AZURE_OPENAI_API_KEY",
    "auth_header": "api-key",
    "headers": {},
    "model_map": { "gpt-5.1": "my-gpt51-deployment" },
    "timeout_ms": 120000,
    "max_concurrency": 4,
    "retry": { "max_attempts": 5, "initial_delay_ms": 1000 },
    "store": false
  }
}
```

- `service` is the descriptor MessyDesk sees. The consumer registers it as is.
- `provider` never leaves the consumer. **Keys are never in the file**, only the name of the env
  var that holds them (`api_key_env`).
- `model_map` maps the model id users pick to the provider's own name (Azure deployment name,
  Ollama tag `gpt-oss:20b`, vLLM `openai/gpt-oss-20b`).
- `family` groups the same model across providers in the UI (section 4.5).
- `base_url` replaces `DEV_URL` for LLM consumers. The start-up probe calls `GET {base_url}/models`
  instead of `/config`.
- `SERVICE_JSON_PATH` keeps working for every other consumer. For an LLM consumer it is accepted
  as a descriptor-only file, with the provider block coming from env vars.

### 4.4 `/config` and `/help` for a provider we do not run

The LLM consumer is the only "service" we own here, so the config directory acts as the service:

```
MD-llm/                      (new repo, outside MessyDesk; see Q4)
  providers/ollama.json  openai.json  azure.json  gemini.json  vllm.json
  help/index.md              user help: prompt types, JSON output, models, privacy of external providers
  compose.llm.yaml           example: one consumer per provider
```

Help reaches MessyDesk without the backend calling anything: the consumer **pushes** `help/index.md`
at start-up (see Q5). The descriptor is registered as today.

### 4.5 UI flow: cruncher list → prompt → model → provider

Done in the UI from the existing `GET /api/services/files/{rid}` response, no API change:

1. **Cruncher list**: all services with `external_tasks: "prompts"` collapse into one entry,
   "AI prompts" (plus "AI autotagger", section 4.7).
2. **Prompt**: the user's and public prompts that fit the node (text prompts for text, image prompts
   for images), with their output type.
3. **Model**: the union of models over those services that support the node's format, grouped by
   `family` (so "gpt-oss 20B" appears once even if Ollama and vLLM both serve it).
4. **Provider**: the services that offer that model, with their badges (on-premise / external,
   open / proprietary). Preselected when only one.
5. **Params** (temperature, max output tokens) from the chosen service's `params_help`, then Run.

The process request is the same as today: `service` = the chosen provider's topic, `model`,
`id` = prompt key, `system_params`, `params`.

### 4.6 Message contract and backend fixes

What the adapter receives in `task`:

```
task.model   = { id, name, family, ... }                    // resolved from the descriptor
task.params  = { prompts: { content }, output_type, json_schema,   // from the prompt
                 temperature, max_output_tokens }                   // from the user
```

MessyDesk changes (rewrite branch):

1. `prepareTask` and `redispatch` **merge** `system_params` over the user's `params` instead of
   replacing them (defect 2).
2. A service may have both `external_tasks` and fixed `tasks`: `pickTasks` returns prompts plus
   the matching fixed tasks, and `prepareTask` only takes the prompt path when the task id is not a
   fixed task, so `autotag` is set for the autotagger (defect 7).
3. `prepareTask` resolves `task.model` for every service with `models` (already planned in
   `embeddings-and-topics.md`).
4. Drop the `pdf` prompt type from set matching, or add it to the UI (Q12).
5. Store `provider` (service id) and `model_family` on the Process node next to `model`, so
   results from the same model on different providers can be compared.

### 4.7 LLM autotagger

A fixed task in each LLM descriptor, next to the prompts:

```json
"autotag": {
  "name": "Tag with AI",
  "description": "Choose tags for the text or image from the categories or existing tags you give",
  "autotag": true,
  "supported_types": ["text", "image"],
  "params": { "labels": "", "multi_label": true, "instructions": "" },
  "params_help": {
    "labels": { "name": "Categories", "display": "tagpicker", "help": "..." },
    "multi_label": { "name": "Allow several tags", "display": "checkbox" },
    "instructions": { "name": "Extra guidance", "display": "textinput", "help": "Optional, e.g. 'tag the main topic only'" }
  }
}
```

- The adapter builds the prompt from the labels and their descriptions and asks for structured
  output whose values are an **enum of exactly those labels**, then drops anything not in the list.
- Output is the Gliner classification shape `{task, params, result: {category: [...]}}`, so
  `tags.autotag` already handles it; confidence is `null` (LLMs do not give a calibrated score).
- Works for images too with a vision model, which Gliner cannot do.
- An open mode ("suggest new tags") is possible with `file_tags` output; see Q9.

### 4.8 Inputs, outputs, limits

- **Text**: no silent cut. The adapter estimates tokens (characters / 4 is enough for a guard)
  against the model's `max_input_tokens`; over the limit the job fails with a clear message
  (see Q8 for chunking).
- **Images**: MIME type from the extension; TIFF and very large images converted and scaled down
  with `sharp` (already a dependency) to the model's `max_image_edge`.
- **Output**: `<original name>.txt` or `.json`. JSON is parsed and checked against the schema; a
  reply that is not valid JSON is saved as an error file with the raw text, not as a bare
  `{error}`.
- **Metadata** `response.json`: model, provider, tokens in/out, finish reason, latency, retries.
- **JSON schema** (defect 3): stored as the user typed it. The adapter treats it as a JSON Schema
  when it has `type` or `properties`, otherwise as an example object and converts it (Azure's
  `createSchema`). Same behaviour on every provider.
- **Sets**: per-consumer `max_concurrency`, retries on 429/5xx with back-off. Gemini's
  `set_disabled` goes away once retries exist.
- **Privacy**: Gemini uploads deleted after use; OpenAI/Azure requests sent with `store: false`.

### 4.9 Token limits per service group (Q11)

Commercial providers bill per token, and production access is already controlled with service
groups, so the limits live on the **ServiceGroup**. The backend enforces them without calling any
provider, from usage the consumers already report.

What exists: every LLM job's `response.json` is stored as a `Usage` row with `user, process,
service, model, in, out, total, time` **[verified]** `src/modules/results/results.ts:464-487`.
Nothing reads it back yet.

Additions:

1. **ServiceGroup fields** (admin-edited, all optional; empty = no limit):

   ```json
   "token_limits": {
     "period": "month",
     "per_user": 2000000,
     "group_total": 50000000,
     "per_job_max_output": 4096
   }
   ```

   `per_user` caps each member's tokens in the period, `group_total` caps the whole group,
   `per_job_max_output` caps `max_output_tokens` on a single job.
2. **Which group pays**: a job runs under the group that gives the user access to the service
   (`service.service_groups` ∩ `user.service_groups`). The backend writes that `service_group` on
   the task and on the `Usage` row. If several groups match, the first one in the service's list
   with budget left pays.
3. **Checks in the backend, not in the consumer**:
   - At **dispatch** (single file or set): refuse with a clear message when the user's or the
     group's budget for the period is used up. For a set, also refuse when a rough estimate
     (input characters / 4 + max output tokens, times files) is well over what is left; the UI
     shows that estimate before Run.
   - At **claim**: before handing a queued LLM job to a consumer, check again; a job over budget is
     failed with "token limit reached" instead of being sent. This stops a running batch close to
     the limit (overshoot is at most the jobs already in flight, bounded by the consumer's
     `max_concurrency`).
   - `per_job_max_output` is merged into `task.params.max_output_tokens` at dispatch, so the adapter
     never asks the provider for more.
4. **Usage reading**: `GET /api/me/usage` (the user's tokens this period per group and service)
   and an admin view per group. Both are new routes, read-only.
5. Local / open providers (Ollama, vLLM on-premise) are counted the same way but usually have no
   limits set.

Usage rows need an index on `(service_group, time)` and `(user, time)` for the sums; one
`SELECT sum(total)` per check is cheap at the expected row counts **[inferred]**, to be confirmed in
the performance tests.

## 5. Work order

1. MessyDesk backend fixes 4.6 (1, 2, 3, 5) with tests.
2. MD-consumers: `llm/core.mjs` + `llm-openai.mjs`, `CONFIG_JSON_PATH` loading, tests against a
   mock OpenAI-compatible server; then try with local Ollama.
3. `llm-gemini.mjs`.
4. Autotagger task (adapter + descriptor).
5. UI: combined "AI prompts" entry with prompt → model → provider; autotagger entry.
6. `MD-llm` config repo with provider files, `help/index.md`, example compose; help push.
7. Delete the old three adapters.
8. Token limits per service group (4.9): Usage attribution, checks at dispatch and claim, admin UI.

## 6. Questions



| # | Question | Recommendation |
|---|---|---|
| Q1 | Should all LLM providers appear as **one** entry in the cruncher list, with the provider chosen last? | **Yes**, grouped in the UI from the existing services response; no API change. |
| Q2 | The same open model on two providers (Ollama and vLLM) should show as one model? | **Yes**, via a `family` key on each model; default is the model's display name. |
| Q3 | Config as one `CONFIG_JSON_PATH` file with a `service` block (descriptor) and a `provider` block (URL, key env var name, model map, limits)? | **Yes**. Keys only through env vars named in the file; `SERVICE_JSON_PATH` still works. |
| Q4 | Where do the provider configs and LLM help live? | **New repo `MD-llm`** (configs, `help/index.md`, example compose). Alternative: a folder in MD-consumers. |
| Q5 | Help for a service we do not run: may the consumer **push** its `help/index.md` to the backend? This adds one route (`POST /api/services/{id}/help` with a markdown body, service auth), so it is an API change. | **Yes, push.** Alternative without API change: `help_url` pointing at a static file, which needs network access from the backend. |
| Q6 | Gemini: own native adapter, or through Gemini's OpenAI-compatible endpoint? | **Native adapter** (PDFs, files, metadata); the compatible endpoint is fine as a stopgap. |
| Q7 | Prompt `json_schema`: real JSON Schema or an example object? | **Accept both**, detected as in 4.8, same on every provider. |
| Q8 | A text longer than the model's context: fail clearly, cut with a note in the result, or split into chunks and combine? | **Fail clearly** first; chunking later per prompt (it changes what "summarise" means). |
| Q9 | Autotagger: only the user's categories / existing tags, or also an open mode where the LLM suggests new tags? Images too? | **Both modes, text and images.** Closed mode first. |
| Q10 | Which per-run params should users see? | **Temperature and max output tokens.** Reasoning effort later for reasoning models. |
| Q11 | Cost guard for external providers on large sets? | **Decided:** token limits defined on the service group, enforced by the backend at dispatch and claim (section 4.9). |
| Q12 | The `pdf` prompt type in set matching: drop it, or add PDF prompts (Gemini can read PDFs)? | **Drop for now**; PDFs go through text extraction first. |
| Q13 | Service ids: new `md-llm-*` topics, or keep `md-azure-ai` / `md-gemini`? | **Decided:** old ids and adapters not needed; new `md-llm-*` ids only. |
| Q14 | "vLLM" in the request: the vLLM server, vision-language models, or both? | **Decided:** vision LLMs (image prompts, image autotagging); the vLLM server is covered by `llm-openai` too. |

Q1–Q10 and Q12: ari accepted the recommendations (2026-10-06).
