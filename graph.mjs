
import path from 'path';



import web from "./web.mjs";
import media from "./media.mjs";

import timers from 'timers-promises';

const MAX_STR_LENGTH = 2048;
const DB_HOST = process.env.DB_HOST || 'http://127.0.0.1';
const DB = process.env.DB_NAME || 'messydesk';
const PORT = process.env.DB_PORT || 2480;
const URL = `${DB_HOST}:${PORT}/api/v1/command/${DB}`;

const API_URL = process.env.API_URL || '/';
const AUTH_HEADER = 'mail';
const DEFAULT_USER = 'local.user@localhost';

const MAX_POSITION = 10000; // max x and y for project nodes
const graph = {};

const NODE_ATTRIBUTES = ['description', 'label', 'info', 'expand', 'metadata', 'response', 'node_error']

const entityTypes = [
	{type:'Tag', icon:'tag', color:'blue', label:'Tag'},
	{type:'Person', icon:'account', color:'rgb(17, 138, 42)', label:'Person'},
	{type:'Location', icon:'map-marker', color:'green', label:'Location'},
	{type:'Theme', icon:'shape', color:'rgb(129, 19, 138)', label:'Theme'},
	{type:'Quality', icon:'message-alert', color:'orange', label:'Quality'},
	{type:'Date', icon:'calendar-range', color:'rgb(43, 95, 98)', label:'Date'},
	{type:'Organisation', icon:'warehouse', color:'rgb(40, 19, 163)', label:'Organisation'}
]


graph.initDB = async function () {
	web.initURL(URL)
	console.log(`ArcadeDB: ${web.getURL()}`)
	console.log(`Checking database...jooko`)
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
			await graph.createUser({id: DEFAULT_USER, label: 'Just human', access: 'admin', active: true})
		} catch (e) {
			console.log(e)
			console.log(`Could not init database. \nTrying again in 10 secs...`)
			await timers.setTimeout(10000)
			try {
				await web.createDB()
				await graph.createUser({id: DEFAULT_USER, label: 'Just human', access: 'admin', active: true})
			} catch (e) {
				console.log(`Could not init database. \nIs Arcadedb running at ${web.getURL()}?`)
				throw ('Could not init database. exiting...')
			}
		}
		console.log('Database created!')
	}
}

