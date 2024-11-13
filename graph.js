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
}



graph.createProject = async function (data, me_rid) {

	var project = {}
	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND pr.label = "${data.label}" RETURN count(pr) as projects`
	var response = await web.cypher(query)
	console.log(response.result[0])
	if (response.result[0].projects == 0) {
		project = await this.create('Project', data)
		var project_rid = project['@rid']
		await this.connect(me_rid, 'IS_OWNER', project_rid)
	} else {
		console.log('Project exists')
		throw ('Project with that name exists!')
	}
	return project

}

graph.createSet = async function (project_rid, data, me_rid) {

	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "#${project_rid}" RETURN pr`
	var response = await web.cypher(query)
	console.log(response)
	console.log(response.result[0])
	if (response.result.length == 1) {
		var set = await this.create('Set', data)
		var set_rid = set['@rid']
		await this.connect(project_rid, 'HAS_SET', set_rid)
		return set
	} else {
		console.log('Project not found')
		throw ('Set creation failed! Project not found!')
	}
	

}



graph.index = async function (userRid) {
    // Construct the query to index user's data or all data
    const filesQuery = userRid
        ? `MATCH {type:User, as:user, where:(id = 'local.user@localhost')}-IS_OWNER->{type:Project, as:project}-->{type:File, as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`
        : `MATCH {type:User, as:user}-IS_OWNER->{type:Project, as:project}-->{type:File, as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`;

    const response = await web.sql(filesQuery);

    let documents = [];
    let count = 0;

    for (const item of response.result) {
		// if type of File is text, then read text file from file path
		item.file.fulltext = ''
		if(item.file.type == 'text') {
			item.file.fulltext = await media.getText(item.file.path)
		}
        documents.push({
            id: item.file['@rid'],
            label: item.file.label,
            owner: item.file.ownerRid,
			node: item.file['@type'],
			type: item.file.type,
			description: item.file.description,
			fulltext: item.file.fulltext,
        });
        count++;
        
        if (count % 100 === 0) {
            await web.indexDocuments(documents);
            documents = [];
        }
    }

    // Index any remaining documents
    if (documents.length > 0) {
        await web.indexDocuments(documents);
    }

    console.log(`${response.result.length} documents indexed`);
}

graph.getUsers = async function () {
	const query = `SELECT FROM User ORDER by label`
	var response = await web.sql(query)
	return response.result
}


graph.createUser = async function (data) {
	// check that email is valid
	if(!data.id) throw ('Email not defined!')
	if (!data.id.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) throw ('Invalid email address!')

	// email must be unique
	const query = `MATCH (p:User) WHERE p.id = "${data.id}" RETURN count(p) as users`
	var response = await web.cypher(query)
	if (response.result[0].users > 0) throw ('User with that email already exists!')
		
	var user = await this.create('User', data, true)
	return user
}

