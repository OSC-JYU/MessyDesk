const axios = require("axios")

const username = 'root'

let web = {}


web.gremlin = async function(url, query, serializer, current) {

	var config = {
		auth: {
			username: username,
			password: process.env.DB_PASSWORD
		}
	};
	query_data = {
		command:query,
		language:'gremlin'
	}
	if(serializer) query_data.serializer = serializer
	console.log(query)

	try {
		var response = await axios.post(url, query_data, config)
		if(!serializer) return response.data
		else return convert2CytoScapeJs(response.data, schemas, current)
	} catch(e) {
		console.log(e)
		console.log(query)
		return e
	}
}

web.cypher = async function(url, query, serializer, schemas, current) {
	if(current && !current.includes('#')) current = '#' + current

	var config = {
		auth: {
			username: username,
			password: process.env.DB_PASSWORD
		}
	};
	query_data = {
		command:query,
		language:'cypher'
	}
	if(serializer) query_data.serializer = serializer
	console.log(query)

	try {
		var response = await axios.post(url, query_data, config)
		if(query && query.toLowerCase().includes('create')) return response.data
		else if(!serializer) return response.data
		else return convert2CytoScapeJs(response.data, schemas, current)
	} catch(e) {
		console.log(e)
		console.log(query)
		return e
	}
}



function setParent(vertices, child, parent) {
	for(var node of vertices) {
		if(node.data.id == child) {
			node.data.parent = parent
		}
	}
}

function convert2CytoScapeJs(data, schemas, current) {
    //console.log(data.result.vertices)
	var vertex_ids = []
	var nodes = []
	//var records = []
	if(data.result.vertices) {
		for(var v of data.result.vertices) {
			if(!vertex_ids.includes(v.r)) {
				var node = {data:{id:v.r, name:v.p.label, type: v.t, width: 100}}
				nodes.push(node)
				vertex_ids.push(v.r)
			}
		}
	}

	var edges = []
	var ids = []
	console.log(data.result.edges)
	if(data.result.edges) {
		for(var v of data.result.edges) {
			if(!ids.includes(v.r)) {
				var edge = {data:{id:v.r, source:v.o, target:v.i, label:v.t}}
				ids.push(v.r)
				if(schemas) {
					if(schemas[v.t]) {
						if(schemas[edge.data.label].label)
							edge.data.label = schemas[edge.data.label].label.toUpperCase()
						else {
							edge.data.label = edge.data.label
						}
						if(schemas[v.t].compound === 'true') {
							if(current == v.o)
								edges.push(edge)
							else
								setParent(nodes, v.o, v.i)
						} else {
							edges.push(edge)
						}
					}
				}
			}
		}
	}
	return {nodes:nodes, edges: edges}
}


module.exports = web
