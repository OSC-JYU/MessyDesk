# MessyDesk

Digital humanities desktop for collecting, organising and processing research materials.

**No release yet — this is under active development.** Interfaces, data formats and APIs can change without notice.

![UI](https://github.com/OSC-JYU/MessyDesk/blob/main/docs/crunchers.png)

## What it does

- Extract images and text from PDF
- Process images
- Run OCR
- Run text/image analysis tasks
- Chain these into pipelines ("crunchers")

## How it works

MessyDesk is a backend + UI for running processing tasks against pluggable services ("crunchers"). Services can run locally, in a Nomad cluster, or externally, and are connected via **service adapters** that translate MessyDesk requests into whatever API a given service exposes.

Tools are grouped into four categories, from fully manual to AI-based, so it's clear how each result was produced:
- **Preparation & annotation** — manual/deterministic (tagging, cropping, simple OCR, search)
- **Linguistic & statistical analysis** — deterministic NLP (topic modelling, POS, frequency/similarity analysis)
- **Task-specific machine learning** — trained non-LLM models (HTR, advanced OCR, NER, PII detection, classification, translation)
- **Generative AI** — LLM/VLM-based (OCR/HTR, classification, summarisation, Q&A, metadata generation)

See `wiki/` for architecture details and `docs/help/*.md` for user-facing help content.

## Help pages

Help markdown lives in `docs/help/*.md`; images go in `docs/images` and can be referenced by bare filename (e.g. `![Diagram](input_output.png)`).

Build help pages with:

```bash
npm run build:help
```

Generated output is written to `public/help` and served by `GET /api/help/{slug?}`.




