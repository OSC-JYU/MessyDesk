const axios = require("axios")
const path = require('path')
const JSON5 = require('json5')
const yaml = require('js-yaml')
const fsPromises = require('fs/promises')

const schema = require("./schema.js")
const web = require("./web.js")
const media = require("./media.js")

const timers = require('timers-promises')

const MAX_STR_LENGTH = 2048


let graph = {}

graph.initDB = async function () {
	console.log(`ArcadeDB: ${web.getURL()}`)
	console.log(`Checking database...`)
	var query = 'MATCH (n:Schema_) return n'
	let db_exists = false
	try {
		db_exists = await web.checkDB()
		if (db_exists)
			console.log('Database found!')
		else
			throw ('Database not found!')

	} catch (e) {

		try {
			console.log('Database not found, creating...')
			await web.createDB()
		} catch (e) {
			console.log(`Could not init database. \nTrying again in 10 secs...`)
			await timers.setTimeout(10000)
			try {
				await web.createDB()
			} catch (e) {
				console.log(`Could not init database. \nIs Arcadedb running at ${web.getURL()}?`)
				throw ('Could not init database. exiting...')
			}
		}
		console.log('Database created!')
	}

	//await this.setSystemNodes()
}



graph.createProject = async function (data, me_rid) {

	var project = {}
	const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND pr.label = "${data.label}" RETURN count(pr) as projects`
	var response = await web.cypher(query)
	console.log(response.result[0])
	if (response.result[0].projects == 0) {
		project = await this.create('Project', data)
		var project_rid = project.result[0]['@rid']
		await this.connect(me_rid, 'IS_OWNER', project_rid)
	} else {
		console.log('Project exists')
		throw ('Project with that name exists!')
	}
	return project

}



graph.getProject_old = async function (rid, me_email) {
	const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project) WHERE id(pr) = "#${rid}" AND p.id = "${me_email}" RETURN pr`
	var result = await web.cypher(query)
	return result
}


graph.getProject = async function (rid, me_email) {
	schema_relations = await this.getSchemaRelations()
	//const query = `MATCH (p:Person)-[:IS_OWNER]->(project:Project)-[r]->(child) WHERE  child.set IS NULL AND id(project) = "#${rid}"  AND p.id = "${me_email}"  
	//OPTIONAL MATCH (child)-[r2*]->(child2) RETURN  child, r2, child2`
	const query = `MATCH (p:Person)-[:IS_OWNER]->(project:Project) WHERE  id(project) = "#${rid}"  AND p.id = "${me_email}" 
		MATCH (project)-[rr]->(file:File)
		OPTIONAL MATCH (file)-[r2*]->(child2) WHERE child2.set is NULL RETURN  file, r2, child2`
	const options = {
		serializer: 'graph',
		format: 'cytoscape',
		schemas: schema_relations
	}
	var result = await web.cypher(query, options)
	return result
}


graph.getProjects = async function (me_email) {
	const query = `MATCH (p:Person)-[r:IS_OWNER]->(pr:Project) WHERE p.id = "${me_email}" OPTIONAL MATCH (pr)-[:HAS_FILE]-(f:File) RETURN pr, count(f) AS file_count`
	var response = await web.cypher(query)
	var data = response.result.map(item => {
		const { pr, ...rest } = item;
		return {
			...rest,
			...pr, // Copy all attributes from "pr" object
		};
	});
	// sort data
	data.sort((a, b) => {
		const nameA = a.label.toUpperCase(); // ignore upper and lowercase
		const nameB = b.label.toUpperCase(); // ignore upper and lowercase
		if (nameA < nameB) {
			return -1;
		}
		if (nameA > nameB) {
			return 1;
		}

		// names must be equal
		return 0;
	});

	data = await getProjectThumbnails(me_email, data)
	return data
}


async function getProjectThumbnails(me_email, data) {
	const query = `MATCH (p:Person)-[r:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(f:File) WHERE p.id = "${me_email}" 
	RETURN  distinct (id(pr)) as project, collect(f.path)  as paths`
	var response = await web.cypher(query)

	for (var project of data) {
		for (var thumbs of response.result) {
			if (project['@rid'] === thumbs.project) {
				project.paths = []
				thumbs.paths.forEach(function (part, index) {
					if (index < 2) {
						const filename = path.basename(part)
						project.paths.push(part.replace('data', '/api/thumbnails').replace(filename, ''))
					}
				});
			}
		}
	}
	return data
}

