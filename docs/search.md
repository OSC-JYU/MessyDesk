# Search

Search is one of the core functionalities for exploring research material.

By creating a search node for text files, you add those texts to a shared search index. You can then run queries against that index.

Note: Nothing is indexed by default.

When you remove a search node, all associated text files are also removed from the search index.

This approach is simple and gives you full control.

## Why this approach?

First, when running different kinds of experiments, you often end up with multiple versions of the same text. It would be inconvenient if all these variants appeared in your search results.

Second, this approach allows you to decide what gets indexed based on your needs. For example, you might generate a word list from your texts and choose to index only that, while still using the results to navigate back to the original texts.

Third, there is a technical reason. Search index sizes can become enormous, especially when using n-gram–based indexing to “find everything.” By not indexing all material automatically, you can use more precise n-gram settings without creating large indexes that are never used.


## Re-indexing

Sometimes index can get messy, for example because of failed update requests.
Therefore we provide a project-scoped way to rebuild search index data.

Re-indexing flow:
- Re-indexing is project based.
- System deletes Solr data where owner is the current user and project matches requested project.
- After deletion, system queries Solr indexing SetProcess nodes from the project.
- Matching input sets are re-queued to md-solr as if user queued indexing again.

API endpoint:
- POST /api/projects/{rid}/reindex-search

Search index info endpoint:
- GET /api/search/info
- Returns indexed text document counts for the current user, grouped by project.

Example response:
```json
{
	"total_docs": 128,
	"project_count": 3,
	"project_counts": [
		{ "project_rid": "#12:0", "docs": 58 },
		{ "project_rid": "#13:1", "docs": 40 },
		{ "project_rid": "#14:7", "docs": 30 }
	]
}
```

UI entry point:
- Project listing page (Main view), action button per project row.



Re-index currently rebuilds from discovered SetProcess-based Solr indexing sources (project-level set workflows).
The route returns structured summary data used by the UI dialog:
source_sets_found
requeued_sets
requeued_files
warnings
Natural next steps
Add optional live progress hookup in UI
On successful launch, register returned process identifiers into running jobs state so users immediately see active re-index jobs in the right panel.
Add endpoint-level tests
Ownership check, Solr delete call, and requeue summary behavior for empty and non-empty projects.
Add explicit audit logging
Write one concise backend log line per re-index operation with project, user, sets found, sets queued, files queued.