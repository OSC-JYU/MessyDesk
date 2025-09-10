import axios from 'axios';
import path from 'path';
import fs from 'fs';
import fse from 'fs-extra';
import { pipeline } from 'stream';

const username = process.env.DB_USER || 'root'
const password = process.env.DB_PASSWORD

const MAX_STR_LENGTH = 2048
const DB_HOST = process.env.DB_HOST || 'http://127.0.0.1'
const DB = process.env.DB_NAME || 'messydesk'
const PORT = process.env.DB_PORT || 2480
const URL = `${DB_HOST}:${PORT}/api/v1/command/${DB}`

const DATA_DIR = process.env.DATA_DIR || './'
const SOLR_URL = process.env.SOLR_URL || 'http://localhost:8983/solr'
const SOLR_CORE = process.env.SOLR_CORE || 'messydesk'
const INTERNAL_URL = process.env.INTERNAL_URL || 'http://localhost:8200'

console.log(URL)

const web = {}

web.initURL = function(url) {
	console.log('intializing URL...')
	console.log(url)
	console.log(URL)
	console.log('done intializing URL')
}

web.checkService = async function(url) {
	try {
		console.log(url)
		await axios.get(url)
		return true
	} catch(e) {
		return false
	}

}

web.getURL = function() {
	return URL
}

web.checkDB = async function() {
	const {got} = await import('got')
	var url = URL.replace(`/command/`, '/exists/')
	var data = {
		username: username,
		password: password
	};

	try {
		var response = await got.get(url, data).json()
		return response.result
		
	} catch(e) {
		console.log(e.message)
		throw({message: "Error on database check"})
	}
}


web.createDB = async function() {
	if(!password) {
		console.log('ERROR: DB_PASSWORD not set! Exiting...')
		process.exit(1)
	}

	var url = URL.replace(`/command/${DB}`, '/server')
	var config = {
		auth: {
			username: username,
			password: password
		}
	};
	try {
		await axios.post(url, {command: `create database ${DB}`}, config)
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


// web.runPipeline = async function(pipeline, userID) {
// 	const {got} = await import('got')
// 	var url = INTERNAL_URL + '/api/pipeline/run'


// 	try {
// 		var response = await got.post(url, data).json()
// 		return response.result
		
// 	} catch(e) {
// 		console.log(e.message)
// 		throw({message: "Error on database check"})
// 	}
// }

// web.internal = async function(url, data) {
// 	const {got} = await import('got')
// 	url = INTERNAL_URL + url
// 	try {
// 		var response = await got.post(url, data).json()
// 		return response.result
		
// 	} catch(e) {
// 		console.log(e.message)
// 		throw({message: "Error on internal call! ", url})
// 	}
// }

web.createVertexType = async function(type) {
	var query = `CREATE VERTEX TYPE ${type} IF NOT EXISTS`
	try {
		await this.sql(query)
	} catch (e) {
		//console.log(e.message)
		//console.log(`${type} exists`)
	}
}

web.sql = async function(query, options) {
	if(!options) var options = {}
	
	var config = {
		auth: {
			username: username,
			password: password
		}
	};
	const query_data = {
		command:query,
		language:'sql'
	}

	if(options.serializer) query_data.serializer = options.serializer

	try {
		var response = await axios.post(URL, query_data, config)
		//if(query && query.toLowerCase().includes('create')) return response.data
		if(!options.serializer) return response.data

		else if(options.serializer == 'graph' && options.format == 'cytoscape') {
			options.labels = await getSchemaLabels(config)
			return convert2CytoScapeJs(response.data, options)
		} else {
			return response.data
		}
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
	//var response = await axios.post(URL, query_data, config)
	//return response.data
}

web.sql2 = async function(query, options) {
	if(!options) var options = {}
	
	var config = {
		auth: {
			username: username,
			password: password
		}
	};
	const query_data = {
		command:query,
		language:'sql',
		params: options.params
	}

	if(options.serializer) query_data.serializer = options.serializer

	try {
		var response = await axios.post(URL, query_data, config)
		//if(query && query.toLowerCase().includes('create')) return response.data
		if(!options.serializer) return response.data

		else if(options.serializer == 'studio' && options.format == 'vueflow') {
			//options.labels = await getSchemaLabels(config)
			return convert2VueFlow(response.data, options)
		} else {
			return response.data
		}
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
	//var response = await axios.post(URL, query_data, config)
	//return response.data
}

web.sql_params = async function(query, params, raw) {
	
	var config = {
		auth: {
			username: username,
			password: password
		}
	};
	const query_data = {
		command:query,
		language:'sql',
		params: params
	}

	try {
		var response = await axios.post(URL, query_data, config)
		if(raw) return response.data
		return convert2VueFlow(response.data)

	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
	//var response = await axios.post(URL, query_data, config)

}

web.cypher = async function(query, options) {

	if(!options) var options = {}
	if(options.current && !options.current.includes('#')) options.current = '#' + options.current

	var config = {
		auth: {
			username: username,
			password: password
		}
	};
	const query_data = {
		command:query,
		language:'cypher'
	}

	if(options.serializer) query_data.serializer = options.serializer
	//if(process.env.MODE == 'development') console.log(query)

	try {
		var response = await axios.post(URL, query_data, config)
		//if(query && query.toLowerCase().includes('create')) return response.data
		if(!options.serializer) return response.data

		else if(options.serializer == 'graph' && options.format == 'vueflow') {
			//options.labels = await getSchemaLabels(config)
			return convert2VueFlow(response.data, options)
			//return convert2CytoScapeJs(response.data, options)
		} else {
			return response.data
		}
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: query, error: e})
	}
}

// get node error
web.getError = async function(rid) {
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

web.solr = async function(data, user_rid) {
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
		var response = await axios.get(finalUrl, params)
		//console.log(response.data)
		return response.data
		
		
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

web.solrDropUserData = async function(userRID) {
	
	var url = `${SOLR_URL}/${SOLR_CORE}/delete?q=owner:" + userRID + "&wt=json`
	try {
		var response = await axios.get(url)
		return response.data	
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

web.indexDocuments = async function(data) {
	if(!options) var options = {}
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`

	try {
		var response = await axios.post(url, data)
		return response.data
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}

}


async function getSchemaLabels(config) {
	const query = "MATCH (s:Schema_)  RETURN COALESCE(s.label, s._type)  as label, s._type as type"
	const query_data = {
		command:query,
		language:'cypher'
	}
	try {
		var response = await axios.post(URL, query_data, config)
		var labels = response.data.result.reduce(
			(obj, item) => Object.assign(obj, { [item.type]: item.label }), {});
		return labels
	} catch(e) {
		console.log(e.response)
		console.log(query)
		throw(e)
	}
}

function setParent(vertices, child, parent) {
	for(var node of vertices) {
		if(node.data.id == child) {
			node.data.parent = parent
		}
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


export default web