graph.getProjectFiles = async function (rid, me_email) {
	const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(file:File) WHERE id(pr) = "#${rid}" AND p.id = "${me_email}" RETURN file`
	var result = await web.cypher(query)
	return result
}

graph.getSetFiles = async function (set_rid, me_email) {
	const query = `MATCH (p:Person)-[:IS_OWNER]->(pr:Project)-[r*]->(file:File) WHERE p.id = "${me_email}" AND file.set = "#${set_rid}" RETURN file`
	var response = await web.cypher(query)
	for (var file of response.result) {
		file.thumb = file.path.replace('data', '/api/thumbnails').split('/').slice(0, -1).join('/');
	}
	return response.result
}

graph.createProcessGraph = async function (topic, params, filegraph, me_email) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	var file_rid = filegraph['@rid']
	var file_path = filegraph.path.split('/').slice(0, -1).join('/')

	// create process node
	var processNode = {}
	const process_attrs = { label: topic }
	if(params.info) {
		process_attrs.info = params.info
	}
	processNode = await this.create('Process', process_attrs)
	var process_rid = processNode.result[0]['@rid']
	var process_path = path.join(file_path, 'process', media.rid2path(process_rid), 'files')
	// update process path to record
	const update = `MATCH (p:Process) WHERE id(p) = "${process_rid}" SET p.path = "${process_path}" RETURN p`
	var update_response = await web.cypher(update)
	// finally, connect process node to file node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)

	return update_response.result[0]

}



graph.createProjectFileGraph = async function (project_rid, ctx, file_type) {

	var extension = path.extname(ctx.file.originalname).replace('.', '').toLowerCase()
	const query = `MATCH (p:Project) WHERE id(p) = "${project_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${ctx.file.originalname}",
				_active: true
			}
		) <- [r:HAS_FILE] - (p) 
		RETURN file`
	var response = await web.cypher(query)
	console.log(response)

	var file_rid = response.result[0]['@rid']
	var file_path = path.join('data', 'projects', media.rid2path(project_rid), 'files', media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
	var update_response = await web.cypher(update)
	return update_response.result[0]
}


graph.createProcessFileNode = async function (process_rid, file_type, extension, label, description) {

	if(!description) description = label
	
	const query = `MATCH (p:Process) WHERE id(p) = "${process_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${label}",
				description: "${description}",
				_active: true
			}
		) <- [r:PRODUCED] - (p) 
		RETURN file, p.path as process_path`
	var response = await web.cypher(query)
	console.log(response)

	var file_rid = response.result[0].file['@rid']
	var file_path = path.join(response.result[0].process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
	var update_response = await web.cypher(update)

	return update_response.result[0]
}


graph.getUserFileMetadata = async function (file_rid, me_email) {
	// file must be somehow related to a project that is owned by user
	var query = `MATCH {
		type: Person, 
		as:p, 
		where:(id = "${me_email}")}
	-IS_OWNER->
		{type:Project, as:project}--> 
		{type:File, as:file, where:(@rid = "#${file_rid}"), while: ($depth < 20)} return file`
	var file_response = await web.sql(query)
	if(file_response.result[0] && file_response.result[0].file)
		return file_response.result[0].file
	else 
		return null
}


graph.query = async function (body) {
	return web.cypher(body.query)
}

graph.create = async function (type, data) {
	console.log(data)
	var data_str_arr = []
	// expression data to string
	for (var key in data) {
		if (data[key]) {
			if (Array.isArray(data[key]) && data[key].length > 0) {
				data[key] = data[key].map(i => `'${i}'`).join(',')
				data_str_arr.push(`${key}:[${data[key]}]`)
			} else if (typeof data[key] == 'string') {
				if (data[key].length > MAX_STR_LENGTH) throw ('Too long data!')
				data_str_arr.push(`${key}:"${data[key].replace(/"/g, '\\"')}"`)
			} else {
				data_str_arr.push(`${key}:${data[key]}`)
			}
		}
	}
	// set some system attributes to all Persons
	if (type === 'Person') {
		if (!data['_group']) data_str_arr.push(`_group: "user"`) // default user group for all persons
		if (!data['_access']) data_str_arr.push(`_access: "user"`) // default access for all persons
	}
	// _active
	if (!data['_active']) data_str_arr.push(`_active: true`)

	var query = `CREATE (n:${type} {${data_str_arr.join(',')}}) return n`
	console.log(query)
	return web.cypher(query)
}


