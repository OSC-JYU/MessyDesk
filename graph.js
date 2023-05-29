const path 			= require('path');
const web 			= require("./web.js")
const media 			= require("./media.js")

const MAX_STR_LENGTH = 2048
const DB_HOST = process.env.ARCADEDB_HOST || 'localhost'
const URL = `http://${DB_HOST}:2480/api/v1/command/messydesk`

// Assigning to exports will not modify module, must use module.exports
module.exports = class Graph {

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

	async createProject(data, me_rid) {
		
		var project = {}
		const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND pr.label = "${data.label}" RETURN count(pr) as projects`
		var response = await web.cypher(URL, query)
		console.log(response.result[0])
		if(response.result[0].projects == 0) {
			project = await this.create('Project', data)
			var project_rid = project.result[0]['@rid']
			await this.connect(me_rid, 'IS_OWNER', project_rid)
		} else {
			console.log('Project exists')
			throw('Project with that name exists!')
		}
		return project

	}



	async getProject(rid, me_email) {
		const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project) WHERE id(pr) = "#${rid}" AND p.id = "${me_email}" RETURN pr`
		var result = await web.cypher(URL, query)
		return result
	}



	async getProjects(me_email) {
		const query = `MATCH (p:Person)-[r:IS_OWNER]->(pr:Project) WHERE p.id = "${me_email}" RETURN pr`
		var result = await web.cypher(URL, query)
		return result
	}


	async getProjectFiles(rid, me_email) {
		const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project)<-[:IS_PART_OF]-(file:File) WHERE id(pr) = "#${rid}" AND p.id = "${me_email}" RETURN file`
		var result = await web.cypher(URL, query)
		return result
	}


	async createProcessGraph(topic, params, filegraph, me_email) {
		
		params.topic = topic
		var file_rid = filegraph['@rid']
		var file_path = filegraph.path.split('/').slice( 0, -1 ).join('/')
		var process = {}
		// file must be part of project that user owns
		const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project)<-[*]-(file:File) WHERE p.id = "${me_email}" AND id(file) = "${file_rid}" RETURN pr`
		var response = await web.cypher(URL, query)
		console.log(response.result[0])

		process = await this.create('Process', {label: topic})
		var process_rid = process.result[0]['@rid']
		var process_path = path.join(file_path, 'process', media.rid2path(process_rid), 'files')
		const update = `MATCH (p:Process) WHERE id(p) = "${process_rid}" SET p.path = "${process_path}" RETURN p`
		var update_response = await web.cypher(URL, update)
		await this.connect(file_rid, 'WAS_PROCESSED_BY', process_rid)

		return update_response.result[0]

	}


 	async createProjectFileGraph(project_rid, ctx, file_type) {
		
		var extension = path.extname(ctx.file.originalname).replace('.','')
		const query = `MATCH (p:Project) WHERE id(p) = "${project_rid}" 
			CREATE (file:File 
				{
					type: "${file_type}",
					extension: "${extension}",
					label: "${ctx.file.originalname}"
				}
			) - [r:IS_PART_OF] -> (p) 
			RETURN file`
		var response = await web.cypher(URL, query)
		console.log(response)

		var file_rid = response.result[0]['@rid']
		var file_path = path.join('data', 'projects', media.rid2path(project_rid),'files', media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
		const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
		var update_response = await web.cypher(URL, update)
		return update_response
	}


	async createProcessFileNode(process_rid, file_type, extension, label) {
		
		const query = `MATCH (p:Process) WHERE id(p) = "${process_rid}" 
			CREATE (file:File 
				{
					type: "${file_type}",
					extension: "${extension}",
					label: "${label}"
				}
			) - [r:WAS_PRODUCED_BY] -> (p) 
			RETURN file, p.path as process_path`
		var response = await web.cypher(URL, query)
		console.log(response)

		var file_rid = response.result[0].file['@rid']
		var file_path = path.join(response.result[0].process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
		const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
		var update_response = await web.cypher(URL, update)
		return update_response
	}


	async getUserFileMetadata_old(file_rid, me_email) {
		// file must be somehow related to a project that is owned by user
		const query = `g.V(\"#${file_rid}\")
		.as(\"f\")
		.repeat(both().simplePath())
		.until(hasLabel(\"Project\"))
		.in(\"IS_OWNER\")
		.hasLabel(\"Person\")
		.has(\"id\", \"${me_email}\")
		.select(\"f\")`
		var file_response = await web.gremlin(URL, query)
		return file_response.result[0]
	}

	async getUserFileMetadata(file_rid, me_email) {
		// file must be somehow related to a project that is owned by user
		const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project)<-[*]-(file:File) WHERE p.id = "${me_email}" AND id(file) = "#${file_rid}" RETURN file`
		var file_response = await web.cypher(URL, query)
		return file_response.result[0]
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
