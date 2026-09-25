#!/bin/bash
# Solr schema init for MessyDesk – optimized for archival/OCR-heavy text search
#
# The core "messydesk" is created automatically by `solr-precreate` in docker-compose.
# This script only configures field types, fields and copy-fields via the Schema API.
# To do a full reset, run:
#   docker compose exec solr solr delete -c messydesk
#   docker compose restart solr          # solr-precreate recreates it

SOLR_URL="http://localhost:8983/solr/messydesk"

# Wait for core to be available
echo "Waiting for Solr core..."
until curl -sf "$SOLR_URL/admin/ping" > /dev/null 2>&1; do
  sleep 1
done
echo "Solr core is up."

# Delete all existing documents (clean slate for re-indexing)
curl -s -X POST -H 'Content-Type: application/json' -d '{"delete":{"query":"*:*"},"commit":{}}' "$SOLR_URL/update"
echo ""

# Helper: try add-*, fall back to replace-* if it already exists
schema_upsert() {
  local add_op="$1"    # e.g. add-field-type, add-field, add-copy-field
  local payload="$2"
  local replace_op="${add_op/add-/replace-}"

  local resp
  resp=$(curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"$add_op\": $payload}" "$SOLR_URL/schema")

  # Solr may return either "error" or "errors" keys on failure.
  if echo "$resp" | grep -Eq '"error"|"errors"'; then
    # Field/type already exists → replace it (copy-fields have no replace, ignore error)
    if [ "$add_op" != "add-copy-field" ]; then
      curl -s -X POST -H 'Content-Type: application/json' \
        -d "{\"$replace_op\": $payload}" "$SOLR_URL/schema"
    fi
  fi
}

# ---------------------------------------------------------------
# Field types
# ---------------------------------------------------------------

# 1. N-gram type for OCR-tolerant search (matches anywhere in a word).
#    Index-time: full n-grams (2–15 chars) → catches mid-word OCR errors.
#    Query-time: standard tokenizer + lowercase only → preserves precision.
schema_upsert "add-field-type" '{
  "name": "text_ngram",
  "class": "solr.TextField",
  "positionIncrementGap": "100",
  "indexAnalyzer": {
    "tokenizer": { "class": "solr.StandardTokenizerFactory" },
    "filters": [
      { "class": "solr.LowerCaseFilterFactory" },
      { "class": "solr.NGramFilterFactory", "minGramSize": "2", "maxGramSize": "15" }
    ]
  },
  "queryAnalyzer": {
    "tokenizer": { "class": "solr.StandardTokenizerFactory" },
    "filters": [
      { "class": "solr.LowerCaseFilterFactory" }
    ]
  }
}'

# 2. Edge n-gram type for prefix/autocomplete use.
schema_upsert "add-field-type" '{
  "name": "text_edge_ngram",
  "class": "solr.TextField",
  "positionIncrementGap": "100",
  "indexAnalyzer": {
    "tokenizer": { "class": "solr.StandardTokenizerFactory" },
    "filters": [
      { "class": "solr.LowerCaseFilterFactory" },
      { "class": "solr.EdgeNGramFilterFactory", "minGramSize": "2", "maxGramSize": "20" }
    ]
  },
  "queryAnalyzer": {
    "tokenizer": { "class": "solr.StandardTokenizerFactory" },
    "filters": [
      { "class": "solr.LowerCaseFilterFactory" }
    ]
  }
}'

# ---------------------------------------------------------------
# Fields
# ---------------------------------------------------------------

schema_upsert "add-field" '{ "name": "fulltext",       "type": "text_ngram",    "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "fulltext_exact",  "type": "text_general",  "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "label",           "type": "text_general",  "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "description",     "type": "text_general",  "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "node",            "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "type",            "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "owner",           "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "error_node",      "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "error",           "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "message",         "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "set_process",     "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "process",         "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "project",         "type": "string",        "stored": true, "indexed": true }'
schema_upsert "add-field" '{ "name": "set",             "type": "string",        "stored": true, "indexed": true }'

# ---------------------------------------------------------------
# Copy fields
# ---------------------------------------------------------------

# Copy fulltext into the exact (text_general) field for phrase search
schema_upsert "add-copy-field" '{ "source": "fulltext", "dest": "fulltext_exact" }'

echo ""
echo "Schema setup complete."