graph.deleteNode = async function (rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH (n)
		WHERE id(n) = "${rid}" 
		OPTIONAL MATCH (n)-[*]->(child)
		DETACH delete n,child`
	var response = await web.cypher(query)
	if (response.result && response.result.length == 1) {
		var type = response.result[0].type
		var query_delete = `DELETE FROM ${type} WHERE @rid = "${rid}"`
		console.log(query_delete)
		return web.sql(query_delete)
	}

	return response
}


graph.merge = async function (type, node) {
	var attributes = []
	for (var key of Object.keys(node[type])) {
		attributes.push(`s.${key} = "${node[type][key]}"`)
	}
	// set some system attributes to all Persons
	if (type === 'Person') {
		if (!node['_group']) attributes.push(`s._group = "user"`) // default user group for all persons
		if (!node['_access']) attributes.push(`s._access = "user"`) // default access for all persons
	}
	// _active
	attributes.push(`s._active = true`)
	// merge only if there is ID for node
	if ('id' in node[type]) {
		var insert = `MERGE (s:${type} {id:"${node[type].id}"}) SET ${attributes.join(',')} RETURN s`
		try {
			var response = await web.cypher(insert)
			console.log(response)
			return response.data

		} catch (e) {
			try {
				await web.createVertexType(type)
				var response = await web.cypher(insert)
				console.log(response)
				return response.data
			} catch (e) {
				console.log(e)
				throw ('Merge failed!')
			}
		}
	} else {

	}
}


// data = {from:[RID] ,relation: '', to: [RID]}
graph.connect = async function (from, relation, to, match_by_id) {
	var relation_type = ''
	var attributes = ''
	if (!match_by_id) {
		if (!from.match(/^#/)) from = '#' + from
		if (!to.match(/^#/)) to = '#' + to
	}
	//relation = this.checkRelationData(relation)
	console.log(relation)
	if (typeof relation == 'object') {
		relation_type = relation.type
		if (relation.attributes)
			attributes = this.createAttributeCypher(relation.attributes)
	} else if (typeof relation == 'string') {
		relation_type = relation
	}
	var query = `MATCH (from), (to) WHERE id(from) = "${from}" AND id(to) = "${to}" CREATE (from)-[:${relation_type} ${attributes}]->(to) RETURN from, to`
	if (match_by_id) {
		query = `MATCH (from), (to) WHERE from.id = "${from}" AND to.id = "${to}" CREATE (from)-[:${relation_type} ${attributes}]->(to) RETURN from, to`
	}

	return web.cypher(query)
}


graph.unconnect = async function (data) {
	if (!data.from.match(/^#/)) data.from = '#' + data.from
	if (!data.to.match(/^#/)) data.to = '#' + data.to
	var query = `MATCH (from)-[r:${data.rel_type}]->(to) WHERE id(from) = "${data.from}" AND id(to) = "${data.to}" DELETE r RETURN from`
	return web.cypher(query)
}


graph.deleteEdge = async function (rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' DELETE r`
	return web.cypher(query)
}


