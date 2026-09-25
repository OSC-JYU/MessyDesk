function ridOrEmpty(value) {
  if (!value && value !== 0) return ''
  const raw = String(value).trim()
  if (!raw) return ''
  return raw.startsWith('#') ? raw : `#${raw}`
}

function parsePayload(payload) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

export async function createProcessQueueMessage(payload, options = {}) {
  const resolveProjectRidForNode = options.resolveProjectRidForNode
  const parsed = parsePayload(payload)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return payload
  }

  const msg = parsed
  const fileRid = ridOrEmpty(msg?.file?.['@rid'])
  const inputSetRid = ridOrEmpty(msg?.input_set)
  const explicitSetRid = ridOrEmpty(msg?.set_rid)
  const outputSetRid = ridOrEmpty(msg?.output_set)

  if (!msg.project_rid) {
    const projectRid = ridOrEmpty(msg?.file?.project_rid)
      || ridOrEmpty(msg?.process?.project_rid)
      || ridOrEmpty(msg?.project_rid)

    if (projectRid) {
      msg.project_rid = projectRid
    } else if (typeof resolveProjectRidForNode === 'function') {
      const lookupRid = fileRid || inputSetRid || explicitSetRid || outputSetRid
      if (lookupRid) {
        try {
          const foundProjectRid = await resolveProjectRidForNode(lookupRid)
          if (foundProjectRid) msg.project_rid = foundProjectRid
        } catch {
          // Keep publishing even if project lookup fails.
        }
      }
    }
  }

  const isSetProcessing = Boolean(
    msg.set_process
    || inputSetRid
    || explicitSetRid
    || outputSetRid
    || String(msg?.file?.['@type'] || '') === 'Set'
  )

  if (isSetProcessing && !msg.set_rid) {
    const setRid = inputSetRid
      || explicitSetRid
      || (String(msg?.file?.['@type'] || '') === 'Set' ? fileRid : '')
      || outputSetRid
    if (setRid) msg.set_rid = setRid
  }

  return msg
}
