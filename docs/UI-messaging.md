
# UI messaging (SSE)

MessyDesk UI receives backend updates through `GET /events` as Server-Sent Events.

Current commands handled in UI:

- `add`
- `update`
- `process_update`
- `process_finished`

## Single file processing

When process is created:

```json
{
    "command": "add",
    "type": "process",
    "input": "#rid_of_input_file",
    "node": { "@rid": "#rid_of_process", "status": "running" }
}
```

When output file node is added:

```json
{
    "command": "add",
    "type": "file",
    "input": "#rid_of_process",
    "node": { "@rid": "#rid_of_output_file" },
    "process": { "@rid": "#rid_of_process", "status": "finished" }
}
```

When file metadata/image is updated:

```json
{
    "command": "update",
    "target": "#rid_of_file",
    "node": { "metadata": {}, "image": "..." }
}
```

## Set processing

When set process starts:

```json
{
    "command": "add",
    "type": "process",
    "input": "#rid_of_input_set",
    "node": { "@rid": "#rid_of_set_process", "status": "running" },
    "output": { "@rid": "#rid_of_output_set", "status": "running" }
}
```

Progress updates (throttled in backend, currently every 10 files):

```json
{
    "command": "process_update",
    "process": { "@rid": "#rid_of_set_process", "status": "running" },
    "set": { "@rid": "#rid_of_output_set", "status": "running", "count": 120 },
    "current_file": 120,
    "total_files": 1000
}
```

Completion:

```json
{
    "command": "process_finished",
    "process": { "@rid": "#rid_of_set_process", "status": "finished" },
    "set": { "@rid": "#rid_of_output_set", "status": "finished", "count": 1000 },
    "current_file": 1000
}
```

## Planned message extensions for batch UX

To support pause/resume and ETA without flooding UI, extend `process_update` payload with:

```json
{
    "batch": {
        "state": "running",
        "processed_files": 120,
        "failed_files": 3,
        "total_files": 1000,
        "avg_sec_per_file": 1.84,
        "eta_sec": 1619
    }
}
```

Suggested states:

- `queued`
- `running`
- `paused`
- `cancelling`
- `cancelled`
- `finished`
- `failed`

## Notes

- Explicit done endpoint is `POST /api/nomad/process/files/done`.
- Keep SSE updates aggregate and bounded (time- or count-based) to avoid UI event storms.