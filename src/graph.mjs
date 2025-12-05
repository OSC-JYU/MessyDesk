
import path from 'path';



import db from "./db.mjs";
import media from "./media.mjs";
import solr from "./solr.mjs";

import timers from 'timers-promises';
import { DATA_DIR, DB_URL, API_URL } from './env.mjs';

const MAX_STR_LENGTH = 2048;
const DEFAULT_USER = 'local.user@localhost';
const MAX_POSITION = 10000; // max x and y for project nodes
const graph = {};

// allowed attributes that setNodeAttribute can set
const NODE_ATTRIBUTES = ['description', 'label', 'info', 'expand', 'metadata', 'response', 'node_error', 'path']

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
	db.initURL(DB_URL)
	console.log(`ArcadeDB: ${db.getURL()}`)
	console.log(`Checking database...`)
	let db_exists = false
	try {
		db_exists = await db.checkDB()
		if (db_exists)
			console.log('Database found!')
		else
			throw ('Database not found!')

	} catch (e) {

		try {
			console.log('Database not found, creating...')
			await db.createDB()
			await graph.createUser({id: DEFAULT_USER, label: 'Just human', access: 'admin', active: true})
		} catch (e) {
			console.log(e.message)
			console.log(`Could not init database. \nTrying again in 10 secs...`)
			await timers.setTimeout(10000)
			try {
				await db.createDB()
				await graph.createUser({id: DEFAULT_USER, label: 'Just human', access: 'admin', active: true})
			} catch (e) {
				console.log(`Could not init database. \nIs Arcadedb running at ${db.getURL()}?`)
				console.log('exiting...')
				process.exit(1)
			}
		}
		console.log('Database created!')
	}
}