graph.setEdgeAttribute = async function (rid, data) {
	if (!rid.match(/^#/)) rid = '#' + rid
	let query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' `
	if (Array.isArray(data.value)) {
		if (data.value.length > 0) {
			data.value = data.value.map(i => `'${i}'`).join(',')
			query = query + `SET r.${data.name} = [${data.value}]`
		} else {
			query = query + `SET r.${data.name} = []`
		}
	} else if (typeof data.value == 'boolean' || typeof data.value == 'number') {
		query = query + `SET r.${data.name} = ${data.value}`
	} else if (typeof data.value == 'string') {
		query = query + `SET r.${data.name} = '${data.value.replace(/'/g, "\\'")}'`
	}
	return web.cypher(query)
}


graph.setNodeAttribute = async function (rid, data) {
	if (!rid.match(/^#/)) rid = '#' + rid
	let query = `MATCH (node) WHERE id(node) = '${rid}' `

	if (Array.isArray(data.value) && data.value.length > 0) {
		data.value = data.value.map(i => `'${i}'`).join(',')
		query = `SET node.${data.key} = [${data.value}]`
	} else if (typeof data.value == 'boolean') {
		query = query + `SET node.${data.key} = ${data.value}`
	} else if (typeof data.value == 'string') {
		query = query + `SET node.${data.key} = '${data.value.replace(/'/g, "\\'")}'`
	}
	return web.cypher(query)
}


graph.getNodeAttributes = async function (rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH (node) WHERE id(node) = '${rid}' RETURN node`
	return web.cypher(query)
}


graph.getGraph = async function (body, ctx) {

	var me = await this.myId(ctx.request.headers.mail)
	// ME
	if (body.query.includes('_ME_')) {
		body.query = body.query.replace('_ME_', me.rid)
	}

	var schema_relations = null
	// get schemas first so that one can map relations to labels
	if (!body.raw) {
		schema_relations = await this.getSchemaRelations()
	}
	const options = {
		serializer: 'graph',
		format: 'cytoscape',
		schemas: schema_relations,
		current: body.current,
		me: me
	}
	return web.cypher(body.query, options)
}


graph.getSchemaRelations = async function () {
	var schema_relations = {}
	var schemas = await web.cypher('MATCH (s:Schema_)-[r]->(s2:Schema_) return type(r) as type, r.label as label, r.label_rev as label_rev, COALESCE(r.label_inactive, r.label) as label_inactive, s._type as from, s2._type as to, r.tags as tags, r.compound as compound')
	schemas.result.forEach(x => {
		schema_relations[x.type] = x
	})
	return schema_relations
}


graph.getSearchData = async function (search) {
	if (search[0]) {
		var arr = search[0].result.map(x => '"' + x + '"')
		var query = `MATCH (n) WHERE id(n) in [${arr.join(',')}] AND NOT n:Schema_ return id(n) as id, n.label as label, labels(n) as type LIMIT 10`
		return web.cypher(query)
	} else {
		return { result: [] }
	}
}


graph.checkRelationData = async function (data) {
	if (data.from) {
		if (!data.from.match(/^#/)) data.from = '#' + data.from
	}
	if (data.to) {
		if (!data.to.match(/^#/)) data.to = '#' + data.to
	}
	if (data.relation_id) {
		if (!data.relation_id.match(/^#/)) data.relation_id = '#' + data.relation_id
	}
	return data
}


graph.createAttributeCypher = async function (attributes) {
	var attrs = []
	var cypher = ''
	for (var key in attributes) {
		if (Array.isArray(attributes[key])) {
			if (attributes[key].length > 0) {
				var values_str = attributes[key].map(i => `'${i}'`).join(',')
				attrs.push(`${key}:[${values_str}]`)
			} else {
				attrs.push(`${key}:[]`)
			}
		} else {
			attrs.push(`${key}: "${attributes[key]}"`)
		}
	}
	return '{' + attrs.join(',') + '}'
}


graph.checkMe = async function (user) {
	if (!user) throw ('user not defined')
	var query = `MATCH (me:Person {id:"${user}"}) return id(me) as rid, me._group as group, me._access as access`
	var result = await web.cypher(query)
	// add user if not found
	if (result.result.length == 0) {
		query = `MERGE (p:Person {id: "${user}"}) SET p.label = "${user}", p._group = 'user', p._active = true`
		result = await web.cypher(query)
		query = `MATCH (me:Person {id:"${user}"}) return id(me) as rid, me._group as group`
		result = await web.cypher(query)
		return result.result[0]
	} else return result.result[0]
}


graph.myId = async function (user) {
	if (!user) throw ('user not defined')
	var query = `MATCH (me:Person {id:"${user}"}) return id(me) as rid, me._group as group, me._access as access`
	var response = await web.cypher(query)
	return response.result[0]
}


graph.getGroups = async function () {
	var query = 'MATCH (x:UserGroup) RETURN x.label as label, x.id as id'
	var result = await web.cypher(query)
	return result.result
}


graph.getMaps = async function () {
	var query = 'MATCH (t:QueryMap) RETURN t order by t.label'
	var result = await web.cypher(query)
	return result.result
}


graph.getMenus = async function (group) {
	//var query = 'MATCH (m:Menu) return m'
	var query = `MATCH (m:Menu) -[:VISIBLE_FOR_GROUP]->(n:UserGroup {id:"${group}"}) OPTIONAL MATCH (m)-[]-(q) WHERE q:Query OR q:Tag RETURN COLLECT( q) AS items, m.label as label, m.id as id ORDER BY id`
	var result = await web.cypher(query)
	var menus = this.forceArray(result.result, 'items')
	return menus
}


graph.forceArray = async function (data, property) {
	for (var row of data) {
		if (!Array.isArray(row[property])) {
			row[property] = [row[property]]
		}
	}
	return data
}


// data = {rel_types:[], node_types: []}
graph.myGraph = async function (user, data) {
	if (!data.return) data.return = 'p,r,n, n2'
	var rel_types = []; var node_types = []
	var node_query = ''
	if (!user || !Array.isArray(data.rel_types) || !Array.isArray(data.node_types)) throw ('invalid query!')

	// by default get all relations and all nodes linked to 'user'
	for (var type of data.rel_types) {
		rel_types.push(`:${type.trim()}`)
	}
	for (var node of data.node_types) {
		node_types.push(`n:${node.trim()}`)
	}
	if (node_types.length) node_query = ` WHERE ${node_types.join(' OR ')}`
	var query = `MATCH (p:Person {id:"${user}"})-[r${rel_types.join('|')}]-(n) OPTIONAL MATCH (n)--(n2) ${node_query} return ${data.return}`

	return web.cypher(query, 'graph')
}


// get list of documents WITHOUT certain relation
// NOTE: open cypher bundled with Arcadedb did not work with "MATCH NOT (n)-[]-()"" -format. This could be done with other query language.
graph.getListByType = async function (query_params) {
	var query = `MATCH (n) return n.label as text, id(n) as value ORDER by text`
	if (query_params.type) query = `MATCH (n:${query_params.type}) return n.label as text, id(n) as value ORDER by text`
	var all = await web.cypher(query)
	if (query_params.relation && query_params.target) {
		query = `MATCH (n:${query_params.type})-[r:${query_params.relation}]-(t) WHERE id(t) = "#${query_params.target}" return COLLECT(id(n)) as ids`
		var linked = await web.cypher(query)
		//console.log(linked.result)
		//console.log(all.result)
		var r = all.result.filter(item => !linked.result[0].ids.includes(item.value));
		//console.log(r)
		return r

	} else {
		return all
	}
}


graph.importGraphYAML = async function (filename, mode) {
	console.log(`** importing graph ${filename} with mode ${mode} **`)
	try {
		const file_path = path.resolve('./graph', filename)
		const data = await fsPromises.readFile(file_path, 'utf8')
		const graph_data = yaml.load(data)
		if (mode == 'clear') {
			var query = 'MATCH (s) WHERE NOT s:Schema_ DETACH DELETE s'
			var result = await web.cypher(query)
			await this.setSystemNodes()
			await this.createSystemGraph()
			await this.writeGraphToDB(graph_data)
		}
		this.createIndex()
		// const filePath = path.resolve('./schemas', filename)
		// const data = await fsPromises.readFile(filePath, 'utf8')
		// const schema = yaml.load(data)
		// await this.writeSchemaToDB(schema)
	} catch (e) {
		throw (e)
	}
	console.log('Done import')
}


graph.writeGraphToDB = async function (graph) {
	try {
		for (var node of graph.nodes) {
			console.log(node)
			const type = Object.keys(node)[0]
			console.log(type)
			console.log(node[type])
			if (type != 'Layout')
				await this.create(type, node[type])
		}

		for (var edge of graph.edges) {
			const edge_key = Object.keys(edge)[0]
			const splitted = edge_key.split('->')
			if (splitted.length == 3) {
				const link = splitted[1].trim()
				const [from_type, ...from_rest] = splitted[0].split(':')
				const [to_type, ...to_rest] = splitted[2].split(':')
				const from_id = from_rest.join(':').trim()
				const to_id = to_rest.join(':').trim()
				await this.connect(from_id, { type: link, attributes: edge[edge_key] }, to_id, true)
			} else {
				throw ('Graph edge error: ' + Object.keys(edge)[0])
			}
		}
	} catch (e) {
		throw (e)
	}
}




graph.getTags = async function () {
	var query = 'MATCH (t:Tag) RETURN t order by t.label'
	return await web.cypher(query)
}


graph.getQueries = async function () {
	var query = 'MATCH (t:Query)  RETURN t'
	return await web.cypher(query)
}


graph.getStyles = async function () {
	var query = 'MATCH (s:Schema_) return COALESCE(s._style,"") as style, s._type as type'
	return await web.cypher(query)
}


graph.getFileList = async function (dir) {
	if (['graph', 'styles', 'schemas'].includes(dir)) {
		var files = await fsPromises.readdir(dir)
		console.log(files)
		return files
	} else {
		throw ('Illegal path')
	}
}




graph.getStats = async function () {
	const query = 'MATCH (n) RETURN DISTINCT LABELS(n) as labels, COUNT(n) as count  ORDER by count DESC'
	const result = await web.cypher(query)
	return result
}


graph.getDataWithSchema = async function (rid, by_groups) {
	by_groups = 1

	if (!rid.match(/^#/)) rid = '#' + rid
	var data = await web.cypher(`MATCH (source) WHERE id(source) = "${rid}" OPTIONAL MATCH (source)-[rel]-(target)  return source, rel, target ORDER by target.label`)
	if (data.result.length == 0) return []


	var type = data.result[0].source['@type']
	data.result[0].source = await schema.getSchemaAttributes(type, data.result[0].source)
	//var att = await this.getNodeAttributes(rid)
	var schemas = await schema.getSchema(type)

	for (var schema_item of schemas) {
		schema_item.data = data.result.filter(ele => ele.rel['@type'] == schema_item.type).map(ele => {
			var out = {}
			var rel_active = ele.rel._active
			if (typeof ele.rel._active === 'undefined') rel_active = true
			if (!ele.target._active) rel_active = false
			if (ele.rel['@out'] == ele.source['@rid'])
				out = {
					id: ele.target['@rid'],
					type: ele.target['@type'],
					label: ele.target['label'],
					rel_id: ele.rel['@rid'],
					rel_active: rel_active
				}
			else {
				out = {
					id: ele.target['@rid'],
					type: ele.target['@type'],
					label: ele.target['label'],
					rel_id: ele.rel['@rid'],
					rel_active: rel_active
				}
			}
			if (ele.rel['attr']) out.rel_attr = ele.rel['attr']
			if (ele.rel['x']) out.rel_x = ele.rel['x']
			if (ele.rel['y']) out.rel_y = ele.rel['y']
			return out
		})
	}

	if (by_groups) {
		const tags = await this.getTags()
		var out = {
			_attributes: data.result[0].source,
			tags: {
				default_display: {
					relations: [],
					label: 'default',
					count: 0
				},
			}
		}
		var default_group = []
		for (var relation of schemas) {
			if (relation.display && relation.display == 'default') {
				out.tags.default_display.relations.push(relation)
				out.tags.default_display.count = out.tags.default_display.count + relation.data.length
			} else if (relation.tags) {
				if (Array.isArray(relation.tags) && relation.tags.length > 0) {
					var tag = tags.result.find(x => relation.tags.includes(x.id))
				} else if (typeof relation.tags == 'string') {
					var tag = tags.result.find(x => relation.tags == x.id)
				}
				if (tag) {
					var tag_label = tag.label ? tag.label : tag.id
					if (!out.tags[relation.tags]) {
						out.tags[relation.tags] = { relations: [], label: tag_label, count: 0 }
					}
					out.tags[relation.tags].relations.push(relation)
					out.tags[relation.tags].count = out.tags[relation.tags].count + relation.data.length
					// if tag was found but empty, then push to default group
				} else {
					default_group.push(relation)
				}

				// if no tag found, then push to default group
			} else {
				default_group.push(relation)
			}

		}
		out.tags.default_group = { relations: default_group, label: 'Relations' }
		return out
	} else {
		return schemas
	}
}


module.exports = graph