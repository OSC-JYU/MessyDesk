# Roihu Phase 0 runbook (spikes, run by hand)

Goal: get the numbers and a working Slurm script before writing any MessyDesk code.
Everything here is run by a person; nothing is automated yet. Replace `project_XXXXXXX` with the billing project.

Facts checked from docs.csc.fi (2026-11-06):

- GPU nodes are **Nvidia GH200 = ARM (aarch64) CPU + H100**, 4 GPUs per node. CPU nodes are x86 (AMD Turin, 2 x 192 cores).
- GPU partitions: `gputest` (15 min, 1-2 nodes, for quick tests), `gpumedium` (36 h, 1 node, up to 4 GPUs); CPU partitions: `test` (15 min), `small` (72 h), `medium`, `longrun` ...
  Full list: https://docs.csc.fi/computing/running/batch-job-partitions/
- `$TMPDIR` is node-local temporary storage, free, available in every job. More fast scratch can be requested on any partition as disaggregated NVMe, mounted under `/sbf/`: `#SBATCH --bb="#BB_LUA SBF storagesize=20G path=/sbf/data"` (costs billing units; ask only what is needed).
- GPU request syntax: `#SBATCH --gres=gpu:gh200:<n>` (per node; 4 GPUs per node). `gputest` gives one GH200. Each GPU comes with 72 CPU cores and 212 GiB RAM.
- Allas on Roihu: `module load allas`, then `allas-conf project_<number>` (S3 is the default here, not Swift). `check-allas-connections` lists connections. The S3 config is permanent and global, so `rclone`/`a-put`/`a-get` work inside batch jobs without running `allas-conf` again. Re-running `allas-conf` affects already submitted jobs, so use the **project-specific rclone endpoint name** in job scripts (see https://docs.csc.fi/computing/allas-in-roihu and https://docs.csc.fi/data/Allas/allas_batchjobs).
- Containers: Apptainer, built with `apptainer build --fakeroot container.sif container.def` and `export APPTAINER_CACHEDIR=$TMPDIR`. Roihu GPU base images: `satama.csc.fi/r_installation_spack/core-gpu-gcc-14.3.0-cuda-12.9.1:v2026_03` (also cuda-13.1.1 with gcc-15.2.0, and cuda-12.6.3 with gcc-13.4.0); inside the `%post` run `. /opt/activate.sh`; run on GPU nodes with `apptainer run --nv container.sif <cmd>`. CPU base: `core-cpu-gcc-15.2.0:v2026_03`. Details: https://docs.csc.fi/support/tutorials/roihu
- Python: module `python-pytorch/2.13` (default) and `2.10` exist for both Roihu-GPU and Roihu-CPU. Check what is already there with `module spider <name>` before installing.
- FirecREST: `https://api.roihu.csc.fi/v1`, subsystems `cpu` and `gpu`, Swagger at `/v1/docs/`, personal token (24 h) from https://my.csc.fi/firecrest-token.

Things still marked **(check)** are not confirmed by the docs (mostly the exact FirecREST request/response fields and nafrec flags) and must be verified against `/v1/docs/` or `--help`.

## Step 0: prerequisites

- CSC account that is a member of the billing project, with Roihu access.
- A personal FirecREST token. Keep it in your shell only, never in a file in a repo:

```bash
export FIRECREST_TOKEN='<paste token>'
export FC=https://api.roihu.csc.fi/v1
export PROJECT=project_XXXXXXX
```

- ~50 sample page images (jpg/png/tif) in a local folder `samples/`. Use real archive pages, not tiny test images, because speed depends on text density.

## Step 1: token and API work (curl)

```bash
# who am I, per subsystem  (check path: /status/{system}/userinfo)
curl -s -H "Authorization: Bearer $FIRECREST_TOKEN" $FC/status/gpu/userinfo | jq .

# list my jobs (this one is in the CSC docs)
curl -s -H "Authorization: Bearer $FIRECREST_TOKEN" $FC/compute/gpu/jobs | jq .

# the real request/response schemas
curl -s $FC/openapi.json | jq '.paths | keys'
```

Pass: 200 responses. 401 = token expired or wrong audience (make sure it is a *FirecREST* token).
Write down which `account`/project field the job submission needs and the exact job body schema.

## Step 2: hello-world job through FirecREST

Create `hello.sh`:

```bash
#!/bin/bash
#SBATCH --job-name=md-hello
#SBATCH --account=project_XXXXXXX
#SBATCH --partition=gputest
#SBATCH --gres=gpu:gh200:1
#SBATCH --time=00:05:00
#SBATCH --output=md-hello-%j.out
hostname; uname -m; nvidia-smi -L; echo "TMPDIR=$TMPDIR"; df -h "$TMPDIR" | tail -1
module list 2>&1 | head
```

Submit (FirecREST v2 body is `{"job": {"script": "...", "workingDirectory": "..."}}` **(check in Swagger)**; the working directory must exist, e.g. under `/scratch/$PROJECT/$USER/md-roihu/`):

```bash
WD=/scratch/$PROJECT/$USER/md-roihu
curl -s -X POST -H "Authorization: Bearer $FIRECREST_TOKEN" -H "Content-Type: application/json" \
  $FC/compute/gpu/jobs \
  -d "$(jq -n --arg s "$(cat hello.sh)" --arg wd "$WD" '{job:{script:$s, working_directory:$wd}}')" | tee submit.json
JOB=$(jq -r '.jobId // .job_id' submit.json)      # (check field name)
curl -s -H "Authorization: Bearer $FIRECREST_TOKEN" $FC/compute/gpu/jobs/$JOB | jq .
```

Alternative that avoids hand-written JSON: `pip install pyfirecrest` and `firecrest --help`
(PyFirecREST v2 API; token-command support from v3.8.0, see docs.csc.fi/computing/firecrest/pyfirecrest/).

Record:

| What | Value |
|---|---|
| Job body schema that worked | |
| Job state names returned (PENDING / RUNNING / COMPLETED / FAILED / TIMEOUT ...) | |
| Time from submit to RUNNING on `gputest`, on `gpumedium`, on CPU `small` | |
| Output of `uname -m` on gpu (expect `aarch64`) and on cpu (expect `x86_64`) | |
| How do I read the job's stdout/stderr through the API | |
| Cancel works (`DELETE $FC/compute/gpu/jobs/$JOB`) | |

Repeat once with `cpu` and partition `test`.

## Step 3: Allas from a compute node

Do this by ssh on a Roihu login node (no FirecREST needed). The question is how a job reaches Allas and what the credentials look like.

```bash
ssh <user>@<roihu login host>          # see docs.csc.fi/computing/connecting
module load allas
allas-conf $PROJECT                      # asks for your CSC password; S3 is the default on Roihu
check-allas-connections
rclone listremotes                       # note the project-specific remote name, use it below instead of "allas:"
rclone mkdir <remote>:md-roihu-test-$USER
rclone copy samples <remote>:md-roihu-test-$USER/in
```

Then a Slurm script that does the whole round trip on the node (this is the shape of the future `run_htr.sh`):

```bash
#!/bin/bash
#SBATCH --account=project_XXXXXXX
#SBATCH --partition=gputest
#SBATCH --gres=gpu:gh200:1
#SBATCH --time=00:10:00
set -euo pipefail
module load allas
B=<remote>:md-roihu-test-$USER      # project-specific remote name from "rclone listremotes"
W=$TMPDIR/work; mkdir -p $W/in $W/out
rclone copy $B/in  $W/in
for f in $W/in/*; do cp "$f" "$W/out/$(basename "$f").copy"; done   # stand-in for nafrec
rclone copy $W/out $B/out
```

Record: did credentials work inside the job (docs say the S3 config is permanent and global, so it should) · upload/download MB/s · whether `$TMPDIR` is big enough for 500+ pages (see `df`) · whether `rclone copy` of single finished files while the job is still running works (needed for progressive results).

Also try FirecREST's own pre-signed-URL flow once, following the examples in
https://docs.csc.fi/computing/firecrest/data-transfer-s3/ (`POST /filesystem/gpu/transfer/upload`). Note whether it lands the data in `/scratch` (small!) rather than leaving it in Allas. If it does, we use our own bucket with rclone from the job and use FirecREST only for submit/status/cancel.

Clean up: `rclone purge <remote>:md-roihu-test-$USER`.

### Step 3 result (2026-11-06, `/home/arihayri/Projects/roihu/allas-test.py`, CPU node, partition `test`, x86_64)

| What | Value |
|---|---|
| Allas credentials from a compute node | work; the S3 config in the home directory is picked up in a non-interactive job. The script needs `#!/bin/bash -l` so that `module` exists |
| Upload 20 x 2 MB files | 0.51 s, 78 MB/s |
| Upload one 200 MB file | 3.2 s, 63 MB/s |
| Download 240 MB | 0.7 s, 348 MB/s |
| Checksums after round trip | ok |
| `$TMPDIR` | `/tmp`, 578 GB, 1% used (GPU node not measured) |
| Progressive results: job uploads a file, local consumer polls every 3 s | object visible to the consumer 0.4-2.9 s after the upload started, so streaming results works |
| Slurm queue wait on `test` | 3 s (nearly empty queue, not representative) |
| Setup problems met | `allas-conf` must succeed (a password with spaces gave HTTP 401 and a silently empty key); `s3allas-project_<n>` remote name; bucket `project-2018805-md-roihu-test`; Allas must be enabled on the project |

Consequences for the design: transfer speed is not a bottleneck (1.5 GB of page images is about half a minute each way), so the plan "images in Allas, job pulls to node-local disk, results pushed per page, consumer polls the bucket" holds. The consumer needs the S3 key pair of the Allas project (`ALLAS_ACCESS_KEY`, `ALLAS_SECRET_KEY`) in its own environment. Not yet tested: the same on a GPU node, and many small objects (thousands) per prefix.

## Step 4: nafrec by hand

This is the risky part. GPU nodes are aarch64, and nafrec's `gpu` extra targets CUDA 13 + onnxruntime GPU + TensorRT; aarch64 wheels may be missing. So measure **two** setups and pick later:

- A. GPU (aarch64, GH200): try first.
- B. CPU (x86, `cpu` or `cpu-openvino` extra) on partition `small`: the fallback, and the TrOCR-large model may be acceptably fast if we batch.

On a Roihu login node of the matching architecture (GPU login node for A, normal login node for B):

```bash
cd /projappl/$PROJECT/$USER && mkdir -p md-roihu && cd md-roihu
module spider python-pytorch                                # CSC's PyTorch exists for GPU (aarch64) and CPU (x86)
module load python-pytorch/2.13                             # preferred: avoids a hand-picked torch wheel
python -m venv --system-site-packages .venv-gpu && source .venv-gpu/bin/activate
# if you need Python 3.12 exactly, or the module's torch does not satisfy nafrec, use uv instead:
#   curl -LsSf https://astral.sh/uv/install.sh | sh; uv venv --python 3.12 .venv-gpu
#   uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130   # (check: aarch64 wheel exists?)
pip install 'nafrec[gpu]'
python -c "import torch, onnxruntime as o; print(torch.cuda.is_available(), o.get_available_providers())"
```

Pass for A: `torch.cuda.is_available()` is `True` and onnxruntime lists `CUDAExecutionProvider`. If installing fails, write down the exact error and go to B (`uv venv .venv-cpu`, `uv pip install 'nafrec[cpu]'`).

Models (set `HF_HOME` under `/projappl`, not `~`, to protect the home quota):

```bash
export HF_HOME=/projappl/$PROJECT/$USER/md-roihu/hf
uv pip install 'huggingface_hub[cli]'
hf download Kansallisarkisto/rfdetr-textline-textregion-detection-2xl
hf download Kansallisarkisto/multicentury-htr-model
hf download Kansallisarkisto/cyrillic-latin-textline-classifier    # optional; v1 is latin only
```

Look at what files the detection repo contains (`.pth` weights), and run `nafrec --help` to learn the flag names for: PAGE output, ALTO output, device, batch size, TrOCR processor path, TensorRT on/off **(check all)**.

Run on a small test first, in an interactive GPU session (`sinteractive`, or `sbatch` with partition `gputest`, 15 min limit):

```bash
mkdir -p $TMPDIR/run && cd $TMPDIR/run         # TensorRT writes engine cache to cwd
/usr/bin/time -v nafrec \
  --detection_model_path <rfdetr .pth> \
  --recognition_model_path <multicentury model dir> \
  --processor_path <multicentury model dir> \
  --input_folder ~/samples10 \
  <flags for PAGE XML output> 2>&1 | tee nafrec.log
```

Then the full 50 pages. Record:

| What | GPU (A) | CPU (B) |
|---|---|---|
| Install worked, exact versions (torch, onnxruntime, nafrec) | | |
| Model load time (first image) | | |
| Pages/min for 50 pages, after warm-up | | |
| Peak GPU / RAM use | | |
| Output files produced per page and their names | | |
| Does one broken image (e.g. truncated jpg) kill the whole run or just that page | | |
| TensorRT first-run cache time (if enabled) | | |
| Do page images with no text give empty XML or an error | | |

Check quality on 3-4 pages by eye (does the text read as Finnish/Swedish, are line boundaries sensible).

### Step 4 setup result (2026-11-06, `nafrec-test.py setup`, GPU node, aarch64)

Works on the GPU node without a container:

| What | Value |
|---|---|
| Base | `module load python-pytorch/2.13` gives Python 3.12.14, torch 2.13.0+cu130, `cuda_available=True`, GH200 120GB. The login node's system Python is 3.9, so the module must be loaded before creating the venv |
| venv | `python -m venv --system-site-packages /scratch/project_2018805/messydesk/nafrec/venv-aarch64-gpu`; `pip install nafrec onnxruntime` took 25 s (nafrec 0.3.0, rfdetr 1.11.2, transformers 5.16.1, onnxruntime 1.31.1) |
| onnxruntime providers | CPU only (`onnxruntime` plain build, no CUDA provider). Fine for RF-DETR + TrOCR, which run on PyTorch; only PP-OCR/classifier would use ONNX |
| Models | detection `checkpoint_best_total.pth` 148 MB (single file); recognition `pytorch_model.bin` 2.1 GB; download 15 s; total 2.5 GB on /scratch |
| Compute node internet | works (pip and Hugging Face) |
| Setup wall time | about 1.5 min after start |

### Step 4 run result (2026-11-06, `nafrec-test.py run --images htr-sivut --count 20`, GPU node, gputest)

20 Finnish book pages (PNG, ~1050 x 1290 px) went through Allas and nafrec (RF-DETR detection + multicentury TrOCR) on one GH200; all 20 gave PAGE XML + JSON, no failures.

| What | Value |
|---|---|
| Canary batch, 5 pages (one nafrec process, includes start-up) | 75.6 s |
| Main batch, 15 pages (separate nafrec process) | 82.3 s |
| Estimate from the two runs | **superseded by the 50-page run below**: the first guess (0.7 s/page) was wrong |
| GPU memory peak | 4.7 GiB (of 96 GiB), so many pages in parallel or other jobs on the same GPU are possible |
| Input download Allas -> node | 1.5 s for 20 pages |
| End to end as seen by the consumer | last result 165 s after submit, results arrive per page-batch |
| Output | PAGE XML per page (20-56 text lines per page), JSON per page (list with one entry per region), `.txt` made by the consumer from the XML |
| Text quality | readable Finnish, hyphenation marks kept (`¬`, `-`), occasional recognition slips |
| Warnings | only rf-detr / TracerWarning noise (RF-DETR is traced at start-up); no CUDA fallback |
| Oddities | `page_conf_*` are NaN on every page; `language` guessed wrong on one page (sl); nafrec adds a `page/` subfolder to `--xml_folder` (script now uses `--xml_folder $W/out`) |
| boto3 against Allas | needs `request_checksum_calculation="when_required"` (else `MissingContentLength` on upload) |

Consequences for the design:

- **Start-up dominates small jobs**: each nafrec process needs 65-125 s before its first page (model load from /scratch, RF-DETR tracing, CUDA init), measured from the per-page `Created` stamps in the XML files. Once running it does about **1.1 s per page with defaults, 0.75 s per page with `--trocr_batch_size 32 --cpu_processes 16`** (50 pages, one GH200). So **one nafrec process must get the whole chunk**, and the planned separate canary process costs about 2 minutes. Replace it: let the consumer watch the first outputs of the real job and cancel when no page appears in about 5 minutes.
- **More GPUs do not pay off at this scale**: 4 GPUs give 0.61 s/page against 0.76 on one, and add about a minute of start-up. 50 pages is too little work to feed 4 workers; re-test with 300+ pages before deciding. Use one GPU per job for now (smaller allocation, shorter queue wait).
- Capacity: about 55-80 pages/min per GPU after start-up. A 1000-page set is about 15-20 min plus 1-2 min start-up on one GPU. Limits are job time limits (`gputest` 15 min, `gpumedium` 36 h), queue wait and how soon results should appear. Chunk 300-1000 pages; start-up is then under 10% of the job. Multi-GPU (`--gpus 4`) is not yet measured.
- Results are only written when pages finish, so the progressive polling in Allas works for streaming the output to MessyDesk.
- The CPU fallback (x86) is untested; it is not needed unless GPU queue waits are a problem.

### Step 4 run result, 50 pages (2026-11-06, `--count 50`, GPU node)

| What | Value |
|---|---|
| Main batch, 45 pages (canary 5 before it) | 179.9 s total, including a second nafrec start-up of about 105 s |
| What the XML `Created` stamps say | the gap between canary and main batch is the second process start-up: 66 s (20-page run) and 105 s (50-page run). Pages themselves: 1.1-1.7 s each |
| Baseline, 50 pages, no canary (14:27) | 128.4 s total; pages written over 58 s, so about 1.1 s/page and about 70 s start-up |
| `--trocr_batch_size 32 --cpu_processes 16` (14:32) | 164.7 s total (start-up about 125 s on a different node, cold files); pages written over 37 s, so **0.75 s/page, about 30% faster than baseline** |
| `--gpus 4` (20:00, 4 x GH200, `gpumedium`) | 214.1 s total, of which about 180 s before the first page (four workers each load and trace the models); pages written over 30 s = **0.61 s/page**, only about 20% faster than one GPU with batch 32; GPU utilization 1% on every GPU over the whole job |
| `--trocr_batch_size 32 --cpu_processes 16 --split_workers` (20:10, 1 GPU) | 171.4 s total; page phase 34 s = 0.69 s/page (no real gain over 0.76 without `--split_workers`); GPU utilization 22% in the page phase (4 of 32 samples above 50%, small sample), peak memory 13.6 GiB; about 137 s before the first page |
| GPU memory peak | 4.7 GiB baseline, 10.0 GiB with batch 32 (of 96 GiB) |
| GPU utilization (batch 32 run) | average 5%, only 3 of 165 one-second samples above 50%: the GPU is idle most of the time, partly because start-up is most of the job, but the page phase is also not GPU-bound (CPU or pipeline limited) |
| Outputs | 50 PAGE XML + 50 JSON, no errors; 150 objects in Allas (in, xml, json), all deleted after the run |

Conclusion so far: page speed is about 0.6-0.8 s/page whatever the settings (about 75-100 pages/min per GPU), the stages do not wait for each other (`--split_workers` gives nothing), and the GPU is not saturated. Further page-phase tuning has little to win; **start-up (65-180 s) is what to reduce**. `nafrec-test.py run` now prints `RESULT startup_seconds` for the main batch. Ideas to test: copy the models to `$TMPDIR` before starting, keep nafrec's models loaded between jobs (Python API, USAGE.md), or pick the node type with the fastest start.

Measuring per page from the XML stamps avoids the start-up noise (`awk`/python over `<Created>` in `nafrec-out/<run>/page/*.xml`). Next experiments on the same 50 pages (nafrec options from ARGS.md), compare the page span, not the total:

- `--trocr_batch_size 32 --cpu_processes 16`: done, 30% faster. Try the two separately and then larger values (64, 32 processes).
- `--fp16_rec --fp16_det`
- `--split_workers` (detection and recognition in parallel on the same GPU)
- `--workers_per_gpu 2`
- then all 4 GPUs with `--gpus 4` on `gpumedium`
- start-up: copy the models to `$TMPDIR` first, or keep the process running between jobs (nafrec has a Python API that keeps models loaded, see USAGE.md)

4 GPUs (`--gpus 4`, defaults otherwise, 50 pages, 20:00): 214 s total, but the pages were written over only 30 s (0.6 s/page, 1.8x the 1-GPU baseline); the other ~180 s was start-up, four model workers each loading and tracing the models. GPU utilization 1% on every GPU. So 50 pages is too small to measure multi-GPU; use 300+ pages. Page output arrives in bursts (many 0.0-0.1 s gaps), so use the span, not single gaps. Open question: what limits the page phase if not the GPUs (CPU post-processing of polygons, image loading, small TrOCR batches)? The job now logs `cpu_busy_*` (vmstat) to tell.

`nafrec-test.py run` takes `--nafrec-args`, `--gpus` and `--canary 0` for these.

## Step 5: turn it into a container (only if A or B works)

Apptainer on Roihu is the normal route. Build from CSC's GPU base image (`Bootstrap: docker`, `From: satama.csc.fi/r_installation_spack/core-gpu-gcc-15.2.0-cuda-13.1.1:v2026_03`, since nafrec targets CUDA 13; fall back to the cuda-12.9.1 image if the wheels need it), run `. /opt/activate.sh` in `%post`, then install torch/nafrec with the steps above. Build on a GPU login node (the image must match the node architecture) with `export APPTAINER_CACHEDIR=$TMPDIR; apptainer build --fakeroot nafrec.sif nafrec.def`. Put the `.sif` (~16 GB base) and models under `/projappl/$PROJECT/...` and run with `apptainer run --nv nafrec.sif nafrec ...` on GPU nodes. Prove the 50-page run again from inside the container via `sbatch`, started through FirecREST this time (Step 2 flow), with Allas in and out (Step 3 flow). That one job is the complete Phase 0 deliverable.

## What to bring back to Phase 1

1. The filled tables above (numbers decide chunk size: aim for ~30-60 min jobs, so chunk pages = pages/min x 45).
2. The working `hello.sh`, the Allas round-trip script, and the nafrec command line.
3. GPU (aarch64) or CPU (x86) decision, with the install error if GPU failed.
4. Whether FirecREST transfer goes to `/scratch` or can stay in Allas.
5. Job state names and the job body schema.

## Safety

- Never paste the FirecREST token or S3 keys into the repo, a chat, or an issue. If one leaks, revoke it at https://user-auth.csc.fi/idp/profile/userprofile (Connected organizations -> Firecrest-access-tokens).
- Use only open/archive sample material.
- Delete test buckets and `/scratch` working directories when done.