graph.hasAccess = async function (item_rid, user_rid) {
	if (!item_rid.match(/^#/)) item_rid = '#' + item_rid
	const query = `TRAVERSE in() FROM ${item_rid}`
	var response = await db.sql(query)
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
	var response = await db.cypher(query)
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
	var response = await db.sql(query)
	if(response.result.length == 1) {
		await this.deleteNode(response.result[0]['rid'], nats)
	}
	return response.result[0]['rid']
}

graph.createSet = async function (project_rid, data, me_rid) {

	//const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "${project_rid}" RETURN pr`
	const query = `MATCH {type:User, as:p, where:(@rid = ${me_rid})}-IS_OWNER->{type:Project, as:pr, where:(@rid = ${project_rid})} RETURN pr`

	var response = await db.sql(query)

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

graph.createSource = async function (project_rid, data, me_rid, nats) {

	const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "${project_rid}" RETURN pr`

	var response = await db.cypher(query)
	if (response.result.length == 1) {
		data.status = 'initing...'
		var source = await this.create('Source', data)
		var source_rid = source['@rid']
		// DATA_DIR + '/projects/' + project_rid + '/sources/' + source_rid
		const source_path = path.join(DATA_DIR, 'projects', media.rid2path(project_rid), 'sources', media.rid2path(source_rid))
		source.path = source_path
		await this.connect(project_rid, 'HAS_SOURCE', source_rid)
		await media.createProcessDir(source.path)
		await this.setNodeAttribute(source_rid, {key: 'path', value: source.path}, me_rid)

		// send init request to service 
		var init_task = {
			service: {id:"md-" + data.type.toLowerCase()},
			task: {id:"init", params: {url:`${source.url}`},},
			file:source,
			process:source,
			userId: me_rid
		}
		nats.publish(init_task.service.id, JSON.stringify(init_task))

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

    const response = await db.sql(filesQuery);

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
            await db.indexDocuments(documents);
            documents = [];
        }
    }

    // Index any remaining documents
    if (documents.length > 0) {
        await db.indexDocuments(documents);
    }

    console.log(`${response.result.length} documents indexed`);
	return count
}

graph.getUsers = async function () {
	const query = `SELECT FROM User ORDER by label`
	var response = await db.sql(query)
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
	var response = await db.cypher(query)
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
	//await db.internal({label: 'DEMO 1', description: 'Käännellään kuvia'}, user['id'])

	// create demo Projects
	//await db.runPipeline(pipeline, user['id'])
	//http POST :8200/api/pipeline/files/82:6 @pipeline.json 'mail:ari.hayrinen@jyu.fi'
}


graph.getPrompts = async function (userRID) {

	const query = `SELECT FROM Prompt WHERE owner = "public" OR owner = "${userRID}" ORDER BY label`
	var response = await db.sql(query)
	return response.result
}

graph.savePrompt = async function (prompt, userRID) {
	
	prompt.content = prompt.content.replace(/\n/g, '\\n').replace(/['"]/g, "'")
	prompt.description = prompt.description.replace(/\n/g, '\\n').replace(/['"]/g, "'")
	prompt.name = prompt.name.replace(/['"]/g, "'")
	if(prompt.json_schema) {
		// Validate that json_schema is valid JSON
		try {
			// Parse the JSON to validate it's valid
			const parsedJson = JSON.parse(prompt.json_schema);
			
			// Check that the root JSON is an object, not an array
			if (Array.isArray(parsedJson)) {
				throw new Error('JSON schema must be an object, not an array. Arrays are allowed as values within the object.');
			}
			
			// Re-stringify to ensure consistent formatting and escape quotes for database storage
			prompt.json_schema = JSON.stringify(parsedJson).replace(/"/g, '\\"');
		} catch (error) {
			// Try to fix JSON by adding missing quotes around keys
			try {
				let fixedJson = prompt.json_schema;
				
				// Add quotes around unquoted keys (but preserve existing quoted keys)
				fixedJson = fixedJson.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
				
				// Add quotes around unquoted string values (but preserve numbers, booleans, null, objects, arrays)
				fixedJson = fixedJson.replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*([,}\]])/g, (match, value, ending) => {
					// Don't quote if it's a known keyword or starts with { or [
					if (/^(true|false|null|\d+\.?\d*|\{|\[)/.test(value)) {
						return match;
					}
					return `: "${value}"${ending}`;
				});
				
				// Validate the fixed JSON
				const parsedFixedJson = JSON.parse(fixedJson);
				
				// Check that the root JSON is an object, not an array
				if (Array.isArray(parsedFixedJson)) {
					throw new Error('JSON schema must be an object, not an array. Arrays are allowed as values within the object.');
				}
				
				// Re-stringify and escape quotes for database storage
				prompt.json_schema = JSON.stringify(parsedFixedJson).replace(/"/g, '\\"');
			} catch (fixError) {
				throw new Error('Invalid JSON schema: ' + error.message + '. Attempted fix also failed: ' + fixError.message)
			}
		}
	} else {
		prompt.json_schema = ''
	}
	if(!prompt.output_type) {
		prompt.output_type = 'text'
	}
	if(prompt.output_type != 'json' && prompt.output_type != 'text') {
		prompt.output_type = 'text'
	} 
	
	if(prompt['@rid']) {
		var query =  `UPDATE Prompt SET name = "${prompt.name}", content = "${prompt.content}", description = "${prompt.description}", json_schema = "${prompt.json_schema}", output_type = "${prompt.output_type}" WHERE @rid = ${prompt['@rid']}`	

		var response = await db.sql(query)
		return response.result

	} else {
		var query = `CREATE VERTEX Prompt SET name = "${prompt.name}", content = "${prompt.content}", description = "${prompt.description}", json_schema = "${prompt.json_schema}", output_type = "${prompt.output_type}", type = "${prompt.type}", owner = "${userRID}"`
		
		var response = await db.sql(query)
		return response.result
	}


}

graph.createEntityTypes = async function (userRID) {	
	for(var type of entityTypes) {
		await this.create('EntityType', {owner: userRID, type: type.type, icon: type.icon, color: type.color, label: type.label})
	}
}

graph.getProjectMetadata = async function (rid, me_email) {
	const query = `MATCH {as: person, type: User, where: (id = "${me_email}")}-IS_OWNER->{as:project, type:Project, where: (@rid = ${rid})} RETURN project`
	var result = await db.sql(query)
	return result
}


graph.getProject_old = async function (rid, me_email) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `MATCH {as: person, type: User, where: (id = "${me_email}")}-IS_OWNER->{as:project, type:Project, where: (@rid = ${rid})}-->{as:file, 
				where:((@type = 'Set' OR @type = 'SetProcess' OR @type = 'Process') OR ( @type = 'File'  AND (set is NULL OR expand = true) )), while: (true)}
				RETURN file`
	
	var result = await db.sql(query)

	return result
}


graph.getProject = async function (rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}-IS_OWNER->
		{type:Project, as:project,where:(@rid=${rid})}.out() 
		{as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source") AND (set is NULL OR expand = true) AND $depth > 0), while:($depth < 20)} return node`


	const options = {
		serializer: 'studio',
		format: 'vueflow'
	}
	
	var result = await db.sql(query, options)
	result = await getSetThumbnails(user_rid, result, rid)
	return result
}



graph.getProjects = async function (user_rid, data_dir) {
	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project) WHERE id(p) = "${user_rid}" OPTIONAL MATCH (pr)-[:HAS_FILE]-(f:File) RETURN pr, count(f) AS file_count`
	var response = await db.cypher(query)
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
	const query = `select path from File where set =  ${set_rid} ORDER by label LIMIT 4`
	var response = await db.sql(query)
	return response.result.map(item => {
		const dirPath = item.path.split('/').slice(0, -1).join('/')
		return dirPath.replace('data/', 'api/thumbnails/data/')
	})

}

async function getProjectThumbnails(user_rid, data, data_dir) {

	const query = `MATCH (p:User)-[r:IS_OWNER]->(pr:Project)-[:HAS_FILE]->(f:File) WHERE id(p) = "${user_rid}" 
	RETURN  distinct (id(pr)) as project, collect(f.path)  as paths`
	var response = await db.cypher(query)

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
	var response = await db.cypher(query)

	for (var set of data.nodes) {
		for (var thumbs of response.result) {
			if (set.data.type === 'Set' && set.data['id'] === thumbs.set) {
			
				set.data.paths = []
				thumbs.paths.forEach(function (part, index) {
					if (index < 4) {
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
	
	var result = await db.cypher(query)
	return result
}

graph.getSetFiles = async function (set_rid, user_rid, params) {
	if(!params || !isIntegerString(params.skip) && !Number.isInteger(params.skip)) params.skip = 0
	if(!params || !isIntegerString(params.limit) && !Number.isInteger(params.limit)) params.limit = 10
	
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	// TODO: it would be more efficient if project_rid was used in the query
	const count_query = `select count() AS file_count from File where set=${set_rid}`
	var response_count = await db.sql(count_query)

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}-IS_OWNER->
		{type:Project, as:project}.out() 
		{as:node, where:( (set = ${set_rid}) AND $depth > 0 AND @type = 'File'),  while:($depth < 30)}
                 return  DISTINCT node ORDER by label SKIP ${params.skip} LIMIT ${params.limit}`
	var response = await db.sql(query)
	

	var files = response.result.map(obj => obj.node);
	
	
	// thumbnails and entities
	if(params.thumbnails) {
		for (var file of files) {
			file.thumb = API_URL + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/');
				// TODO: do this in one query!
				const entity_query = `MATCH (file:File)-[r:HAS_ENTITY]->(entity:Entity) WHERE id(file) = "${file['@rid']}" RETURN entity.label AS label, entity.icon AS icon, entity.color AS color, id(entity) AS rid`
				var entity_response = await db.cypher(entity_query)
				file.entities = entity_response.result
			}
	}
	
	return { 
		file_count: response_count.result[0].file_count, 
		limit: params.limit,
		skip: params.skip,
		files: files } //response.result
}

// this reads list of files from Nextcloud source
graph.getSourceFiles = async function (source_rid, user_rid, params) {

	try {
		var files = []
		if (!source_rid.match(/^#/)) source_rid = '#' + source_rid
	
		const query = `MATCH {type:User, as:user, where:(@rid = "${user_rid}")}-IS_OWNER->{type:Project, as:project}-HAS_SOURCE->{type: Source, as: source, where:(@rid = ${source_rid})}  RETURN source.path AS path`
		var response = await db.sql(query)
	
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
graph.createQueueMessages =  async function(service, task, node_rid, user_rid, roi) {


	console.log("****** CREATEQUEUE MESSAGE ******")
	console.log(task.id)
	console.log(task.model)
	console.log("****** END CREATEQUEUE MESSAGE ******")

	var messages = []

	var node_metadata = await this.getUserFileMetadata(node_rid, user_rid)
	if(!node_metadata) {
		throw new Error('Target file not found: '+ node_rid )
	}

	var msg = {
		service: service,
		task: task,
		file: node_metadata,
		process: null,   // process node will be created in the queue
		output_set: null,
		userId: user_rid
	}

	// LLM services have tasks defined in prompts
	if(service.external_tasks) {
		msg.external = 'yes'
		msg.task.params = task.system_params
		// add model information if service has models
		if(service.models && task.model) {
			// task.model could be either a string ID or the entire model object
			let modelId = typeof task.model === 'string' ? task.model : task.model.id
			if(modelId && service.models[modelId]) {
				msg.task.model = structuredClone(service.models[modelId])
				msg.task.model.id = modelId
			}
		}
	// otherwise task must be found from service tasks object
	} else if(!service.tasks[task.id]) {
		console.log(service)
		throw new Error('Task not found in service: '+ task.id )
	} else {
		// Do not trust task.name from request, use service.tasks[task.id].name instead
		msg.task.name = service.tasks[task.id].name
		// copy system params from service
		if(service.tasks[task.id].system_params)
			msg.task.params = service.tasks[task.id].system_params
	}


	//var processNode = await this.createProcessNode_queue(service, task, node_metadata, user_rid)
	msg.process = await this.createProcessNode_queue(msg)
	await media.createProcessDir(msg.process.path)
	await media.writeJSON(msg, 'message.json', path.join(path.dirname(msg.process.path)))

	// do we need info about "parent" file? Like for image rotation based on OSD file
	if(service.tasks[task.id]?.source == 'source_file') {
		const source = await this.getFileSource(node_rid)
		if(source) {
			const source_metadata = await this.getUserFileMetadata(source['@rid'], user_rid)
			msg.file.source = source_metadata
		}
	}

	// if output of task is "Set", then create Set node and link it to Process node
	if(service.tasks[task.id] && service.tasks[task.id].output_set) {
		var setNode = await this.createOutputSetNode(service.tasks[task.id].output_set, msg.process)
		msg.output_set = setNode['@rid']
		msg.set_node = setNode
	}


	// pdfs are splitted so we give each page its own message
	if(node_metadata.type == 'pdf') {
		console.log('PDF: ', node_metadata)
		msg.pdf = true
		const first = parseInt(task.params.firstPageToConvert)
		var last = parseInt(task.params.lastPageToConvert)
		if(isNaN(first)) first = 0
		console.log('TASK: ', task)
		console.log('TASK PARAMS: ', task.params)
		console.log('FIRST: ', first)
		console.log('LAST: ', last)
		
		if(node_metadata?.metadata?.page_count) {
			if(isNaN(last)) last = node_metadata.metadata.page_count
			if(last > node_metadata.metadata.page_count) last = node_metadata.metadata.page_count
			if(first < last) {
				var c = 1
				for(var i = first; i <= last; i++) {
					var m = structuredClone(msg)
					m.task.params.page = i
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
				var m = media.ROIPercentagesToPixels(roi_item, structuredClone(msg))
				messages.push(m)
			}	
		}
		// otherwise create normal, single message
	} else {
		messages.push(msg)
	}

	return messages
}



// // create Process that is linked to File
// graph.createProcessNode = async function (service, task, filegraph, me_email, set_rid, set_process_rid, tid) {

// 	if(!msg.task) {
// 		throw new Error('Task not found in message')
// 	}


// 	var file_rid = filegraph['@rid']
	
// 	// create process node
// 	var processNode = {}
// 	var process_rid = null
// 	const process_attrs = { 
// 		label: task.name,
// 		service: service.name
// 	}
// 	// we remove json_schema from database record (might get messy)
// 	var data_copy = structuredClone(task)
// 	if(data_copy.system_params) delete data_copy.system_params.json_schema

// 	process_attrs.params = JSON.stringify(data_copy)
// 	if(task.info) {
// 		process_attrs.info = task.info
// 	}
// 	if(task.description) {
// 		process_attrs.description = task.description
// 	}
// 	// mark if this is part of set processing = not displayed in UI by default
// 	if(set_rid) {
// 		process_attrs.set = set_rid
// 	}
// 	if(set_process_rid) {
// 		process_attrs.set_process = set_process_rid
// 	}
// 	processNode = await this.create('Process', process_attrs, null,tid)
// 	process_rid = processNode['@rid']
// 	var file_path = filegraph.path.split('/').slice(0, -1).join('/')
// 	processNode.path = path.join(file_path, 'process', media.rid2path(process_rid), 'files')
// 	// update process path to record
// 	await this.setNodeAttribute_old(process_rid, {"key": "path", "value": processNode.path}, 'Process', tid)
	
// 	// finally, connect process node to file node
// 	await this.connect(file_rid, 'PROCESSED_BY', process_rid, tid)

// 	// create process output file node
// 	//await this.createProcessFileNode(process_rid, data, '', '')

// 	return processNode

// }


graph.createProcessNode_queue = async function (msg) {

	if(!msg.task) {
		throw new Error('Task not found in message')
	}

	var file_rid = msg.file['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	const process_attrs = { 
		label: msg.task.name,
		service: msg.service.name
	}

	if(msg.service.id) process_attrs.service_id = msg.service.id
	if(msg.task.id) process_attrs.task = msg.task.id
	if(msg.task.info) process_attrs.info = msg.task.info

	if(msg.task.description) process_attrs.description = msg.task.description
	if(msg.task.model) process_attrs.model = msg.task.model.id
	if(msg.task.model?.version) process_attrs.model_version = msg.task.model.version
	//if(msg.task.params.prompts?.content) process_attrs.task.params.prompts = msg.task.params.prompts.content.slice(0, 100) + '...'

	// mark if this is part of set processing = not displayed in UI by default
	if(msg.output_set) process_attrs.set = msg.output_set
	if(msg.set_process_rid) process_attrs.set_process = msg.set_process_rid

	processNode = await this.create('Process', process_attrs)
	process_rid = processNode['@rid']
	var file_path = msg.file.path.split('/').slice(0, -1).join('/')
	processNode.path = path.join(file_path, 'process', media.rid2path(process_rid), 'files')
	// update process path to record
	await this.setNodeAttribute_old(process_rid, {"key": "path", "value": processNode.path}, 'Process')
	
	// finally, connect process node to file node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)

	// create process output file node
	//await this.createProcessFileNode(process_rid, data, '', '')
	console.log('***************** processNode ***************')
	console.log(processNode)

	return processNode

}


// Create SetProcess and output Set 
graph.createSetAndProcessNodes = async function (service, task, filegraph ) {

	var file_rid = filegraph['@rid']
	
	// create process node
	var processNode = {}
	var process_rid = null
	var setNode = null
	const process_attrs = { label: task.name, path:'' }
	process_attrs.service = service.name
	if(task.info) {
		process_attrs.info = task.info
	}

	processNode = await this.create('SetProcess', process_attrs)
	process_rid = processNode['@rid']

	// finally, connect SetProcess node to source Set node
	await this.connect(file_rid, 'PROCESSED_BY', process_rid)
	
	// create process output Set
	if(service.external_tasks || service.tasks[task.id].output != 'always file') {
		setNode = await this.create('Set', {path: processNode.path})
		// and link it to SetProcess
		await this.connect(process_rid, 'PRODUCED', setNode['@rid'])
	}

	return {process: processNode, set: setNode} //processNode

}


graph.createManyToOneProcessNode = async function (topic, service, data, setgraph ) {

	const set_rid = setgraph['@rid']

	const process_attrs = { label: topic, path:'' }
	process_attrs.service = service.name
	if(data.info) {
		process_attrs.info = data.info
	}
	const processNode = await this.create('Process', process_attrs)
	const process_rid = processNode['@rid']

	const data_dir = DATA_DIR
	const process_path = path.join(data_dir, 'projects', media.rid2path(setgraph.project_rid), 'processes', media.rid2path(process_rid))
	await media.createProcessDir(process_path)
	const update = `MATCH (p:Process) WHERE id(p) = "${process_rid}" SET p.path = "${process_path}" RETURN p`
	var update_response = await db.cypher(update)
	processNode.path = process_path

	// finally, connect Process node to source Set node
	await this.connect(set_rid, 'PROCESSED_BY', process_rid)

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

	var vertex_params = {
		type: file_type,
		extension: extension,
		label: file.hapi.filename,
		original_filename: file.hapi.filename,
		description: description,
		info: info,
		expand: false,
		metadata: {size: 0},
		_active: true
	}
	
	const query = `CREATE VERTEX File CONTENT ${JSON.stringify(vertex_params)}`
	
	var response = await db.sql(query)
	var file_rid = response.result[0]['@rid']
	await this.connect(project_rid, 'HAS_FILE', file_rid)
	var file_path = path.join(data_dir, 'projects', media.rid2path(project_rid), 'files', media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path
	
	// link file to set
	if(set_rid) {
		if (!set_rid.match(/^#/)) set_rid = '#' + set_rid
		await this.connect(set_rid, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute_old(file_rid, {key:"set", value: set_rid}, 'File' ) // this attribute is used in project query
		await this.updateFileCount(set_rid)
	}
	
	return response.result[0]
}



graph.createErrorNode = async function (error, message, data_dir) {

	if(!message || !message.file) {
		console.log('Message or file not found')
		throw new Error('Message or file not found')
	}
	const label = message.file.label
	const description = error.code || 'unknown'
	const info = error.message || 'There was an error processing your file.'

	if(message.process) {
		const process_rid = message.process['@rid']
		const path_query = `SELECT path FROM ${process_rid}`
		const path_response = await db.sql(path_query)
		const process_path = path_response.result[0].path
	} else {
		console.log('Process not found in message')
		throw new Error('Process not found in message')
	}

	const vertex_params = {
		type: "error.json",
		extension: "json",
		label: `${label}.error.json`,
		description: description,
		info: info,
		metadata: {size: 0},
		_active: true
	}
	const query = `CREATE VERTEX File CONTENT ${JSON.stringify(vertex_params)}`

	if(message.set) vertex_params.set = message.set

	var response = await db.sql(query)

	var file_rid = response.result[0]['@rid']
	var file_path = path.join(process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.json')
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path

	// if output of process is a set, then connect file to set ALSO and add attribute "set"
	if(message.output_set) {
		await this.connect(message.output_set, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute_old(file_rid, {key:"set", value: message.output_set}, 'File' ) // this attribute is used in project query
		await this.connect(process_rid, 'PRODUCED', file_rid)
	// otherwise connect file to process
	} else {
		await this.connect(process_rid, 'PRODUCED', file_rid)
	}

	return response.result[0]
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
			var response = await db.cypher(query)
			if(response.result.length > 0) {
				// update
				const update = `UPDATE ROI CONTENT ${JSON.stringify(roi)} WHERE @rid = "${roi['@rid']}"`
				var update_response = await db.sql(update)
			} 
		} else {
			const query_c = `CREATE Vertex ROI CONTENT ${JSON.stringify(roi)}`
			var response_c = await db.sql(query_c)
			await this.connect(rid, 'HAS_ROI', response_c.result[0]['@rid'])
			rids.push(response_c.result[0]['@rid'])
		}
	}


	// now we must delete all ROIs that are not in the rids array
	const query_delete = `DELETE FROM ROI WHERE @rid NOT IN [${rids.join(',')}] AND in().@rid = [${rid}]`
	var response_delete = await db.sql(query_delete)

	const query_count = `MATCH {type:File, where:(@rid=${rid})}-HAS_ROI->{type:ROI, as:roi} return count(roi) as count`
	var response_count = await db.sql(query_count)
	await this.setNodeAttribute_old(rid, {key:"roi_count", value: response_count.result[0].count}, 'File' )
	return response_count.result[0].count

}

graph.getROIs = async function(rid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	const query = `MATCH (file:File)-[r:HAS_ROI]->(roi:ROI) WHERE id(file) = "${rid}" RETURN roi`
	var response = await db.cypher(query)
	return response.result
}

graph.updateFileCount = async function (set_rid) {
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	const count_query = `MATCH {type:Set, as:set, where: ( @rid = "${set_rid}")}-HAS_ITEM->{type:File, as: file, optional:true}
	RETURN count(file) as count`
	var count_response = await db.sql(count_query)

	var count = count_response.result[0].count

	const query = `UPDATE Set SET count = ${count} WHERE @rid = "${set_rid}" `
	var response = await db.sql(query)
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
		
	const path_query = `SELECT path FROM ${process_rid}`
	const path_response = await db.sql(path_query)
	const process_path = path_response.result[0].path

	var vertex_params = {
		type: file_type,
		extension: extension,
		label: label,
		description: f_description,
		info: f_info,
		expand: false,
		_active: true
	}
	if(message.set) vertex_params.set = message.set
	
	const query = `CREATE VERTEX File CONTENT ${JSON.stringify(vertex_params)}`
	
	var response = await db.sql(query)
	var file_rid = response.result[0]['@rid']
	console.log('file_rid', file_rid)
	console.log('process_path', process_path)
	console.log('extension', extension)
	var file_path = path.join(process_path, media.rid2path(file_rid), media.rid2path(file_rid) + '.' + extension)
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path

	// if output of process is a set, then connect file to set ALSO and add attribute "set"
	if(message.output_set) {
		await this.connect(message.output_set, 'HAS_ITEM', file_rid)
		await this.setNodeAttribute_old(file_rid, {key:"set", value: message.output_set}, 'File' ) // this attribute is used in project query
		await this.connect(process_rid, 'PRODUCED', file_rid)
	// otherwise connect file to process
	} else {
		await this.connect(process_rid, 'PRODUCED', file_rid)
	}

	return response.result[0]
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
		{type:File, as:file, where:(@rid = ${clean_file_rid}), while: ($depth < 30)} return file`

	var file_response = await db.sql(query)

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
			{type:Set, as:file, where:(@rid = ${clean_file_rid}), while: ($depth < 30)} return file, project`
		var set_response = await db.sql(query_set)
		if(set_response.result[0] && set_response.result[0].file) {
			// we need to get file types of the set content
			const {extensions, types} = await getSetFileTypes(file_rid)
			//console.log('extensions', extensions)
			set_response.result[0].file.extensions = extensions
			set_response.result[0].file.types = types
			set_response.result[0].file.project_rid = set_response.result[0].project['@rid']
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
				
			var source_response = await db.sql(query_source)
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
	var response = await db.sql(sql)
	if(response.result[0] && response.result[0].source) return response.result[0].source

	return null
}


graph.query = async function (body) {
	return db.cypher(body.query)
}

graph.create = async function (type, data, admin, tid) {
	//console.log('create', type, data)
	// We clean some data
   if(type == 'Process') {
	if(data.task) {
		if(data.task.params) {
			if(data.task.params.prompts) delete data.task.params.prompts
		}
		if(data.task.system_params) {
			if(data.task.system_params.json_schema) delete data.task.system_params.json_schema
		}
	}
   }

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

	var query = `CREATE VERTEX ${type} CONTENT {${data_str_arr.join(',')}} `

	if(tid) {
		const response = await db.writeWithTransaction(query, {}, 3, 5000, tid)
		return response.result[0]
	} else {
		const response = await db.sql(query)
		return response.result[0]
	}
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
	
	const response = await db.sql(query)
	return response.result[0]
}

graph.deleteNode = async function (rid, userRID) {
	console.log('deleting node', rid, userRID)

	var node = await this.getNodeAttributes(rid, userRID)

	if(!node) throw ('Node not found')
	
	// remove node and all children (out nodes) from solr index
	const q = `TRAVERSE out() FROM ${rid}`
	var traverse = await db.sql(q)
	var targets = []
	for(var t of traverse.result) {
		targets.push({id: t['@rid']})
		// remove of path is only necessary for setProcess nodes TODO: make smarter
		if(t['path']) await media.deleteNodePath(t['path'])
		if(t['service'] == 'Solr') {
			await solr.dropSetIndex(t['@rid'])
		}
	}

	// if node itself is a solr indexer, then delete the index
	if(node['service'] == 'Solr') {
		console.log('deleting solr index', rid)
		await solr.dropSetIndex(rid)
	}

	// if this is setProcess, then delete all Process nodes that has property set_process = rid
	if(node['@type'] == 'SetProcess') {
		const query_delete_process = `DELETE FROM Process WHERE set_process = "${rid}"`
		await db.sql(query_delete_process)
	}

	// get path for directory deletion
	const query_path = `SELECT path FROM ${rid}`
	var path_result = await db.sql(query_path)


	await db.deleteMany(targets)

	const node_path = node.path
	const is_project = node['@type'] == 'Project'
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


// data = {from:[RID] ,relation: '', to: [RID]}
graph.connect = async function (from, relation, to, tid) {

	if (!from.match(/^#/)) from = '#' + from
	if (!to.match(/^#/)) to = '#' + to

	var query = `CREATE EDGE ${relation} FROM ${from} TO ${to} IF NOT EXISTS`
	//nats.writeToDB(query)
	//return {result: 'ok'}
	if(tid) {
		return await db.writeWithTransaction(query, {}, 3, 5000, tid)
	} else {
		return await db.sql(query)
	}
}

graph.startTransaction = async function () {
	return await db.startTransaction()
}

graph.commitTransaction = async function (tid) {
	return await db.commit(tid)
}

graph.unconnect = async function (from, relation, to, tid) {
	if (!from.match(/^#/)) from = '#' + from
	if (!to.match(/^#/)) to = '#' + to
	var query = `MATCH (from)-[r:${relation}]->(to) WHERE id(from) = "${from}" AND id(to) = "${to}" DELETE r RETURN from`
	return db.sql(query, {}, tid)
}


graph.deleteEdge = async function (rid, tid) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH (from)-[r]->(to) WHERE id(r) = '${rid}' DELETE r`
	return db.sql(query, {}, tid)
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
	return db.cypher(query)
}

graph.isProjectOwner = async function (rid, userRID) {
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(@rid = :userRID)}
	-IS_OWNER->
		{type:Project, as:project,  where:(@rid = :rid)} return project`

	var response = await db.sql_params(query, {rid: rid, userRID: userRID}, true)
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
		{as:node, where:(@rid = ${rid}), while: ($depth < 100)} return node`
	

	var file_response = await db.sql(query)
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

// write error count to a processing node, so that can be re-run later
graph.setNodeError = async function (rid, error, userRID) {
	//if(!await this.isNodeOwner(rid, userRID)) throw({'message': 'You are not the owner of this file'})

	// get error count from node
	let count_query = `SELECT error_count FROM ${rid}`
	let count_response = await db.sql(count_query)
	
	let error_count = count_response.result[0].error_count
	if(!error_count) error_count = 1
	else error_count++

	let query = `UPDATE ${rid} SET node_error = 'error', timestamp = :timestamp, error_count = :error_count`
	let params = {
		timestamp: new Date().toISOString(),
		code: 'unknown',
		error_count: error_count
	}
	if(error.code) params.code = error.code
	
	try {
		await db.sql(query, params)
		return error_count
	} catch (e) {
		throw({'message': 'Error setting node error'})
	}
}


graph.getSetProcessNode = async function (set, userRID) {
	if(!await this.isNodeOwner(set, userRID)) throw({'message': 'You are not the owner of this set'})
	let query = `MATCH {type: Set, where: (@rid = ${set})}.in('PRODUCED') {as: setprocess} RETURN setprocess`
	let response = await db.sql(query)
	return response.result[0]
}

graph.setNodePosition = async function (rid, position) {

	// check that position is an object with x and y properties
	if(typeof position != 'object' || (position.x === undefined || position.y === undefined)) throw({'message': 'Invalid position'})
	// check that x and y are integers between -2000 and 2000, or zero
	if(!Number.isInteger(position.x) || position.x > MAX_POSITION || position.x < -MAX_POSITION) throw({'message': `Position x must be an integer between -${MAX_POSITION} and ${MAX_POSITION}`})
	if(!Number.isInteger(position.y) || position.y > MAX_POSITION || position.y < -MAX_POSITION) throw({'message': `Position y must be an integer between -${MAX_POSITION} and ${MAX_POSITION}`})

	let query = `UPDATE ${rid} SET position = {x: ${position.x}, y: ${position.y}}`

	return db.sql(query)
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

	return db.sql_params(query, params)
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

	//return db.sql_params(query, params)
	return db.sql_params(query, params)
}


graph.setNodeAttribute_old = async function (rid, data, type, tid) {
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
	
	if(tid) {
		const response = await db.writeWithTransaction(query, {}, 3, 5000, tid)
		return response.result[0]
	} else {
		const response = await db.sql(query)
		return response.result[0]
	}

}


graph.getNodeAttributes = async function (rid, userRID) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH {
		type: User, 
		as:p, 
		where:(@rid = ${userRID})}
	-IS_OWNER->
		{type:Project, as:project}--> 
		{as:node, where:(@rid = ${rid}), while: ($depth < 30)} return node`

	var response = await db.sql(query)
	if(response.result.length == 0) return null
	return response.result[0].node
}


graph.getSearchData = async function (search) {
	if (search[0]) {
		var arr = search[0].result.map(x => '"' + x + '"')
		var query = `MATCH (n) WHERE id(n) in [${arr.join(',')}] AND NOT n:Schema_ return id(n) as id, n.label as label, labels(n) as type LIMIT 10`
		return db.cypher(query)
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
// 	var result = await db.cypher(query)
// 	// add user if not found
// 	if (result.result.length == 0) {
// 		query = `MERGE (p:User {id: "${user}"}) SET p.label = "${user}", p._group = 'user', p._active = true`
// 		result = await db.cypher(query)
// 		query = `MATCH (me:User {id:"${user}"}) return id(me) as rid, me._group as group`
// 		result = await db.cypher(query)
// 		return result.result[0]
// 	} else return result.result[0]
// }


graph.myId = async function (user) {
	if (!user) return null
	if(user.startsWith('#')) {
		var query = `SELECT @rid AS rid, group, access, service_groups, label, id, active FROM User WHERE @rid = ${user}`
		var response = await db.sql(query)
		return response.result[0]
	} else {
		var query = `SELECT @rid AS rid, group, access, service_groups, label, id, active FROM User WHERE id = "${user}"`
		var response = await db.sql(query)
		return response.result[0]
	}
}

graph.getStats = async function () {
	const query = 'MATCH (n) RETURN DISTINCT LABELS(n) as labels, COUNT(n) as count  ORDER by count DESC'
	const result = await db.cypher(query)
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
	var response = await db.sql(query)
	return response.result
}

graph.getEntityTypeSchema = async function (userRID) {
	var query = `select FROM EntityType WHERE owner = "${userRID}" ORDER by type`

	var types = await db.sql(query)
	return types.result
}

graph.getEntityTypes = async function (userRID) {
	var query = `select type, count(type) AS count, LIST(label) AS labels, icon, color,LIST(@this) AS items FROM Entity WHERE owner = "${userRID}" group by type order by count desc`
	var types = await db.sql(query)
	return types.result
}

// TODO: this requires pagination
graph.getEntityItems = async function (entities, userRID) {
	var entities_clean = cleanRIDList(entities)
	if(!entities_clean.length) return []
	//var query = `select in("HAS_ENTITY") AS items, label, @rid From Entity WHERE owner = "${userRID}" AND @rid IN [${entities_clean.join(',')}]`
	var query = `match {type:File, as:item}-HAS_ENTITY->{as:entity, where:(@rid IN [${entities_clean.join(',')}] AND owner = "${userRID}")} return  DISTINCT item.label AS label, item.info AS info, item.description AS description, item.@rid AS rid, item.path AS path, item.type AS type LIMIT 20`
	var response = await db.sql(query)

	if(!response.result.length) return []
	var items = addThumbPaths(response.result)

	return items
}

graph.getEntitiesByType = async function (type) {
	if(!type) return []
	var query = `select from Entity where type = "${type}" ORDER by label`
	return await db.sql(query)
}

graph.getEntity = async function (rid, userRID) {
	var query = `MATCH {type: Entity, as: entity, where: (id = "${rid}" AND owner = "${userRID}")} RETURN entity`
	return await db.sql(query)
}

graph.getLinkedEntities = async function (rid, userRID) {
	if (!rid.match(/^#/)) rid = '#' + rid
	var query = `MATCH {type: File, as: file, where:(@rid = ${rid} )}-HAS_ENTITY->{type: Entity, as: entity, where: (owner = "${userRID}")} RETURN entity.label AS label, entity.type AS type, entity.@rid AS rid, entity.color AS color, entity.icon AS icon`

	var response = await db.sql(query)
	return response.result
}

graph.createEntity = async function (data, userRID) {
	if(!data.type || data.type == 'undefined') return
	if(!data.label || data.label == 'undefined') return
	var schema = `SELECT color, icon FROM EntityType WHERE type = "${data.type}"`
	var response = await db.sql(schema)
	if(response.result.length) {
		if(!data.icon) data.icon = response.result[0].icon || 'mdi-tag'
		if(!data.color) data.color = response.result[0].color || '#ff8844'
	} else {
		data.icon = 'mdi-tag'
		data.color = '#ff8844'
	}
	var query = `CREATE Vertex Entity set type = "${data.type}", label = "${data.label}", icon = "${data.icon}", color = "${data.color}", owner = "${userRID}"`
	console.log(query)
	return await db.sql(query)
}

graph.checkEntity = async function (data, node_rid, userRID) {
	var query = `MATCH {type: Entity, as: entity, where: (type = "${data.type}" AND label = "${data.label}" AND owner = "${userRID}")}--{as: node, where: (@rid = ${node_rid}), optional: true} RETURN entity, node`
	return await db.sql(query)
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
	var response = await db.sql(query)
	var entity = response.result[0]
	
	var query = `SELECT shortestPath(${vid}, ${userRID}) AS path`
	response = await db.sql(query)

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
	var response = await db.sql(query)
	var entity = response.result[0]
	console.log(entity)
	var query = `SELECT shortestPath(${vid}, ${userRID}) AS path`
	response = await db.sql(query)
	console.log(response.result)
	var target = response.result[0]
	if(!entity || !target) return	
	await this.unconnect(vid, 'HAS_ENTITY',rid)
}
graph.getTags = async function (userRID) {
	var query = `MATCH {type:Tag, as:tag, where:(owner = "${userRID}")} RETURN tag order by tag.label`
	return await db.sql(query)
}

graph.createTag = async function (label, userRID) {
	if(!label) return
	var query = `create Vertex Tag set label = "${label}", owner = "${userRID}"`
	return await db.sql(query)
}

graph.getNode = async function (rid, userRID) {
	var query = `MATCH {type:User, as:user, where: (@rid = "${userRID}")}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40), where:(@rid="${rid}")} return file`
	
	var response = await db.sql(query)
	if(response.result.length == 0) return []
	return response.result[0]
}

graph.getSourceInit = async function (rid, userRID) {
	var node = await this.getNode(rid, userRID)
	// read init.json from node.path
	var init_path = node.file.path + '/init.json'
	if(await media.ifExists(init_path)) {
		var init_data = await media.readJSON(init_path)
		return init_data
	} else {
		return {}
	}
}

graph.getDataWithSchema = async function (rid, by_groups) {
	by_groups = 1

	if (!rid.match(/^#/)) rid = '#' + rid
	var data = await db.cypher(`MATCH (source) WHERE id(source) = "${rid}" OPTIONAL MATCH (source)-[rel]-(target)  return source, rel, target ORDER by target.label`)
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

graph.writeUsage = async function (usage, message) {
	const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

	const serviceName = message.service.id || 'unknown';
	const process_rid = message.process['@rid'] || 'unknown';
	const userRID = message.userId || 'unknown';
	
	// Extract values with defaults to prevent undefined/null errors
	const metadata = usage?.metadata || {};
	const tokens = metadata?.tokens || {};
	const inTokens = tokens?.in || {};
	const outTokens = tokens?.out || {};
	
	const inCount = inTokens?.count || 0;
	const outCount = outTokens?.count || 0;
	const totalCount = tokens?.total || 0;
	const inModality = inTokens?.modality || 'UNKNOWN';
	const outModality = outTokens?.modality || 'UNKNOWN';
	const model = metadata?.model || 'unknown';
	
	var query = `INSERT INTO Usage CONTENT { 
		'user': '${userRID}', 
		'process': '${process_rid}', 
		'in': ${inCount}, 
		'out': ${outCount}, 
		'model': '${model}', 
		'service': '${serviceName}', 
		'in_modality': '${inModality}', 
		'out_modality': '${outModality}', 
		'total': ${totalCount}, 
		'time': '${now}' };`
	var response = await db.sql(query)
	return response
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

// TODO: this should be saved to Set node when processing of the files in set is done (might slow things in large sets)
async function getSetFileTypes(set_rid) {
	const query = `match {type: Set, as: set, where:(@rid = "#${set_rid}")}-HAS_ITEM->{as:file} return distinct file.extension AS extension_group, file.type AS type_group`
	var response = await db.sql(query)	
	var extensions = []
	var types = []
	for(var result of response.result) {
		extensions.push(result.extension_group)
		types.push(result.type_group)
	}
	return {extensions, types}
}



export default graph