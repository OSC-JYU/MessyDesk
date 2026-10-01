#!/usr/bin/env bash
# =====================================================
# Solr Delete Script
# Deletes documents from a Solr core or collection
# Usage:
#   ./solr-delete.sh all <core_name>
#   ./solr-delete.sh owner <core_name> <owner_value>
# Example:
#   ./solr-delete.sh all mycollection
#   ./solr-delete.sh owner mycollection '#49:0'
# =====================================================

SOLR_HOST="http://localhost:8983/solr"

MODE="$1"
CORE="$2"
OWNER_VALUE="$3"

if [[ -z "$MODE" || -z "$CORE" ]]; then
  echo "Usage:"
  echo "  $0 all <core_name>"
  echo "  $0 owner <core_name> <owner_value>"
  exit 1
fi

if [[ "$MODE" == "all" ]]; then
  echo "Deleting ALL documents from core: $CORE"
  curl -s "${SOLR_HOST}/${CORE}/update?commit=true" \
       -H "Content-Type: application/xml" \
       --data-binary '<delete><query>*:*</query></delete>'
  echo "✅ All documents deleted."
elif [[ "$MODE" == "owner" ]]; then
  if [[ -z "$OWNER_VALUE" ]]; then
    echo "Error: missing owner value."
    echo "Usage: $0 owner <core_name> <owner_value>"
    exit 1
  fi

  # Escape special chars (# and :) for Solr query
  OWNER_ESCAPED=$(echo "$OWNER_VALUE" | sed 's/#/\\#/g' | sed 's/:/\\:/g')

  echo "Deleting documents where owner=$OWNER_VALUE from core: $CORE"
  curl -s "${SOLR_HOST}/${CORE}/update?commit=true" \
       -H "Content-Type: application/xml" \
       --data-binary "<delete><query>owner:${OWNER_ESCAPED}</query></delete>"
  echo "✅ Documents with owner=$OWNER_VALUE deleted."
else
  echo "Unknown mode: $MODE"
  echo "Valid modes: all | owner"
  exit 1
fi