graph.getProject_old = async function (rid, me_email) {
	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(pr) = "#${rid}" AND p.id = "${me_email}" RETURN pr`
	var result = await web.cypher(query)
	return result
}


graph.getProject = async function (rid, me_email) {
	if (!rid.match(/^#/)) rid = '#' + rid
	schema_relations = await this.getSchemaRelations()
	const query = `MATCH {as: person, type: User, where: (id = "${me_email}")}-IS_OWNER->{as:project, type:Project, where: (@rid = ${rid})}-->{as:file, 
				where:((@type = 'Set' OR @type = 'SetProcess' OR @type = 'Process') OR ( @type = 'File'  AND (set is NULL OR expand = true) )), while: (true)}
				RETURN file`
console.log(query)
	const options = {
		serializer: 'graph',
		format: 'cytoscape',
		schemas: schema_relations
	}
	
	var result = await web.sql(query, options)
	console.log(result)
	return result
}


graph.getProject_backup = async function (rid, me_email) {
	schema_relations = await this.getSchemaRelations()
	const query = `MATCH (p:User)-[:IS_OWNER]->(project:Project) WHERE  id(project) = "#${rid}"  AND p.id = "${me_email}" 
		OPTIONAL MATCH (project)-[rr]->(file:File) WHERE file.set is NULL
		OPTIONAL MATCH (project)-[r_set]->(set:Set)
		OPTIONAL MATCH (set)-[r_setfile]->(setfile:File) WHERE setfile.expand = true
		OPTIONAL MATCH (set)-[r_setprocess]->(setp:SetProcess)
		OPTIONAL MATCH (setp)-[r_setprocess_set]->(setps:Set)
		OPTIONAL MATCH (setfile)-[r3*]->(setchild) 
		OPTIONAL MATCH (file)-[r2*]->(child2) WHERE (child2:Process OR child2:File OR child2:Set) AND (child2.set is NULL OR child2.expand = true) 
		RETURN  file, set, r2, child2, r_setfile, setfile, r3, setchild, r_setprocess, setp, r_setprocess_set, setps`
	const options = {
		serializer: 'graph',
		format: 'cytoscape',
		schemas: schema_relations
	}
	var result = await web.cypher(query, options)
	return result
}


graph.getProjects = async function (me_email) {
	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project) WHERE p.id = "${me_email}" OPTIONAL MATCH (pr)-[:HAS_FILE]-(f:File) RETURN pr, count(f) AS file_count`
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
	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(f:File) WHERE p.id = "${me_email}" 
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
	if (!rid.match(/^#/)) rid = '#' + rid
	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(file:File) WHERE id(pr) = "${rid}" AND p.id = "${me_email}" RETURN file`
	console.log(query)
	var result = await web.cypher(query)
	return result
}

graph.getSetFiles = async function (set_rid, me_email) {
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid
	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project)-[r2*]->(child)-[r:HAS_ITEM]->(file:File) WHERE p.id = "${me_email}" AND id(child) = "${set_rid}" RETURN file`
	var response = await web.cypher(query)
	for (var file of response.result) {
		file.thumb = file.path.replace('data', '/api/thumbnails').split('/').slice(0, -1).join('/');
	}
	return response.result
}

// create Process that is linked to File
graph.createProcessNode = async function (topic, params, filegraph, me_email) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	var file_rid = filegraph['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	const process_attrs = { label: topic }
	if(params.info) {
		process_attrs.info = params.info
	}

	processNode = await this.create('Process', process_attrs)
	process_rid = processNode['@rid']
	var file_path = filegraph.path.split('/').slice(0, -1).join('/')
	processNode.path = path.join(file_path, 'process', media.rid2path(process_rid), 'files')
	// update process path to record
	const update = `MATCH (p:Process) WHERE id(p) = "${process_rid}" SET p.path = "${processNode.path}" RETURN p`
	var update_response = await web.cypher(update)
	
	// finally, connect process node to file node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)

	return processNode

}

graph.createOutputSetNode = async function (label, processNode) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	const process_rid = processNode['@rid']
	
	// create process node
	const set_attrs = { label: label }


	const setNode = await this.create('Set', set_attrs)
	const set_rid = setNode['@rid']

	
	// finally, connect process node to file node
	await this.connect(process_rid, 'PRODUCED', set_rid)

	return setNode

}

// Create SetProcess that is linked to Set
graph.createSetProcessNode = async function (topic, params, filegraph, me_email) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	var file_rid = filegraph['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	const process_attrs = { label: topic }
	if(params.info) {
		process_attrs.info = params.info
	}

	processNode = await this.create('SetProcess', process_attrs)
	process_rid = processNode['@rid']
	

	// finally, connect process node to file node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)
	// create process output Set
	var setNode = await this.create('Set', {})
	// and link it to SetProcess
	await this.connect(process_rid, 'PRODUCED', setNode['@rid'])

	return process_rid

}

graph.createProcessSetNode = async function (process_rid, options) {

	const setNode = await this.create('Set', options)
	var set_rid = setNode['@rid']
	await this.connect(process_rid, 'PRODUCED', set_rid)

	return setNode

}

graph.createOriginalFileNode = async function (project_rid, ctx, file_type, set_rid) {

	if(!ctx.file.description) ctx.file.description = ctx.file.originalname
	var extension = path.extname(ctx.file.originalname).replace('.', '').toLowerCase()
	const query = `MATCH (p:Project) WHERE id(p) = "${project_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${ctx.file.originalname}",
				description: "${ctx.file.description}",
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
	
	// link file to set
	if(set_rid) {
		await this.connect(set_rid, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute(file_rid, {key:"set", value: set_rid} ) // this attribute is used in project query
		await this.updateFileCount(set_rid)
	}
	
	return update_response.result[0]
}

graph.createROIsFromJSON =  async function(process_rid, message, fileNode) {
	console.log(fileNode)
	// read file from fileNode.path
	const content = await media.getText(fileNode.path)
	const json = JSON.parse(content)

	if(json.length == 0) return
	var data = {rois:[]}

	for(var roi of json) {
		data.rois.push(roi)		
	}
	await this.createROIs(process_rid, data)
	
}

graph.createROIs = async function(rid, data) {
	// ROI can be user defined or auto generated
	// user defined ROIs are linked to source node
	// auto generated ROIs are linked to process node

	if (!rid.match(/^#/)) rid = '#' + rid

	for(var roi of data.rois) {
		// only image ROIs have coordinates
		if (roi.coordinates) {
			roi.rel_coordinates = await this.getSelectionAsPercentage(data.width, data.height, roi.coordinates)
		}
		
		// check if this is update by user
		if(roi['@rid']) {
			const query = `MATCH (roi:ROI) WHERE id(roi) = "${roi['@rid']}" RETURN roi`
			var response = await web.cypher(query)
			if(response.result.length > 0) {
				// update
				const update = `UPDATE ROI CONTENT ${JSON.stringify(roi)} WHERE @rid = "${roi['@rid']}"`
				var update_response = await web.sql(update)
			} 
		} else {
			const query_c = `CREATE Vertex ROI CONTENT ${JSON.stringify(roi)}`
			var response_c = await web.sql(query_c)
			await this.connect(rid, 'HAS_ROI', response_c.result[0]['@rid'])
		}
	}
	const query_count = `MATCH {type:File, where:(@rid=${rid})}-HAS_ROI->{type:ROI, as:roi} return count(roi) as count`
	var response_count = await web.sql(query_count)
	await this.setNodeAttribute(rid, {key:"roi_count", value: response_count.result[0].count} )

}

graph.getROIs = async function(rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	const query = `MATCH (file:File)-[r:HAS_ROI]->(roi:ROI) WHERE id(file) = "${rid}" RETURN roi`
	var response = await web.cypher(query)
	return response.result
}

graph.updateFileCount = async function (set_rid) {
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	const count_query = `MATCH {type:Set, as:set, where: ( @rid = "${set_rid}")}-HAS_ITEM->{type:File, as: file, optional:true}
	RETURN count(file) as count`
	var count_response = await web.sql(count_query)

	var count = count_response.result[0].count

	const query = `UPDATE Set SET count = ${count} WHERE @rid = "${set_rid}" `
	var response = await web.sql(query)
	return count
}

graph.createProcessFileNode = async function (process_rid, message, description) {

	const file_type = message.file.type
	const extension = message.file.extension
	const label = message.file.label
	if(!description) description = label
	let setquery = ''
	if(message.set) setquery = 'set:"' + message.set + '",'
	
	const query = `MATCH (p:Process) WHERE id(p) = "${process_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${label}",
				description: "${description}",
				expand: false,
				set: null,
				${setquery}
				_active: true
			}
		) 
		RETURN file, p.path as process_path`
	var response = await web.cypher(query)
	console.log(response)

	var file_rid = response.result[0].file['@rid']
	var file_path = path.join(response.result[0].process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
	var update_response = await web.cypher(update)

	// if output of process is a set, then connect file to set also and add attribute "set"
	if(message.output_set) {
		await this.connect(message.output_set, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute(file_rid, {key:"set", value: message.output_set} ) // this attribute is used in project query
	// otherwise connect file to process
	} else {
		await this.connect(process_rid, 'PRODUCED', file_rid)
	}

	return update_response.result[0]
}

// graph.createSetFileNode = async function (set_rid, file_type, extension, label, description, process_path) {

// 	if(!description) description = label
	
// 	const query = `MATCH (p:Set) WHERE id(p) = "${set_rid}" 
// 		CREATE (file:File 
// 			{
// 				type: "${file_type}",
// 				extension: "${extension}",
// 				label: "${label}",
// 				description: "${description}",
// 				_active: true
// 			}
// 		) <- [r:PRODUCED] - (p) 
// 		RETURN file`
// 		console.log(query)
// 	var response = await web.cypher(query)
// 	console.log(response)

