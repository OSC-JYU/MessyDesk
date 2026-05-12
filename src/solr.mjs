import got from 'got';
import { SOLR_URL, SOLR_CORE } from './env.mjs';

const solr = {}

function escapeSolrValue(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeProjectRid(value) {
	if(value === undefined || value === null) return ''
	const raw = String(value).trim()
	if(!raw) return ''
	return raw.startsWith('#') ? raw : `#${raw}`
}

function projectRidVariants(value) {
	const normalized = normalizeProjectRid(value)
	if(!normalized) return []
	const plain = normalized.replace(/^#/, '')
	if(plain === normalized) return [normalized]
	return [normalized, plain]
}

solr.search = async function(data, user_rid) {
	console.log(user_rid)
	const query = data.query;
	const parsedRows = Number(data?.rows)
	const rows = Number.isFinite(parsedRows) && parsedRows > 0
		? Math.min(1000, Math.floor(parsedRows))
		: 250
	const requestedProjects = Array.isArray(data?.project_rids)
		? data.project_rids
		: (data?.project_rid ? [data.project_rid] : [])
	const projectFilters = Array.from(new Set(
		requestedProjects.flatMap(projectRidVariants)
			.filter(Boolean)
	))
	const fq = [
		`owner:"${escapeSolrValue(user_rid)}"`,
		`type:"text"`
	]
	if(projectFilters.length === 1) {
		fq.push(`project:"${escapeSolrValue(projectFilters[0])}"`)
	} else if(projectFilters.length > 1) {
		const projectQuery = projectFilters
			.map((rid) => `project:"${escapeSolrValue(rid)}"`)
			.join(' OR ')
		fq.push(`(${projectQuery})`)
	}

	//const filters = []; 
	const params = {
		params:{
			q: query,
			rows,
			defType: "edismax",
			qf: "fulltext_exact^10 fulltext^2 label^3 description^1",
			pf: "fulltext_exact^20",
			pf2: "fulltext_exact^5",
			hl: true,
			"hl.fl": "fulltext_exact,fulltext",
			"hl.simple.pre": "<em>",
			"hl.simple.post": "</em>",
			"hl.snippets": 3,
			"hl.fragsize": 100,
			wt: "json",
			fl: "description,label,id,node,process,project,set,owner,score,type,path",
			fq
			

		}
		
	};

	  	const finalUrl = `${SOLR_URL}/${SOLR_CORE}/query`;

	console.log(JSON.stringify(params, null, 2))

	if(!data.query) {		
		return []
	} 
	
	try {
		var response = await got.post(finalUrl, {json: params}).json()
		console.log(response)
		return response
		
		
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: data, error: e})
	}
}

solr.getUserProjectDocCounts = async function(userRID) {
	const url = `${SOLR_URL}/${SOLR_CORE}/select`
	const owner = escapeSolrValue(userRID)
	const params = new URLSearchParams()
	params.set('q', '*:*')
	params.set('rows', '0')
	params.set('wt', 'json')
	params.set('facet', 'true')
	params.set('facet.field', 'project')
	params.set('facet.limit', '-1')
	params.set('facet.mincount', '1')
	params.append('fq', `owner:"${owner}"`)
	params.append('fq', 'type:"text"')

	try {
		const response = await got.get(url, {searchParams: params}).json()
		const facetValues = response?.facet_counts?.facet_fields?.project || []
		const byProject = new Map()

		for(let i = 0; i < facetValues.length; i += 2) {
			const rawProjectRid = facetValues[i]
			const count = Number(facetValues[i + 1] || 0)
			const projectRid = normalizeProjectRid(rawProjectRid)
			if(!projectRid || count <= 0) continue
			byProject.set(projectRid, (byProject.get(projectRid) || 0) + count)
		}

		const project_counts = Array.from(byProject.entries())
			.map(([project_rid, docs]) => ({project_rid, docs}))
			.sort((a, b) => b.docs - a.docs)

		return {
			total_docs: Number(response?.response?.numFound || 0),
			project_count: project_counts.length,
			project_counts
		}
	} catch(e) {
		console.log(e.message)
		throw e
	}
}

solr.dropSetIndex = async function(set_rid) {
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`;
	const escaped = escapeSolrValue(set_rid);
	try {
	  const response = await got.post(url, {
		json: {
		  delete: { query: `set_process:"${escaped}" OR process:"${escaped}"` }
		},
		responseType: 'json'
	  });
	  return response.body;
	} catch (e) {
	  console.error('Solr delete error:', e.response?.body || e.message);
	}
  };

solr.dropUserIndex = async function(userRID) {
	
	var url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`
	try {
		var response = await got.post(url, {
			json: { delete: { query: `owner:"${userRID}"` } },
			responseType: 'json'
		});
		return response.body;
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

solr.dropProjectIndex = async function(userRID, projectRID) {
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`
	const owner = escapeSolrValue(userRID)
	const projectValues = Array.from(new Set(projectRidVariants(projectRID)))
	if(projectValues.length === 0) {
		return {responseHeader: {status: 0}, message: 'no project rid'}
	}
	const projectFilter = projectValues
		.map((rid) => `project:"${escapeSolrValue(rid)}"`)
		.join(' OR ')
	const deleteQuery = `owner:"${owner}" AND (${projectFilter})`

	try {
		const response = await got.post(url, {
			json: { delete: { query: deleteQuery } },
			responseType: 'json'
		})
		return response.body
	} catch(e) {
		console.log(e.message)
		throw e
	}
}

solr.indexDocuments = async function(data) {
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`

	try {
		var response = await got.post(url, {json: data}).json()
		return response
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}

}




export default solr