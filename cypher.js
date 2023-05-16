const axios = require("axios")
const web = require("./web.js")

const MAX_STR_LENGTH = 2048
const DB_HOST = process.env.ARCADEDB_HOST || 'localhost'
const URL = `http://${DB_HOST}:2480/api/v1/command/messydesk`

// Assigning to exports will not modify module, must use module.exports
module.exports = class Cypher {

	async createIndex(docIndex) {
		var query = 'MATCH (n) return id(n) as id, n.label as label'
		var result = await web.cypher(URL, query)
		try {
			for (var node of result.result) {
				docIndex.add(node)
			}
		} catch(e) {
			// if indexing fails, then we have a problem and we quit
			console.log(e)
			console.log('Indexing failed, exiting...')
			console.log('Did you create the database?')
			//process.exit(1)

		}
	}

	async createProject(data) {
		await this.create('Project', data)
	}


	async getProject(rid) {
		const query = `MATCH (p:Project) WHERE id(p) = "#${rid}" RETURN p`
		console.log(query)
		var result = await web.cypher(URL, query)
		return result
	}


 	async createFileGraph(project_rid, filedata) {
		const query = `MATCH (p:Project) WHERE id(p) = "${project_rid}" 
			CREATE (file:File 
				{
					path:"${filedata.filepath}", 
					type: "${filedata.type}",
					extension: "${filedata.extension}",
					label: "${filedata.originalname}"
				}
			) - [r:IS_PART_OF] -> (p) 
			RETURN file`
		var result = await web.cypher(URL, query)
		return result
	}


	async getServicesForFile(services, rid) {
		const query = `MATCH (file:File) WHERE id(file) = "#${rid}" RETURN file`
		var response = await web.cypher(URL, query)
		if(response.result.length == 1) {
			const matches = {for_type: [], for_format: []}
			var file = response.result[0]
			for(var service in services) {
				if(services[service].supported_types.includes(file.type)) {
					
					if(services[service].supported_formats.includes(file.extension)) {
						matches.for_format.push(services[service])
					} else {
						matches.for_type.push(services[service])
					}
				}
			}
			return matches
		}
		else
			return []
	}



	async addToQueue(data) {

		const queue_url = `http://${DB_HOST}:2480/api/v1/command/messydesk-queue`
		var date = Date.now()
		const query = `CREATE (m:Message {
			channel: "${data.channel}",
			target: "${data.target}",
			timestamp: ${date}
		}) RETURN m`
		var response = await web.cypher(queue_url, query)
		return response.result

	}


	async pollQueue(services) {
		console.log(services)
		const queue_url = `http://${DB_HOST}:2480/api/v1/command/messydesk-queue`
		// get all "open" messages for registered services
		const query = 'match (n:Message) return n order by n.timestamp asc'
		var response = await web.cypher(queue_url, query)
		return response.result
	}











	async query(body) {

		return web.cypher(URL, body.query)
	}

	async getGraph(body) {

		var schema_relations = null
		// get schemas first so that one can map relations to labels
		if(!body.raw) {
			schema_relations = await this.getSchemaRelations()
		}

		return web.cypher(URL, body.query, 'graph', schema_relations, body.current)
	}

	async getSchemaRelations() {
		var schema_relations = {}
		var schemas = await web.cypher(URL, 'MATCH (s:Schema)-[r]->(s2:Schema) return type(r) as type, r.label as label, r.label_rev as label_rev, s.label as from, s2.label as to, r.tags as tags, r.compound as compound')
		schemas.result.forEach(x => {
			schema_relations[x.type] = x
		})
		return schema_relations
	}

	async getSearchData(search) {
		if(search[0]) {
			var arr = search[0].result.map(x => '"' + x + '"')
			var query = `MATCH (n) WHERE id(n) in [${arr.join(',')}] AND NOT n:Schema return id(n) as id, n.label as label, labels(n) as type LIMIT 10`
			return web.cypher(URL, query)
		} else {
			return {result:[]}
		}
	}

	checkRelationData(data) {
		if(data.from) {
			if(!data.from.match(/^#/)) data.from = '#' + data.from
		}
		if(data.to) {
			if(!data.to.match(/^#/)) data.to = '#' + data.to
		}
		if(data.relation_id) {
			if(!data.relation_id.match(/^#/)) data.relation_id = '#' + data.relation_id
		}
		return data
	}

	async create(type, data) {
        var data_str_arr = []
		const fields = ['label', 'tags', 'id', 'description']
		// expression data to string
		for(var key of fields) {
            if(data[key]) {
			    if(data[key].length > MAX_STR_LENGTH) throw('Too long data!')
			    data_str_arr.push(`${key}:"${data[key].replace(/"/g, '\\"')}"`)
            }
		}
		var query = `CREATE (n:${type} {${data_str_arr.join(',')}}) return n`
        console.log(query)
		return web.cypher(URL, query)
	}

	// data = {from:[RID] ,relation: '', to: [RID]}
	async connect(from, relation, to) {
		var relation_type = ''
		var attributes = ''
		if(!from.match(/^#/)) from = '#' + from
		if(!to.match(/^#/)) to = '#' + to
		//relation = this.checkRelationData(relation)
		console.log()
		if(typeof relation == 'object') {
			relation_type = relation.type
			if(relation.attributes)
				attributes = this.createAttributeCypher(relation.attributes)
		} else if (typeof relation == 'string') {
			relation_type = relation
		}


		var query = `MATCH (from), (to) WHERE id(from) = "${from}" AND id(to) = "${to}" CREATE (from)-[:${relation_type} ${attributes}]->(to) RETURN from, to`
		return web.cypher(URL, query)
	}

	createAttributeCypher(attributes) {
		var attrs = []
		var cypher = ''
		for (var key in attributes) {
			attrs.push(`${key}: "${attributes[key]}"`)
		}
		return '{' + attrs.join(',') + '}'
	}

	async unconnect(data) {
		var query = `MATCH (from)-[r:${data.rel_type}]->(to) WHERE id(from) = "${data.from}" AND id(to) = "${data.to}" DELETE r RETURN from`
		return web.cypher(URL, query)
	}

	async deleteEdge(rid) {
		var query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' DELETE r`
		return web.cypher(URL, query)
	}

	async setEdgeAttribute(rid, data) {
		var query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' SET r.${data.name} = '${data.value}'`
		if(Array.isArray(data.value)) {
			if(data.value.length > 0) {
				data.value = data.value.map(i => `'${i}'`).join(',')
				query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' SET r.${data.name} = [${data.value}]`
			} else {
				query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' REMOVE r.${data.name}`
			}
		}
		if(!data.value) query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' REMOVE r.${data.name}`
		return web.cypher(URL, query)
	}

	async setNodeAttribute(rid, data) {
		var query = `MATCH (node) WHERE id(node) = '${rid}' SET node.${data.key} = '${data.value}'`
		if(Array.isArray(data.value) && data.value.length > 0) {
			data.value = data.value.map(i => `'${i}'`).join(',')
			query = `MATCH (node) WHERE id(node) = '${rid}' SET node.${data.key} = [${data.value}]`
		}
		if(!data.value) query = `MATCH (node) WHERE id(node) = '${rid}' SET node.${data.key} = null`
		return web.cypher(URL, query)
	}

	async getNodeAttributes(rid) {
		var query = `MATCH (node) WHERE id(node) = '#${rid}' RETURN node`
		return web.cypher(URL, query)
	}

	async myId(user) {
		if(!user) throw('user not defined')
		var query = `MATCH (me:Person {id:"${user}"}) return id(me) as id`
		var result = await web.cypher(URL, query)
		// add user if not found
		if(result.result.length != 1) {
			query = `CREATE (p:Person) set p.id = "${user}", p.label = "${user}"`
			result = await web.cypher(URL, query)
			query = `MATCH (me:Person {id:"${user}"}) return id(me) as id`
			result = await web.cypher(URL, query)
			return result.result[0].id
		} else return result.result[0].id
	}


	// data = {rel_types:[], node_types: []}
	async myGraph(user, data) {
		if(!data.return) data.return = 'p,r,n, n2'
		var rel_types = []; var node_types = []
		var node_query = ''
		if(!user || !Array.isArray(data.rel_types) || !Array.isArray(data.node_types)) throw('invalid query!')

		// by default get all relations and all nodes linked to 'user'
		for(var type of data.rel_types) {
			rel_types.push(`:${type.trim()}`)
		}
		for(var node of data.node_types) {
			node_types.push(`n:${node.trim()}`)
		}
		if(node_types.length) node_query = ` WHERE ${node_types.join (' OR ')}`
		var query = `MATCH (p:Person {id:"${user}"})-[r${rel_types.join('|')}]-(n) OPTIONAL MATCH (n)--(n2) ${node_query} return ${data.return}`

		return web.cypher(URL, query, 'graph')
	}


	// get list of documents WITHOUT certain relation
	// NOTE: open cypher bundled with Arcadedb did not work with "MATCH NOT (n)-[]-()"" -format. This could be done with other query language.
	async getListByType(query_params) {
		var query = `MATCH (n) return n.label as text, id(n) as value ORDER by text`
		if(query_params.type) query = `MATCH (n:${query_params.type}) return n.label as text, id(n) as value ORDER by text`
		var all = await web.cypher(URL, query)
		if(query_params.relation && query_params.target) {
			query = `MATCH (n:${query_params.type})-[r:${query_params.relation}]-(t) WHERE id(t) = "#${query_params.target}" return COLLECT(id(n)) as ids`
			var linked = await web.cypher(URL, query)
			//console.log(linked.result)
			//console.log(all.result)
			var r = all.result.filter(item => !linked.result[0].ids.includes(item.value));
			//console.log(r)
			return r

		} else {
			return all
		}

	}


	async getSchema(label) {
		var query = ''
		if(label)
			query = `MATCH (s:Schema {label:"${label}"}) -[rel]- (t:Schema) RETURN s, rel ,t ORDER by rel.display DESC`
		else
			query = `MATCH (s:Schema ) -[rel]-(t:Schema) RETURN s, rel, t`
		var result = await web.cypher(URL, query)
		var out = []
		for(var schema of result.result) {

			if(schema.s['@rid'] == schema.rel['@out']) {
				out.push({
					type:schema.rel['@type'],
					label: schema.rel['label'],
					target: schema.t['label'],
					display: schema.rel['display']
				})
			} else {
				out.push({
					type:schema.rel['@type'],
					label: schema.rel['label_rev'],
					target: schema.t['label'],
					reverse: 1
				})
			}
		}
		return out
	}


	async getSchemaTypes() {
		var query = 'MATCH (s:Schema) RETURN id(s) as rid, s.label as label ORDER by label'
		return await web.cypher(URL, query)
	}

	async getTags() {
		var query = 'MATCH (t:Tag) RETURN t'
		return await web.cypher(URL, query)
	}

	async getQueries() {
		var query = 'MATCH (t:Query) RETURN t'
		return await web.cypher(URL, query)
	}

	async getDataWithSchema(itemid) {

		var data = await web.cypher(URL, `MATCH (source) WHERE id(source) = "#${itemid}" OPTIONAL MATCH (source)-[rel]-(target)  return *`)
		if(data.result.length == 0) return []
		var type = data.result[0].source['@type']
		console.log(type)
		var schemas = await this.getSchema(type)
		for(var schema of schemas) {
			schema.data = data.result.filter(ele => ele.rel['@type'] == schema.type).map(ele => {
				var out = {}
				if(ele.rel['@out'] == ele.source['@rid'])
					out=  {
						id: ele.target['@rid'],
						type: ele.target['@type'],
						label: ele.target['label'],
						rel_id: ele.rel['@rid']
					}
				else {
					out =  {
						id: ele.target['@rid'],
						type: ele.target['@type'],
						label: ele.target['label'],
						rel_id: ele.rel['@rid']
					}
				}
				if(ele.rel['attr']) out.rel_attr = ele.rel['attr']
				return out
			})
		}
		return schemas
	}
}
