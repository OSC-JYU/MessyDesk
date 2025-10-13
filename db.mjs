import got from 'got';
import path from 'path';
import {  DB_NAME,DB_URL, DB_USER, DB_PASSWORD } from './env.mjs';

const username = DB_USER
const password = DB_PASSWORD


console.log(DB_URL)

const db = {}

db.initURL = function(url) {
	console.log('intializing URL...')
	console.log(url)
	console.log(DB_URL)
	console.log('done intializing URL')
}

db.checkService = async function(url) {
	try {
		console.log(url)
		await got.get(url)
		return true
	} catch(e) {
		return false
	}

}

db.getURL = function() {
	return DB_URL
}

db.checkDB = async function() {
	var url = DB_URL.replace(`/command/`, '/exists/')
	var options = {
		username: username,
		password: password
	};

	try {
		var response = await got.get(url, options).json()
		return response.result
		
	} catch(e) {
		console.log(e.message)
		throw({message: "Error on database check"})
	}
}


db.createDB = async function() {
	if(!password) {
		console.log('ERROR: DB_PASSWORD not set! Exiting...')
		process.exit(1)
	}

	var url = DB_URL.replace(`/command/${DB_NAME}`, '/server')
	var options = {
		username: username,
		password: password,
		json: {command: `create database ${DB_NAME}`}
	};
	try {
		await got.post(url, options)
		await this.createVertexType('Project')
		await this.createVertexType('Source')
		await this.createVertexType('User')
		await this.createVertexType('File')
		await this.createVertexType('Process')
		await this.createVertexType('Set')
		await this.createVertexType('SetProcess')
		await this.createVertexType('ROI')
		await this.createVertexType('Entity')
		await this.createVertexType('EntityType')
		await this.createVertexType('Request')
		await this.createVertexType('Prompt')
		await this.createVertexType('ErrorNode')

		await this.createDocumentType('Usage')
		
		await this.createEdgeType('PROCESSED_BY')
		await this.createEdgeType('PRODUCED')
		await this.createEdgeType('HAS_ITEM')
		await this.createEdgeType('HAS_FILE')
		await this.createEdgeType('HAS_ROI')
		await this.createEdgeType('HAS_ENTITY')
		await this.createEdgeType('HAS_SET')
		await this.createEdgeType('IS_OWNER')
		await this.createEdgeType('HAS_SOURCE')

	
		//await this.createVertexType('Person')
		// development/default user
		//await this.sql("CREATE Vertex User CONTENT {id:'local.user@localhost', label:'Just human', access:'admin', active:true}", 'sql')
		// const commands = [
		// 	"CREATE PROPERTY Person.id IF NOT EXISTS STRING (mandatory true, notnull true)",
		// 	"CREATE PROPERTY Person.id IF NOT EXISTS STRING (mandatory true, notnull true)",
		// 	"CREATE PROPERTY Project.label IF NOT EXISTS STRING (mandatory true, notnull true)",

		// 	"CREATE INDEX IF NOT EXISTS ON Person (id) UNIQUE",

		// 	"CREATE Vertex Person CONTENT {id:'local.user@localhost', label:'Just human'}"
		// ]
		// for(var query of commands) {
		// 	await this.sql(query, 'sql')
		// }
	} catch(e) {
		console.log('Database init failed', e.message)
		throw(e)
	}
}


db.createVertexType = async function(type) {
	var query = `CREATE VERTEX TYPE ${type} IF NOT EXISTS`
	try {
		await this.sql(query)
	} catch (e) {
		console.log(e.message)
		//console.log(`${type} exists`)
	}
}

db.createDocumentType = async function(type) {
	var query = `CREATE DOCUMENT TYPE ${type} IF NOT EXISTS`
	try {
		await this.sql(query)
	} catch (e) {
		console.log(e.message)
		//console.log(`${type} exists`)
	}
}

