

#First create new type
# n-gram settings (avoid need for wildcards):
curl -X POST -H 'Content-type:application/json' \
  http://localhost:8983/solr/messydesk/schema \
  --data-binary '{
    "add-field-type": {
      "name": "text_edge_ngram",
      "class": "solr.TextField",
      "positionIncrementGap": "100",
      "analyzer": {
        "tokenizer": { "class": "solr.StandardTokenizerFactory" },
        "filters": [
          { "class": "solr.LowerCaseFilterFactory" },
          { "class": "solr.EdgeNGramFilterFactory", "minGramSize": "3", "maxGramSize": "20" }
        ]
      }
    }
  }'

curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"node",
    "type":"string",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"


curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"type",
    "type":"string",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"

curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"owner",
    "type":"string",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"

  curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"label",
    "type":"string",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"

  curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"description",
    "type":"string",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"

# curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
#     "name":"fulltext",
#     "type":"string",
#     "stored":true,
#     "indexed":true
#   }
#   }' "http://localhost:8983/solr/messydesk/schema"

  curl -X POST -H 'Content-Type: application/json' -d '{"add-field": {
    "name":"fulltext",
    "type":"text_edge_ngram",
    "stored":true,
    "indexed":true
  }
  }' "http://localhost:8983/solr/messydesk/schema"


    #curl -X POST -H 'Content-Type: application/json' -d '{"add-copy-field": {"source":"description", "dest":"text"}}' "http://localhost:8983/solr/messydesk/schema"
    #curl -X POST -H 'Content-Type: application/json' -d '{"add-copy-field": {"source":"label", "dest":"text"}}' "http://localhost:8983/solr/messydesk/schema"
    #curl -X POST -H 'Content-Type: application/json' -d '{"add-copy-field": {"source":"fulltext", "dest":"text"}}' "http://localhost:8983/solr/messydesk/schema"