graph.hasAccess = async function (item_rid, user_rid) {
	if (!item_rid.match(/^#/)) item_rid = '#' + item_rid
	const query = `TRAVERSE in() FROM ${item_rid}`
	var response = await web.sql(query)
	var user = response.result.filter(function (x) { return x['@rid'] == user_rid })
	if (!user.length) {
		return false
	} else {
		return true
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

graph.deleteProject = async function (project_rid, user_rid, nats) {
	const query = `MATCH {type:User, as:user, where:(@rid = ${user_rid})}-IS_OWNER->{as:project, where:(@rid = ${project_rid})} return project.@rid AS rid`
	var response = await web.sql(query)
	if(response.result.length == 1) {
		await this.deleteNode(response.result[0]['rid'], nats)
	}
	return response.result[0]['rid']
}

graph.createSet = async function (project_rid, data, me_rid) {

	//const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "${project_rid}" RETURN pr`
	const query = `MATCH {type:User, as:p, where:(@rid = ${me_rid})}-IS_OWNER->{type:Project, as:pr, where:(@rid = ${project_rid})} RETURN pr`

	var response = await web.sql(query)

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

graph.createSource = async function (project_rid, data, me_rid) {

	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "#${project_rid}" RETURN pr`
	var response = await web.cypher(query)
	console.log(response)
	console.log(response.result[0])
	if (response.result.length == 1) {
		var source = await this.create('Source', data)
		var source_rid = source['@rid']
		await this.connect(project_rid, 'HAS_SOURCE', source_rid)
		return source
	} else {
		console.log('Project not found')
		throw ('Source creation failed! Project not found!')
	}
}


graph.dropIndex = async function (userRid) {

	const query = userRid
	? `MATCH {type:User, as:user, where: (id = "${userRid}")}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`
	: `MATCH {type:User, as:user}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`;
	//const query = `MATCH {type:User, as:user}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return item, user.@rid AS ownerRid`

}


graph.index = async function (userRid) {
    // Construct the query to index user's data or all data
    const filesQuery = userRid
        ? `MATCH {type:User, as:user, where: (@rid = "${userRid}")}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`
        : `MATCH {type:User, as:user}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`;

    const response = await web.sql(filesQuery);

    let documents = [];
    let count = 0;

    for (const item of response.result) {
		// if type of File is text, then read text file from file path
		item.file.fulltext = ''
		if(item.file.type == 'text') {
			try {
				item.file.fulltext = await media.getText(item.file.path)
			} catch (e) {
				console.log(e)
			}
		}
		// must have owner
		if(userRid || item.ownerRid) {
			documents.push({
				id: item.file['@rid'],
				label: item.file.label || '',
				owner: userRid || item.ownerRid,
				node: item.file['@type'],
				type: item.file.type || '',
				description: item.file.description || '',
				fulltext: item.file.fulltext,
			});
			count++;
		}

        
        if (count % 1000 === 0) {
			//console.log(documents)
            await web.indexDocuments(documents);
            documents = [];
        }
    }

    // Index any remaining documents
    if (documents.length > 0) {
        await web.indexDocuments(documents);
    }

    console.log(`${response.result.length} documents indexed`);
	return count
}

graph.getUsers = async function () {
	const query = `SELECT FROM User ORDER by label`
	var response = await web.sql(query)
	return response.result
}


graph.createUser = async function (data) {
	// check that email is valid
	if(!data.id) throw ('Email not defined!')
	if(data.id !== DEFAULT_USER) { // default user has no valid email...
		if (!data.id.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) throw ('Invalid email address!')
	}

	// email must be unique
	const query = `MATCH (p:User) WHERE p.id = "${data.id}" RETURN count(p) as users`
	var response = await web.cypher(query)
	if (response.result[0].users > 0) throw ('User with that email already exists!')
		
	//data['service_groups'] = []
	var user = await this.create('User', data, true)
	await this.initUserData(user)

	// commands to make demo projects
	//var demo1 = `http POST :8200/api/projects label="DEMO 1" description="Käännellään kuvia" '${data.id}'`
	//user.demos = demo1

	return user
}

graph.initUserData = async function (user) {
	// create entity (tag) types
	await this.createEntityTypes(user['@rid'])

	// Create Desks
	//-tee Desk:
	//http POST :8200/api/projects label="DEMO 1" description="Käännellään kuvia" 'mail:local.user@localhost' 
	//await web.internal({label: 'DEMO 1', description: 'Käännellään kuvia'}, user['id'])

	// create demo Projects
	//await web.runPipeline(pipeline, user['id'])
	//http POST :8200/api/pipeline/files/82:6 @pipeline.json 'mail:ari.hayrinen@jyu.fi'
}


graph.getPrompts = async function (userRID) {

	const query = `SELECT FROM Prompt WHERE owner = "public" OR owner = "${userRID}" ORDER BY label`
	var response = await web.sql(query)
	return response.result
}

graph.savePrompt = async function (prompt, userRID) {
	
	prompt.content = prompt.content.replace(/\n/g, '\\n')
	prompt.description = prompt.description.replace(/\n/g, '\\n')
	
	if(prompt['@rid']) {
		var query =  `UPDATE Prompt SET name = "${prompt.name}", content = "${prompt.content}", description = "${prompt.description}" WHERE @rid = ${prompt['@rid']}`	

		var response = await web.sql(query)
		return response.result

	} else {
		var query = `CREATE VERTEX Prompt SET name = "${prompt.name}", content = "${prompt.content}", description = "${prompt.description}", type = "${prompt.type}", owner = "${userRID}"`
		
		var response = await web.sql(query)
		return response.result
	}


}

graph.createEntityTypes = async function (userRID) {	
	for(var type of entityTypes) {
		await this.create('EntityType', {owner: userRID, type: type.type, icon: type.icon, color: type.color, label: type.label})
	}
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

	const options = {
		serializer: 'graph',
		format: 'cytoscape',
		schemas: schema_relations
	}
	
	var result = await web.sql(query, options)

	return result
}


graph.getProject_backup = async function (rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}-IS_OWNER->
		{type:Project, as:project,where:(@rid=${rid})}.out() 
		{as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source") AND (set is NULL OR expand = true) AND $depth > 0), while:($depth < 20)} return node`


	const options = {
		serializer: 'studio',
		format: 'vueflow'
	}
	
	var result = await web.sql2(query, options)
	result = await getSetThumbnails(user_rid, result, rid)
	return result
}



graph.getProjects = async function (user_rid, data_dir) {
	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project) WHERE id(p) = "${user_rid}" OPTIONAL MATCH (pr)-[:HAS_FILE]-(f:File) RETURN pr, count(f) AS file_count`
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

	data = await getProjectThumbnails(user_rid, data, data_dir)
	return data
}


graph.getSetThumbnailsForNode = async function(set_rid) {
	if(!set_rid.match(/^#/)) set_rid = '#' + set_rid
	const query = `select path from File where set =  ${set_rid} ORDER by label LIMIT 2`
	var response = await web.sql(query)
	return response.result.map(item => {
		const dirPath = item.path.split('/').slice(0, -1).join('/')
		return dirPath.replace('data/', 'api/thumbnails/data/')
	})

}

async function getProjectThumbnails(user_rid, data, data_dir) {

	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(f:File) WHERE id(p) = "${user_rid}" 
	RETURN  distinct (id(pr)) as project, collect(f.path)  as paths`
	var response = await web.cypher(query)

	for (var project of data) {
		for (var thumbs of response.result) {
			if (project['@rid'] === thumbs.project) {
				project.paths = []
				thumbs.paths.forEach(function (part, index) {
					if (index < 2) {
						const filename = path.basename(part)
						project.paths.push(API_URL + 'api/thumbnails/' + part.replace(filename, '') + 'thumbnail.jpg')
					}
				});
			}
		}
	}
	return data
}


async function getSetThumbnails(user_rid, data, project_rid) {

	// order image by file label so that result set would show same images as source set
	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project)-[*0..10]->(set:Set)-->(file:File) 
		WHERE id(p) = "${user_rid}" AND id(pr) = "${project_rid}" AND file.type = "image"
		WITH file, set ORDER BY file.label
	RETURN  distinct (id(set)) as set, collect(file.path)  as paths `
	var response = await web.cypher(query)

	for (var set of data.nodes) {
		for (var thumbs of response.result) {
			if (set.data.type === 'Set' && set.data['id'] === thumbs.set) {
			
				set.data.paths = []
				thumbs.paths.forEach(function (part, index) {
					if (index < 2) {
						const filename = path.basename(part)
						set.data.paths.push(API_URL + 'api/thumbnails/' + part.replace(filename, '') + 'thumbnail.jpg')
					}
				});
			}
		}
	}
	return data
}


graph.getProjectFiles = async function (rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(file:File) WHERE id(pr) = "${rid}" AND id(p) = "${user_rid}" RETURN file`
	
	var result = await web.cypher(query)
	return result
}

graph.getSetFiles = async function (set_rid, user_rid, params) {
	if(!params || !isIntegerString(params.skip)) params.skip = 0
	if(!params || !isIntegerString(params.limit)) params.limit = 10
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	// TODO: it would be more efficient if project_rid was used in the query
	const count_query = `select count() AS file_count from File where set=${set_rid}`
	var response_count = await web.sql(count_query)

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}-IS_OWNER->
		{type:Project, as:project}.out() 
		{as:node, where:( (set = ${set_rid}) AND $depth > 0 AND @type = 'File'),  while:($depth < 30)}
                 return  DISTINCT node ORDER by label SKIP ${params.skip} LIMIT ${params.limit}`
	var response = await web.sql(query)
	console.log(query)

	var files = response.result.map(obj => obj.node);
	console.log(files)
	
	
	// thumbnails and entities
	for (var file of files) {
		file.thumb = API_URL + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/');
		// TODO: do this in one query!
		const entity_query = `MATCH (file:File)-[r:HAS_ENTITY]->(entity:Entity) WHERE id(file) = "${file['@rid']}" RETURN entity.label AS label, entity.icon AS icon, entity.color AS color, id(entity) AS rid`
		var entity_response = await web.cypher(entity_query)
		file.entities = entity_response.result
	}
	return { 
		file_count: response_count.result[0].file_count, 
		limit: params.limit,
		skip: params.skip,
		files: files } //response.result
}

graph.getSourceFiles = async function (source_rid, user_rid, params) {

	try {
		var files = []
		if (!source_rid.match(/^#/)) source_rid = '#' + source_rid
	
		const query = `MATCH {type:User, as:user, where:(@rid = "${user_rid}")}-IS_OWNER->{type:Project, as:project}-HAS_SOURCE->{type: Source, as: source, where:(@rid = ${source_rid})}  RETURN source.path AS path`
		var response = await web.sql(query)
	
		var source_file = await media.readJSON(path.join(response.result[0].path, 'source.json'))
		var source_json = JSON.parse(source_file)
		if(source_json.files) {
			files = source_json.files
		}
	
		return files
	} catch (error) {
		console.log(error)
	}

}

graph.createRequestsFromPipeline = async function(data, file_rid, roi) {

	let requests = []
	for(var pipeline of data.pipeline) {
		
		var request = {
			params: {
				file_rid: file_rid,
				topic: pipeline.id
			},
			payload: {
				task: pipeline.task,
				params: pipeline.params,
				info: pipeline.info,
				description: pipeline.description
			}	
		}
		// if we there is next pipeline, add it
		if (pipeline.pipeline) {
			console.log('ADDING pipeline detected')
			request.payload.pipeline = pipeline.pipeline		
		}
		requests.push(request)
	}
	return requests
}

// Some services have long processing time (especially PDF services), so we need to add those to batch queue
// These services have 'batch' property in service.json
graph.getQueueName = function(service, data, topic) {
	if(service.tasks[data.task] && service.tasks[data.task].always_batch) {
		return topic + '_batch'
	}
	return topic	
}

// Creates process and output Set nodes and creates queue messages
graph.createQueueMessages =  async function(service, body, node_rid, user_rid, roi) {

	var data = body
	console.log("****** CREATEQUEUE MESSAGE ******")
	console.log(data.task)
	console.log("****** END CREATEQUEUE MESSAGE ******")

	var messages = []
	var message = structuredClone(data)
	var task_name = ''
	// LLM services have tasks defined in prompts
	if(service.external_tasks) {
		message.external = 'yes'
		message.info = data.info
		message.params = data.system_params
		task_name = data.name	
	} else {
		task_name = service.tasks[data.task].name
	}

	var node_metadata = await this.getUserFileMetadata(node_rid, user_rid)
	if(!node_metadata) {
		throw new Error('File not found: '+ node_rid )
	}

	if(service.tasks[data.task] && service.tasks[data.task].system_params)
		message.params = service.tasks[data.task].system_params

	var processNode = await this.createProcessNode(task_name, service, data, node_metadata, user_rid)
	await media.createProcessDir(processNode.path)
	await media.writeJSON(data, 'params.json', path.join(path.dirname(processNode.path)))

	// do we need info about "parent" file? Like for image rotation based on OSD file
	if(service.tasks[data.task]?.source == 'source_file') {
		const source = await this.getFileSource(node_rid)
		if(source) {
			const source_metadata = await this.getUserFileMetadata(source['@rid'], user_rid)
			message.source = source_metadata
		}
	}

	// if output of task is "Set", then create Set node and link it to Process node
	if(service.tasks[data.task] && service.tasks[data.task].output_set) {
		var setNode = await this.createOutputSetNode(service.tasks[data.task].output_set, processNode)
		message.output_set = setNode['@rid']
		message.set_node = setNode
	}

	// default message
	message.process = processNode
	message.target = node_rid
	message.userId = user_rid
	message.file = node_metadata

	// pdfs are splitted so we give each page its own message
	if(node_metadata.type == 'pdf') {
		message.pdf = true
		const first = parseInt(data.params.firstPageToConvert)
		var last = parseInt(data.params.lastPageToConvert)
		if(isNaN(first)) first = 0
		
		if(node_metadata?.metadata?.page_count) {
			if(isNaN(last)) last = node_metadata.metadata.page_count
			if(last > node_metadata.metadata.page_count) last = node_metadata.metadata.page_count
			if(first < last) {
				var c = 1
				for(var i = first; i <= last; i++) {
					var m = structuredClone(message)
					m.params.page = i
					m.total_files = last - first + 1
					m.current_file = c
					c += 1
					messages.push(m)
				}	
			}
		}
	// ROIs also need one message per ROI
	} else if (roi) {
		// we can work with ROIs only if we have width and height of file
		console.log('ROI: ', roi)
		console.log('NODE METADATA: ', node_metadata)
		if(node_metadata.metadata) var metadata = node_metadata.metadata
		if(metadata && metadata.width && metadata.height) {
			var rois = await this.getROIs(node_rid)
			console.log('ROIS: ', rois)
			for(var roi_item of rois) {
				var m = media.ROIPercentagesToPixels(roi_item, structuredClone(message))
				messages.push(m)
			}	
		}
		// otherwise create normal, single message
	} else {
		messages.push(message)
	}

	return messages
}



// create Process that is linked to File
graph.createProcessNode = async function (topic, service, data, filegraph, me_email, set_rid) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	var file_rid = filegraph['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	const process_attrs = { label: topic }
	process_attrs.service = service.name
	process_attrs.params = JSON.stringify(data)
	if(data.info) {
		process_attrs.info = data.info
	}
	if(data.description) {
		process_attrs.description = data.description
	}
	// mark if this is part of set processing = not displayed in UI by default
	if(set_rid) {
		process_attrs.set = set_rid
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

// Create SetProcess and output Set 
graph.createSetProcessNode = async function (topic, service, data, filegraph ) {

	var file_rid = filegraph['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	var setNode = null
	const process_attrs = { label: topic, path:'' }
	process_attrs.service = service.name
	if(data.info) {
		process_attrs.info = data.info
	}

	processNode = await this.create('SetProcess', process_attrs)
	process_rid = processNode['@rid']

	// finally, connect SetProcess node to source Set node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)
	
	// create process output Set
	if(service.output != 'always file') {
		setNode = await this.create('Set', {path: processNode.path})
		// and link it to SetProcess
		await this.connect(process_rid, 'PRODUCED', setNode['@rid'])
	}

	return {process: processNode, set: setNode} //processNode

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



graph.createProcessSetNode = async function (process_rid, options) {

	const setNode = await this.create('Set', options)
	var set_rid = setNode['@rid']
	await this.connect(process_rid, 'PRODUCED', set_rid)

	return setNode

}

graph.createOriginalFileNode = async function (project_rid, file, file_type, set_rid, data_dir) {

	var description = ''
	var info = ''
	if(file.hapi.description) description = file.hapi.description
	if(file.hapi.info) info = file.hapi.info
	var extension = path.extname(file.hapi.filename).replace('.', '').toLowerCase()
	const query = `MATCH (p:Project) WHERE id(p) = "${project_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${file.hapi.filename}",
				original_filename: "${file.hapi.filename}",
				description: "${description}",
				info: "${info}",
				metadata: {size: 0},
				_active: true
			}
		) <- [r:HAS_FILE] - (p) 
		RETURN file`
	var response = await web.cypher(query)

	var file_rid = response.result[0]['@rid']
	var file_path = path.join(data_dir, 'projects', media.rid2path(project_rid), 'files', media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
	var update_response = await web.cypher(update)
	
	// link file to set
	if(set_rid) {
		await this.connect(set_rid, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute_old(file_rid, {key:"set", value: set_rid}, 'File' ) // this attribute is used in project query
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

	// we must gather all ROIs that has @rid or that are new ones
	var rids = []



	for(var roi of data.rois) {
		// only image ROIs have coordinates
		// if (roi.coordinates) {
		// 	roi.rel_coordinates = await this.getSelectionAsPercentage(data.width, data.height, roi.coordinates)
		// }
		
		// check if this is update by user
		if(roi['@rid']) {
			rids.push(roi['@rid'])
			if(roi['locked']) continue // locked ROIs are not updated
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
			rids.push(response_c.result[0]['@rid'])
		}
	}


	// now we must delete all ROIs that are not in the rids array
	const query_delete = `DELETE FROM ROI WHERE @rid NOT IN [${rids.join(',')}] AND in().@rid = [${rid}]`
	console.log(query_delete)
	var response_delete = await web.sql(query_delete)

	const query_count = `MATCH {type:File, where:(@rid=${rid})}-HAS_ROI->{type:ROI, as:roi} return count(roi) as count`
	var response_count = await web.sql(query_count)
	await this.setNodeAttribute_old(rid, {key:"roi_count", value: response_count.result[0].count}, 'File' )
	return response_count.result[0].count

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

graph.createProcessFileNode = async function (process_rid, message, description, info) {

	const file_type = message.file.type
	const extension = message.file.extension
	const label = message.file.label
	var f_info = ''
	var f_description = ''
	if(description) f_description = description
	if(info) f_info = info
	//if(!description) description = label
	let setquery = ''
	if(message.set) setquery = 'set:"' + message.set + '",'
	var type = 'Process'
	// TODO: check in what situation we need to use SetProcess
	//if(message.source) type = 'SetProcess'
	
	const query = `MATCH (p:${type}) WHERE id(p) = "${process_rid}" 
		CREATE (file:File 
			{
				type: "${file_type}",
				extension: "${extension}",
				label: "${label}",
				description: "${f_description}",
				info: "${f_info}",
				expand: false,
				set: null,
				${setquery}
				_active: true
			}
		) 
		RETURN file, p.path as process_path`
		

		console.log(query)
	var response = await web.cypher(query)

	var file_rid = response.result[0].file['@rid']
	var file_path = path.join(response.result[0].process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	const update = `MATCH (file:File) WHERE id(file) = "${file_rid}" SET file.path = "${file_path}" RETURN file`
	var update_response = await web.cypher(update)

	// if output of process is a set, then connect file to set ALSO and add attribute "set"
	if(message.output_set) {
		await this.connect(message.output_set, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute_old(file_rid, {key:"set", value: message.output_set}, 'File' ) // this attribute is used in project query
		await this.connect(process_rid, 'PRODUCED', file_rid)
	// otherwise connect file to process
	} else {
		await this.connect(process_rid, 'PRODUCED', file_rid)
	}

	return update_response.result[0]
}


graph.getUserFileMetadata = async function (file_rid, user_rid) {

	const clean_file_rid = this.sanitizeRID(file_rid)
	// file must be somehow related to a project that is owned by user
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(@rid = ${user_rid})}
	-IS_OWNER->
		{type:Project, as:project}--> 
		{type:File, as:file, where:(@rid = ${clean_file_rid}), while: ($depth < 20)} return file`

	var file_response = await web.sql(query)

	if(file_response.result[0] && file_response.result[0].file)
		return file_response.result[0].file

	else {
		// check if file is a Set
		var query_set = `MATCH {
			type: User, 
			as:p, 
			where:(@rid = ${user_rid})}
		-IS_OWNER->
			{type:Project, as:project}--> 
			{type:Set, as:file, where:(@rid = ${clean_file_rid}), while: ($depth < 20)} return file`
		var set_response = await web.sql(query_set)
		if(set_response.result[0] && set_response.result[0].file) {
			// we need to get file types of the set content
			const extensions = await getSetFileTypes(file_rid)
			//console.log('extensions', extensions)
			set_response.result[0].file.extensions = extensions
			return set_response.result[0].file

		// check if file is source (not file at all!)
		} else {
			var query_source = `MATCH {
				type: User, 
				as:p, 
				where:(@rid = ${user_rid})}
			-IS_OWNER->
				{type:Project, as:project}--> 
				{type:Source, as:file, where:(@rid = ${clean_file_rid})} return file`
				
			var source_response = await web.sql(query_source)
			if(source_response.result[0] && source_response.result[0].file) {
				return source_response.result[0].file
			}
		}
	}
		return null
}