db.createEdgeType = async function(type) {
	var query = `CREATE EDGE TYPE ${type} IF NOT EXISTS`
	try {
		await this.sql(query)
	} catch (e) {
		console.log(e.message)
		//console.log(`${type} exists`)
	}
}


db.deleteMany = async function(rids, retries = 3, timeout = 5000) {

	let response
	try {
		let lastError

		for(var rid of rids) {
			var gotOptions = {
				username: username,
				password: password,
				json: {language:'sql', command: `DELETE FROM ${rid.id}`},
				timeout: {
					request: timeout
				}
			}

			for (let attempt = 1; attempt <= retries; attempt++) {
				try {
					response = await got.post(DB_URL, gotOptions).json()
					break // Success, exit retry loop
				} catch (error) {
					lastError = error
					console.log(`Write attempt ${attempt} failed:`, error.message)
					console.log(gotOptions.json)
					
					if (attempt < retries) {
						// Wait before retrying (exponential backoff)
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
						console.log(`Retrying write in ${delay}ms...`)
						await new Promise(resolve => setTimeout(resolve, delay))
					} else {
						throw new Error(`Failed to execute query after ${retries} attempts. Last error: ${lastError.message}`)
					}
				}
			}

		}
		
		return {result: 'ok'}

	} catch (error) {
		throw error
	}

}



db.sql = async function(query, options, retries = 3) {
	let response
	let lastError
	if(!options) var options = {}
	
	var gotOptions = {
		username: username,
		password: password,
		json: {
			command:query,
			language:'sql',
			params: options.params
		}
	}

	// Add transaction ID if provided
	if(options.transactionId) {
		gotOptions.headers = {
			'arcadedb-session-id': options.transactionId
		}
	}

	if(options.serializer) gotOptions.json.serializer = options.serializer

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			response = await got.post(DB_URL, gotOptions).json()
			break // Success, exit retry loop
		} catch (error) {
			lastError = error
			console.log(`Write attempt ${attempt} failed:`, error.message)
			console.log(gotOptions.json)
			
			if (attempt < retries) {
				// Wait before retrying (exponential backoff)
				const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
				console.log(`Retrying write in ${delay}ms...`)
				await new Promise(resolve => setTimeout(resolve, delay))
			} else {
				throw new Error(`Failed to execute query after ${retries} attempts. Last error: ${lastError.message}`)
			}
		}
	}

	if(!options.serializer) {
		return response
	} else if(options.serializer == 'studio' && options.format == 'vueflow') {
		return convert2VueFlow(response, options)
	} else {
		return response
	}

}

