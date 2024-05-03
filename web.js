const axios = require("axios")
const path 	= require("path")
const fs 	= require("fs-extra")

const username = 'root'
const password = process.env.DB_PASSWORD

const MAX_STR_LENGTH = 2048
const DB_HOST = process.env.ARCADEDB_HOST || 'http://localhost'
const DB = process.env.ARCADEDB_DB || 'messydesk'
const PORT = process.env.ARCADEDB_PORT || 2480
const URL = `${DB_HOST}:${PORT}/api/v1/command/${DB}`

console.log(URL)

let web = {}

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
		await this.createVertexType('Person')
		await this.createVertexType('File')
		await this.createVertexType('Process')
		await this.createVertexType('Project')

		await this.sql("CREATE Vertex Person CONTENT {id:'local.user@localhost', label:'Just human'}", 'sql')
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
	var response = await axios.post(URL, query_data, config)
	return response.data
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
		if(query && query.toLowerCase().includes('create')) return response.data
		else if(!options.serializer) return response.data
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



async function convert2CytoScapeJs(data, options) {
	//console.log(data.result)
	if(!options) var options = {labels:{}}
	var vertex_ids = []
	var nodes = []
	var inactive_nodes = []

	if(data.result.vertices) {
		for(var v of data.result.vertices) {
			if(!vertex_ids.includes(v.r)) {
				var node = {}
				if(v.p._type) { // schema
					node = {
						data:{
							id:v.r,
							name:options.labels[v.p._type],
							type: v.p._type,
							type_label: v.p._type,
							info: 'dd',
							active: true,
							width: 100,
							idc: v.r.replace(':','_')
						}
					}
				} else {
					node = {
						data:{
							id:v.r,
							name:v.p.label,
							type: v.t,
							type_label: options.labels[v.t],
							active: v.p._active,
							info: v.p.info,
							width: 100,
							description: v.p.description,
							idc: v.r.replace(':','_')
						 }
					}
					if(!node.data.active) inactive_nodes.push(v.r)
				}

				//node.data.info = v.p.info
				if(v.r == options.current) node.data.current = 'yes'
				if(options.me && v.r == options.me.rid ) node.data.me = 'yes'
				if(v.p.type) node.data._type = v.p.type
				if(['image', 'pdf'].includes(node.data._type)) {
					if(v.p.path) {
						const img_path = path.join(path.dirname(v.p.path), 'thumbnail.jpg')
						const exists = await fs.pathExists(img_path)
						if(exists) {
							node.data.image = path.join('api/thumbnails', path.dirname(v.p.path).replace('data/',''))
						}
					}
				}
				nodes.push(node)
				vertex_ids.push(v.r)
				//console.log(node)
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


module.exports = web