graph.getFileSource = async function (file_rid) {
	const clean_file_rid = this.sanitizeRID(file_rid)
	const sql = `Match {type:File, as:source}-PROCESSED_BY->{type:Process, as:process}-PRODUCED->{type: File, as:target, where:(@rid = ${clean_file_rid} )} return source`
	var response = await web.sql(sql)
	if(response.result[0] && response.result[0].source) return response.result[0].source

	return null
}


graph.query = async function (body) {
	return web.cypher(body.query)
}

graph.create = async function (type, data, admin) {
	console.log('create', type, data)
	var data_str_arr = []
	// expression data to string
	for (var key in data) {
		if (data[key]) {
			if (Array.isArray(data[key]) && data[key].length > 0) {
				data[key] = data[key].map(i => `'${i}'`).join(',')
				data_str_arr.push(`${key}:[${data[key]}]`)
			} else if (typeof data[key] == 'string') {
				if (data[key].length > MAX_STR_LENGTH) throw ('Too long data!')
				if (data[key] == '[TIMESTAMP]') data_str_arr.push(`${key}: date()`)
				else data_str_arr.push(`${key}:"${data[key].replace(/"/g, '\\"')}"`)
			} else {
				console.log(key, data[key])
				// check that xy values are integers
				if (key == 'position') {
					if (typeof data[key].x == 'number' && typeof data[key].y == 'number') {
						data_str_arr.push(`${key}: {x: ${data[key].x}, y: ${data[key].y}}`)
					} else {
						throw ('Position must be an object with x and y values!')
					}
				} else data_str_arr.push(`${key}:${data[key]}`)
			}
		}
	}

	
	// set some system attributes to all Users
	if (type === 'User') {
		if(!admin) throw ('You are not admin!')
		if (!data['group']) data_str_arr.push(`group: "user"`) // default user group for all persons
		if (!data['access']) data_str_arr.push(`access: "user"`) // default access for all persons
		if (!data['service_groups']) data_str_arr.push(`service_groups: ["OSC"]`) // default service groups for all persons
	}
	// _active
	if (!data['active']) data_str_arr.push(`active: true`)

	var query = `CREATE (n:${type} {${data_str_arr.join(',')}}) return n`

	
	const response = await web.cypher(query)
	return response.result[0]
}