db.sql_params = async function(query, params, raw, transactionId) {
	
	var gotOptions = {
		username: username,
		password: password,
		json: {
			command:query,
			language:'sql',
			params: params
		}
	}

	// Add transaction ID if provided
	if(transactionId) {
		gotOptions.headers = {
			'arcadedb-session-id': transactionId
		}
	}

	try {
		var response = await got.post(DB_URL, gotOptions).json()
		if(raw) return response
		return convert2VueFlow(response)

	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
	//var response = await axios.post(URL, query_data, config)

}




db.cypher = async function(query, options) {

	if(!options) var options = {}
	if(options.current && !options.current.includes('#')) options.current = '#' + options.current

	var gotOptions = {
		username: username,
		password: password,
		json: {
			command:query,
			language:'cypher'
		}
	}

	// Add transaction ID if provided
	if(options.transactionId) {
		gotOptions.headers = {
			'arcadedb-session-id': options.transactionId
		}
	}

	if(options.serializer) gotOptions.json.serializer = options.serializer
	//if(process.env.MODE == 'development') console.log(query)

	try {
		var response = await got.post(DB_URL, gotOptions).json()
		//if(query && query.toLowerCase().includes('create')) return response
		if(!options.serializer) return response

		else if(options.serializer == 'graph' && options.format == 'vueflow') {
			//options.labels = await getSchemaLabels(gotOptions)
			return convert2VueFlow(response, options)
			//return convert2CytoScapeJs(response, options)
		} else {
			return response
		}
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
}

// get node error
db.getError = async function(rid) {
	var query = `SELECT FROM ${rid}`
	try {
		var response = await this.sql(query)
		if(response.result.length > 0) {
			return response.result[0]
		} else {
			return null
		}
			
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

db.solr = async function(data, user_rid) {
	//console.log(user_rid)
	const query = data.query;

	//const filters = []; 
	const params = {
		params:{
			q: query,
			defType: "edismax",
			qf: "fulltext^5",
			pf: "fulltext^5",
			hl: true,
			"hl.fl": "fulltext",
			"hl.simple.pre": "<em>",
			"hl.simple.post": "</em>",
			"hl.snippets": 3,
			"hl.fragsize": 100,
			wt: "json",
			fl: "description,label,id,owner",
			fq: `owner:${user_rid}`
			

		}
		
	};

  	const finalUrl = `${SOLR_URL}/${SOLR_CORE}/query?fq=type:text`;

	//console.log(JSON.stringify(params, null, 2))

	if(!data.query) {		
		return []
	} 
	
	try {
		var response = await got.get(finalUrl, {searchParams: params.params}).json()
		//console.log(response)
		return response
		
		
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

db.solrDropUserData = async function(userRID) {
	
	var url = `${SOLR_URL}/${SOLR_CORE}/delete?q=owner:" + userRID + "&wt=json`
	try {
		var response = await got.get(url).json()
		return response
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

db.indexDocuments = async function(data) {
	if(!options) var options = {}
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`

	try {
		var response = await got.post(url, {json: data}).json()
		return response
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}

}


async function convert2VueFlow(data, options) {

	if(!options) var options = {labels:{}}
	var vertex_ids = []
	var nodes = []
	var inactive_nodes = []

	if(data.result.vertices) {
		for(var v of data.result.vertices) {
			if(!vertex_ids.includes(v.r)) {
				var node = {}

				node = {
					data:{
						id:v.r,
						name:v.p.label,
						type: v.t,
						//type_label: options.labels[v.t],
						//active: v.p._active,
						info: v.p.info,
						description: v.p.description,
						roi_count: v.p.roi_count,
						count: v.p.count,
						//idc: v.r.replace(':','_')
						}
				}

				if(v.p.type) node.data._type = v.p.type
				if(v.p.node_error) node.data.error = v.p.node_error
				if(v.p.error_count) node.data.error_count = v.p.error_count
				if(v.p.metadata) node.data.metadata = v.p.metadata
				if(v.p.service) node.data.service = v.p.service
				if(v.p.model) node.data.model = v.p.model
				
				
				// direct link to thumbnail
				if(v.t != 'Process' && v.p.path) 
					node.data.image = path.join('/api/thumbnails', path.dirname(v.p.path))

				nodes.push(node)
				vertex_ids.push(v.r)
			}
		}
	}

	var edges = []
	var ids = []
	if(data.result.edges) {
		for(var v of data.result.edges) {
			if(!ids.includes(v.r)) {
				var edge = {data:{id:v.r, source:v.o, target:v.i, label:v.t, type:v.t, active:v.p._active}}
				ids.push(v.r)
				if(typeof v.p._active == 'undefined') edge.data.active = true
				else edge.data.active = v.p._active
				// links to inactive node are also inactive
				if(inactive_nodes.includes(edge.data.source) || inactive_nodes.includes(edge.data.target))
					edge.data.active = false

				// add relationship labels to graph from schema
				if(options.schemas) {
					if(options.schemas[v.t]) {
						if(options.schemas[edge.data.label].label) {
							if(edge.data.active) {
								edge.data.label = options.schemas[edge.data.label].label.toUpperCase()
							} else {
								edge.data.label = options.schemas[edge.data.label].label_inactive
							}
						} else {
							edge.data.label = edge.data.label
						}

						edges.push(edge)
						
					} else {
						edges.push(edge)
					}
				} else {
					edges.push(edge)
				}
			}
		}
	}

	return {nodes:nodes, edges: edges}
	
}


export default db