// 	var file_rid = response.result[0].file['@rid']
// 	var file_path = path.join(process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
// 	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
// 	var update_response = await web.cypher(update)

// 	return update_response.result[0]
// }

graph.getUserFileMetadata = async function (file_rid, me_email) {
	file_rid = file_rid.replace('#','')
	// file must be somehow related to a project that is owned by user
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(id = "${me_email}")}
	-IS_OWNER->
		{type:Project, as:project}--> 
		{type:File, as:file, where:(@rid = "#${file_rid}"), while: ($depth < 20)} return file`
	var file_response = await web.sql(query)

	if(file_response.result[0] && file_response.result[0].file)
		return file_response.result[0].file

	else {
		// check if file is a Set
		var query_set = `MATCH {
			type: User, 
			as:p, 
			where:(id = "${me_email}")}
		-IS_OWNER->
			{type:Project, as:project}--> 
			{type:Set, as:file, where:(@rid = "#${file_rid}"), while: ($depth < 20)} return file`
		var set_response = await web.sql(query_set)
		if(set_response.result[0] && set_response.result[0].file) {
			// we need to get file types of the set content
			const extensions = await getSetFileTypes(file_rid)
			console.log('extensions', extensions)
			set_response.result[0].file.extensions = extensions
			return set_response.result[0].file

		}
	}
		return null
}

graph.getFileSource = async function (file_rid) {
	file_rid = file_rid.replace('#','')
	const sql = `Match {type:File, as:source}-PROCESSED_BY->{type:Process, as:process}-PRODUCED->{type: File, as:target, where:(@rid = ${file_rid} )} return source`
	var response = await web.sql(sql)
	if(response.result[0] && response.result[0].source) return response.result[0].source

	return null
}


graph.query = async function (body) {
	return web.cypher(body.query)
}

graph.create = async function (type, data, admin) {
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
	// set some system attributes to all Users
	if (type === 'User') {
		if(!admin) throw ('You are not admin!')
		if (!data['group']) data_str_arr.push(`group: "user"`) // default user group for all persons
		if (!data['access']) data_str_arr.push(`access: "user"`) // default access for all persons
	}
	// _active
	if (!data['active']) data_str_arr.push(`active: true`)

	var query = `CREATE (n:${type} {${data_str_arr.join(',')}}) return n`
	console.log(query)
	const response = await web.cypher(query)
	return response.result[0]
}


graph.deleteNode = async function (rid, nats) {
	if (!rid.match(/^#/)) rid = '#' + rid

	// remove node and all children (out nodes) from index
	const q = `TRAVERSE out() FROM ${rid}`
	var traverse = await web.sql(q)
	var targets = []
	for(var node of traverse.result) {
		console.log(node)
		targets.push({id: node['@rid']})
	}

	var index_msg = {
		id:'solr', 
		task: 'delete', 
		target: targets
	}
	nats.publish(index_msg.id, JSON.stringify(index_msg))

	// delete first children and then node
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
	// set some system attributes to all Users
	if (type === 'User') {
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
	//console.log(relation)
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
	console.log(rid, data)
	if (!rid.match(/^#/)) rid = '#' + rid
	let query = `MATCH (node) WHERE id(node) = '${rid}' `
	console.log(query)

	if (Array.isArray(data.value) && data.value.length > 0) {
		data.value = data.value.map(i => `'${i}'`).join(',')
		query = `SET node.${data.key} = [${data.value}]`
		return web.cypher(query)
	} else if (typeof data.value == 'boolean' || typeof data.value == 'number') {
		query = query + `SET node.${data.key} = ${data.value}`
		return web.cypher(query)
	} else if (typeof data.value == 'string') {
		query = query + `SET node.${data.key} = '${data.value.replace(/'/g, "\\'")}'`
		return web.cypher(query)
	} else if (typeof data.value == 'object') {
		query = `UPDATE ${rid} SET ${data.key} = ${JSON.stringify(data.value)}`
		return web.sql(query)
	}
	throw('Illegal data', data)
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


