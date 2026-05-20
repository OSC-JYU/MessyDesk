import { expect } from 'chai'

import { collectProjectSolrReindexSources } from '../src/graph.mjs'

describe('collectProjectSolrReindexSources', () => {
  it('collects source sets from Process rows used by many-to-one md-solr batches', () => {
    const projectRid = '#12:34'
    const rows = [
      {
        process_rid: '#98:1',
        input_set: '22:1',
        task_id: 'index',
        task_payload_json: '{"id":"index"}',
        topic: 'md-solr',
      },
      {
        process_rid: '#98:2',
        input_set: '#22:2',
        task: 'index',
        service: 'Solr',
      },
    ]

    const result = collectProjectSolrReindexSources(rows, projectRid, (rid) => {
      const raw = String(rid || '').trim()
      return raw.startsWith('#') ? raw : `#${raw}`
    })

    expect(result).to.deep.equal([
      {
        input_set: '#22:1',
        process_rid: '#98:1',
        task_id: 'index',
        task_payload_json: '{"id":"index"}',
        project_rid: '#12:34',
      },
      {
        input_set: '#22:2',
        process_rid: '#98:2',
        task_id: 'index',
        task_payload_json: null,
        project_rid: '#12:34',
      },
    ])
  })

  it('deduplicates repeated input_set values and skips missing sets', () => {
    const rows = [
      { process_rid: '#1:1', input_set: '#5:1', task_id: 'index' },
      { process_rid: '#1:2', input_set: '5:1', task_id: 'index' },
      { process_rid: '#1:3', input_set: null, task_id: 'index' },
      { process_rid: '#1:4' },
    ]

    const result = collectProjectSolrReindexSources(rows, '#10:9', (rid) => {
      const raw = String(rid || '').trim()
      return raw.startsWith('#') ? raw : `#${raw}`
    })

    expect(result).to.deep.equal([
      {
        input_set: '#5:1',
        process_rid: '#1:1',
        task_id: 'index',
        task_payload_json: null,
        project_rid: '#10:9',
      },
    ])
  })

  it('defaults task_id to index when missing', () => {
    const rows = [
      { process_rid: '#1:1', input_set: '#5:1' },
    ]

    const result = collectProjectSolrReindexSources(rows, '#10:9', (rid) => rid)

    expect(result[0].task_id).to.equal('index')
  })
})