graph.createWithSQL = async function (type, data, admin) {
	console.log('create', type, data)
	var data_str_arr = []
	// expression data to string
	for (var key in data) {
		if (data[key]) {
			if (Array.isArray(data[key]) && data[key].length > 0) {
				data[key] = data[key].map(i => `'${i}'`).join(',')
				data_str_arr.push(`${key}:[${data[key]}]`)
			} else if (typeof data[key] == 'string') {
				if (data[key].length > MAX_STR_LENGTH) throw ('Too long data!')
				if (data[key] == '[TIMESTAMP]') data_str_arr.push(`${key}: date()`)
				else data_str_arr.push(`${key}:"${data[key].replace(/"/g, '\\"')}"`)
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

	var query = `CREATE VERTEX ${type} CONTENT {${data_str_arr.join(',')}}`
	
	const response = await web.sql(query)
	return response.result[0]
}

graph.deleteNode = async function (rid, nats) {
	if (!rid.match(/^#/)) rid = '#' + rid

	var parent = await this.getNodeAttributes(rid)
	if(parent.result.length == 0) throw ('Node not found')
	
	// remove node and all children (out nodes) from solr index
	const q = `TRAVERSE out() FROM ${rid}`
	var traverse = await web.sql(q)
	var targets = []
	for(var node of traverse.result) {
		console.log(node)
		targets.push({id: node['@rid']})
		// remove of path is only necessary for setProcess nodes TODO: make smarter
		if(node['path'])
			await media.deleteNodePath(node['path'])
	}

	if(nats) {
		var index_msg = {
			id:'solr', 
			task: 'delete', 
			target: targets
		}
		nats.publish(index_msg.id, JSON.stringify(index_msg))
	}


	// get path for directory deletion
	const query_path = `SELECT path FROM ${rid}`
	var path_result = await web.sql(query_path)

	// delete all children and node
	var query = `MATCH (n)
		WHERE id(n) = "${rid}" 
		OPTIONAL MATCH (n)-[*]->(child)
		DETACH delete n,child`
	var response = await web.cypher(query)

	const node_path = parent.result[0].path
	const is_project = parent.result[0]['@type'] == 'Project'
	if(node_path)
		await media.deleteNodePath(node_path)
	// project node has no path
	if(is_project) {
		await media.deleteNodePath(path.join('data', 'projects', media.rid2path(rid), 'files')) // must add 'files' so that it does not remove the whole project directory
	}
	
	if(path_result.result[0] && path_result.result[0].path) {
		return { path: path_result.result[0].path}	
	} else {
		return {path: null}
	}

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
graph.connect = async function (from, relation, to) {
	var relation_type = ''
	var attributes = ''

	if (!from.match(/^#/)) from = '#' + from
	if (!to.match(/^#/)) to = '#' + to

	// check for existing link
	var query = `MATCH (from)-[r:${relation}]->(to) WHERE id(from) = "${from}" AND id(to) = "${to}" RETURN r`

	var response = await web.cypher(query)
	if (response.result.length > 0) {
		throw ('Link already exists!')
	}

	if (typeof relation == 'object') {
		relation_type = relation.type
		if (relation.attributes)
			attributes = this.createAttributeCypher(relation.attributes)
	} else if (typeof relation == 'string') {
		relation_type = relation
	}
	var query = `MATCH (from), (to) WHERE id(from) = "${from}" AND id(to) = "${to}" CREATE (from)-[:${relation_type} ${attributes}]->(to) RETURN from, to`

	return web.cypher(query)
}


graph.unconnect = async function (from, relation, to) {
	if (!from.match(/^#/)) from = '#' + from
	if (!to.match(/^#/)) to = '#' + to
	var query = `MATCH (from)-[r:${relation}]->(to) WHERE id(from) = "${from}" AND id(to) = "${to}" DELETE r RETURN from`
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

graph.isProjectOwner = async function (rid, userRID) {
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(@rid = :userRID)}
	-IS_OWNER->
		{type:Project, as:project,  where:(@rid = :rid)} return project`

	var response = await web.sql_params(query, {rid: rid, userRID: userRID}, true)
	return response.result.length > 0
}

graph.isNodeOwner = async function (rid, userRID) {

	// node must be somehow related to a project that is owned by user
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(@rid = ${userRID})}
	-IS_OWNER->
		{type:Project, as:project}--> 
		{as:node, where:(@rid = ${rid}), while: ($depth < 20)} return node`

	var file_response = await web.sql(query)
	if(file_response.result.length > 0) return file_response.result[0]
	return null
}

graph.validateNodeAttribute = async function (data) {
	if (Array.isArray(data.value) && data.value.length > 0) {
		data.value = data.value.map(i => `'${i}'`).join(',')
		return true
	}
	return false
}

graph.setNodeError = async function (rid, error, userRID) {
	if(!await this.isNodeOwner(rid, userRID)) throw({'message': 'You are not the owner of this file'})
	let query = `UPDATE ${rid} SET node_error = 'error'`
	let params = {error: error}
	try {
		return web.sql(query)
	} catch (e) {
		throw({'message': 'Error setting node error'})
	}
}

graph.setNodePosition = async function (rid, position) {

	// check that position is an object with x and y properties
	if(typeof position != 'object' || !position.x || !position.y) throw({'message': 'Invalid position'})
	// check that x and y are integers between -2000 and 2000, or zero
	if(!Number.isInteger(position.x) || position.x > MAX_POSITION || position.x < -MAX_POSITION) throw({'message': `Position x must be an integer between -${MAX_POSITION} and ${MAX_POSITION}`})
	if(!Number.isInteger(position.y) || position.y > MAX_POSITION || position.y < -MAX_POSITION) throw({'message': `Position y must be an integer between -${MAX_POSITION} and ${MAX_POSITION}`})

	let query = `UPDATE ${rid} SET position = {x: ${position.x}, y: ${position.y}}`
	return web.sql(query)
}

graph.setProjectAttribute = async function (rid, data, userRID) {
	if(!await this.isProjectOwner(rid, userRID)) throw({'message': 'You are not the owner of this project'})

	const where = ` WHERE @rid = :rid`
	let query = ''
	let params = {rid: rid}

	if (data.key == 'position') {
		return this.setNodePosition(rid, data.value)
	}

	if(['description', 'label'].includes(data.key)) {
		query = `UPDATE Project SET ${data.key} = :${data.key} ${where}`
		params[data.key] = data.value
	} else {
		throw({'message': 'Invalid data'})
	}

	return web.sql_params(query, params)
}	


graph.setNodeAttribute = async function (rid, data, userRID) {

	if(!await this.isNodeOwner(rid, userRID)) throw({'message': 'You are not the owner of this file'})

	let query = ''
	let params = {rid: rid}
	if(NODE_ATTRIBUTES.includes(data.key)) {
		query = `UPDATE :rid SET ${data.key} = :${data.key}`
		params[data.key] = data.value
	} else {
		throw({'message': 'Invalid data'})
	}

	return web.sql_params(query, params)
}


graph.setNodeAttribute_old = async function (rid, data, type) {
	const clean_file_rid = this.sanitizeRID(rid)
	if (!type) throw('Type is required')

	const where = ` WHERE @rid = ${clean_file_rid} `
	let query = ''

	if (Array.isArray(data.value) && data.value.length > 0) {
		data.value = data.value.map(i => `'${i}'`).join(',')
		query = `UPDATE ${type} SET ${data.key} = [${data.value}] ${where}`
	} else if (typeof data.value == 'boolean' || typeof data.value == 'number') {
		query = `UPDATE ${type} SET ${data.key} = ${data.value} ${where}`
	} else if (typeof data.value == 'string') {
		query = `UPDATE ${type} SET ${data.key} = '${data.value.replace(/'/g, "\\'")}' ${where}`
	} else if (typeof data.value == 'object') {
		query = `UPDATE ${type} SET ${data.key} = ${JSON.stringify(data.value)} ${where}`
	} else {
		throw('Illegal data', data)
	}
	console.log(query)
	return web.sql(query)

}


graph.getNodeAttributes = async function (rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH (node) WHERE id(node) = '${rid}' RETURN node`
	return web.cypher(query)
}


// graph.getGraph = async function (body, ctx) {

// 	var me = await this.myId(ctx.request.headers.mail)
// 	// ME
// 	if (body.query.includes('_ME_')) {
// 		body.query = body.query.replace('_ME_', me.rid)
// 	}

// 	var schema_relations = null
// 	// get schemas first so that one can map relations to labels
// 	if (!body.raw) {
// 		schema_relations = await this.getSchemaRelations()
// 	}
// 	const options = {
// 		serializer: 'graph',
// 		format: 'cytoscape',
// 		schemas: schema_relations,
// 		current: body.current,
// 		me: me
// 	}
// 	return web.cypher(body.query, options)
// }


// graph.getSchemaRelations = async function () {
// 	var schema_relations = {}
// 	var schemas = await web.cypher('MATCH (s:Schema_)-[r]->(s2:Schema_) return type(r) as type, r.label as label, r.label_rev as label_rev, COALESCE(r.label_inactive, r.label) as label_inactive, s._type as from, s2._type as to, r.tags as tags, r.compound as compound')
// 	schemas.result.forEach(x => {
// 		schema_relations[x.type] = x
// 	})
// 	return schema_relations
// }


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
	if (!user) return null
	if(user.startsWith('#')) {
		var query = `SELECT @rid AS rid, group, access, service_groups, label, id, active FROM User WHERE @rid = ${user}`
		var response = await web.sql(query)
		return response.result[0]
	} else {
		var query = `SELECT @rid AS rid, group, access, service_groups, label, id, active FROM User WHERE id = "${user}"`
		var response = await web.sql(query)
		return response.result[0]
	}
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

graph.traverse = async function (rid, direction, userRID) {
	console.log('traverse', rid, direction, userRID)
	const access = await this.hasAccess(rid, userRID)
	console.log('access', access)
	if(access == false) return

	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `TRAVERSE ${direction}() FROM ${rid}`
	console.log(query)
	var response = await web.sql(query)
	return response.result
}

graph.getEntityTypeSchema = async function (userRID) {
	var query = `select FROM EntityType WHERE owner = "${userRID}" ORDER by type`
	console.log(query)
	var types = await web.sql(query)
	return types.result
}

graph.getEntityTypes = async function (userRID) {
	var query = `select type, count(type) AS count, LIST(label) AS labels, icon, color,LIST(@this) AS items FROM Entity WHERE owner = "${userRID}" group by type order by count desc`
	var types = await web.sql(query)
	return types.result
}

// TODO: this requires pagination
graph.getEntityItems = async function (entities, userRID) {
	var entities_clean = cleanRIDList(entities)
	if(!entities_clean.length) return []
	//var query = `select in("HAS_ENTITY") AS items, label, @rid From Entity WHERE owner = "${userRID}" AND @rid IN [${entities_clean.join(',')}]`
	var query = `match {type:File, as:item}-HAS_ENTITY->{as:entity, where:(@rid IN [${entities_clean.join(',')}] AND owner = "${userRID}")} return  DISTINCT item.label AS label, item.info AS info, item.description AS description, item.@rid AS rid, item.path AS path, item.type AS type LIMIT 20`
	var response = await web.sql(query)

	if(!response.result.length) return []
	var items = addThumbPaths(response.result)

	return items
}

graph.getEntitiesByType = async function (type) {
	if(!type) return []
	var query = `select from Entity where type = "${type}" ORDER by label`
	return await web.sql(query)
}

graph.getEntity = async function (rid, userRID) {
	var query = `MATCH {type: Entity, as: entity, where: (id = "${rid}" AND owner = "${userRID}")} RETURN entity`
	return await web.sql(query)
}

graph.getLinkedEntities = async function (rid, userRID) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH {type: File, as: file, where:(@rid = ${rid} )}-HAS_ENTITY->{type: Entity, as: entity, where: (owner = "${userRID}")} RETURN entity.label AS label, entity.type AS type, entity.@rid AS rid, entity.color AS color, entity.icon AS icon`

	var response = await web.sql(query)
	return response.result
}

graph.createEntity = async function (data, userRID) {
	if(!data.type || data.type == 'undefined') return
	if(!data.label || data.label == 'undefined') return
	var schema = `SELECT color, icon FROM EntityType WHERE type = "${data.type}"`
	var response = await web.sql(schema)
	if(response.result.length) {
		if(!data.icon) data.icon = response.result[0].icon || 'mdi-tag'
		if(!data.color) data.color = response.result[0].color || '#ff8844'
	} else {
		data.icon = 'mdi-tag'
		data.color = '#ff8844'
	}
	var query = `CREATE Vertex Entity set type = "${data.type}", label = "${data.label}", icon = "${data.icon}", color = "${data.color}", owner = "${userRID}"`
	console.log(query)
	return await web.sql(query)
}

graph.checkEntity = async function (data, node_rid, userRID) {
	var query = `MATCH {type: Entity, as: entity, where: (type = "${data.type}" AND label = "${data.label}" AND owner = "${userRID}")}--{as: node, where: (@rid = ${node_rid}), optional: true} RETURN entity, node`
	return await web.sql(query)
}

// data should be array of entities
graph.createEntityAndLink = async function (data, rid, userRID) {
	if(!rid.match(/^#/)) rid = '#' + rid
	var entities = []
	for(var entity of data) {
		var response = await this.checkEntity(entity, rid, userRID)
		if(response.result.length) {
			if(!response.result[0].node) {
				await this.linkEntity(rid, response.result[0].entity['@rid'], userRID)
			}
		} else {
			var new_entity = await this.createEntity(entity, userRID)
			if(new_entity.result.length) {
				await this.linkEntity(new_entity.result[0]['@rid'], rid, userRID)
			}
			entities.push(new_entity)
		}
	}
	return entities
}

graph.linkEntity = async function (rid, vid, userRID) {	
	if(!rid.match(/^#/)) rid = '#' + rid
	if(!vid.match(/^#/)) vid = '#' + vid
	var query = `MATCH {type: Entity, as: entity, where: (@rid = ${rid} AND owner = "${userRID}")} RETURN entity`
	console.log(query)
	var response = await web.sql(query)
	var entity = response.result[0]
	
	var query = `SELECT shortestPath(${vid}, ${userRID}) AS path`
	response = await web.sql(query)

	var target = response.result[0]
	console.log(entity, target)
	if(!entity || !target) return	
	var linked = await this.connect(vid, 'HAS_ENTITY',rid)
	return linked
}

graph.unLinkEntity = async function (rid, vid, userRID) {
	if(!rid.match(/^#/)) rid = '#' + rid
	if(!vid.match(/^#/)) vid = '#' + vid
	var query = `MATCH {type: Entity, as: entity, where: (@rid = "${rid}" AND owner = "${userRID}")} RETURN entity`
	var response = await web.sql(query)
	var entity = response.result[0]
	console.log(entity)
	var query = `SELECT shortestPath(${vid}, ${userRID}) AS path`
	response = await web.sql(query)
	console.log(response.result)
	var target = response.result[0]
	if(!entity || !target) return	
	await this.unconnect(vid, 'HAS_ENTITY',rid)
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

graph.getNode = async function (userRID) {
	var query = `MATCH {type:User, as:user, where: (id = "${userRID}")}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file`
	var response = await web.sql(query)
	if(response.result.length == 0) return []
	return response.result[0]
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


		return schemas
	


}


graph.sanitizeRID = function(rid) {

    if (typeof rid !== "string") {
        throw new Error("RID must be a string");
    }
    
	if (!rid.match(/^#/)) rid = '#' + rid.trim()

    // Regular expression to match valid RIDs
    const ridPattern = /^#(\d+):(\d+)$/;
    const match = rid.match(ridPattern);
    
    if (!match) {
        throw new Error("Invalid RID format");
    }
    
    // Extract and validate components
    const clusterId = match[1];
    const recordId = match[2];
    
    if (!/^[0-9]+$/.test(clusterId) || !/^[0-9]+$/.test(recordId)) {
        throw new Error("Cluster ID and Record ID must be positive integers");
    }
    
	return rid
}





function addThumbPaths(items) {

	for (var file of items) {
		file.thumb = API_URL + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/');
	}
	return items
	
}



function cleanRIDList(list) {
	var splitted = list.split(',')
	var out = []
	for (var item of splitted) {
		if (!item.match(/^#/)) item = '#' + item.trim()
		if(item == '#') continue
		out.push(item)
	}
	return out
}

function isIntegerString(value) {
    return typeof value === "string" && /^-?\d+$/.test(value);
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



export default graph