// graph.checkMe = async function (user) {
// 	if (!user) throw ('user not defined')
// 	var query = `MATCH (me:User {id:"${user}"}) return id(me) as rid, me._group as group, me._access as access`
// 	var result = await web.cypher(query)
// 	// add user if not found
// 	if (result.result.length == 0) {
// 		query = `MERGE (p:User {id: "${user}"}) SET p.label = "${user}", p._group = 'user', p._active = true`
// 		result = await web.cypher(query)
// 		query = `MATCH (me:User {id:"${user}"}) return id(me) as rid, me._group as group`
// 		result = await web.cypher(query)
// 		return result.result[0]
// 	} else return result.result[0]
// }


graph.myId = async function (user) {
	if (!user) throw ('user not defined')
	var query = `SELECT FROM User WHERE id = "${user}" `
	var response = await web.sql(query)
	return response.result[0]
}

graph.getStats = async function () {
	const query = 'MATCH (n) RETURN DISTINCT LABELS(n) as labels, COUNT(n) as count  ORDER by count DESC'
	const result = await web.cypher(query)
	return result
}
graph.getSelectionAsPercentage = async function(imageWidth, imageHeight, selection) {

	if(imageWidth && imageHeight) {
		const { x, y, width, height } = selection;
		console.log(selection)

		// Adjust top calculation as y starts from the bottom
		const topPercent = (y / imageHeight) * 100;
		const leftPercent = (x / imageWidth) * 100;
		const widthPercent = (width / imageWidth) * 100;
		const heightPercent = (height / imageHeight) * 100;
	
		// Return the result as an object with two decimal places
		return {
			top: parseFloat(topPercent.toFixed(2)),
			left: parseFloat(leftPercent.toFixed(2)),
			width: parseFloat(widthPercent.toFixed(2)),
			height: parseFloat(heightPercent.toFixed(2))
		};
	} else {
		throw('File or metadata not found', rid)
	}

}

graph.getEntityTypes = async function () {
	var query = 'select type, count(type) as count from Entity group by type order by count desc'
	return await web.sql(query)
}

graph.getEntitiesByType = async function (type) {
	var query = `select from Entity where type = "${type}"`
	return await web.sql(query)
}

graph.getTags = async function (userRID) {
	var query = `MATCH {type:Tag, as:tag, where:(owner = "${userRID}")} RETURN tag order by tag.label`
	return await web.sql(query)
}

graph.createTag = async function (label, userRID) {
	if(!label) return
	var query = `create Vertex Tag set label = "${label}", owner = "${userRID}"`
	return await web.sql(query)
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

async function getSetFileTypes(set_rid) {
	const query = `match {type: Set, as: set, where:(@rid = "#${set_rid}")}-HAS_ITEM->{as:file} return distinct file.extension AS extension_group`
	var response = await web.sql(query)	
	var extensions = []
	for(var result of response.result) {
		extensions.push(result.extension_group)
	}
	return extensions
}



module.exports = graph