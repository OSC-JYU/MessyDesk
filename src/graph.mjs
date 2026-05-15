
import path from 'path';
import fse from 'fs-extra';



import db from "./db.mjs";
import media from "./media.mjs";
import solr from "./solr.mjs";
import filters from "./filters.mjs";
import { randomBytes } from 'crypto';

import timers from 'timers-promises';
import { DATA_DIR, DB_URL, API_URL, PROJECT_EXPIRATION_DAYS } from './env.mjs';

const MAX_STR_LENGTH = 2048;
const DEFAULT_USER = 'local.user@localhost';
const MAX_POSITION = 10000; // max x and y for project nodes
const PDF_ICON_SENTINEL = '__pdf_icon__';
const graph = {};

function uuidv7() {
	const bytes = randomBytes(16)
	const ts = Date.now()

	bytes[0] = (ts / 0x10000000000) & 0xff
	bytes[1] = (ts / 0x100000000) & 0xff
	bytes[2] = (ts / 0x1000000) & 0xff
	bytes[3] = (ts / 0x10000) & 0xff
	bytes[4] = (ts / 0x100) & 0xff
	bytes[5] = ts & 0xff

	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80

	const hex = bytes.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// allowed attributes that setNodeAttribute can set
const NODE_ATTRIBUTES = ['description', 'label', 'info', 'expand', 'metadata', 'response', 'node_error', 'path', 'edited']

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

	// Ensure edge types exist also for already-initialized databases
	await db.createEdgeType('HAS_PROCESS')
	await db.createEdgeType('DERIVED_FROM')
	await db.createEdgeType('HAS_OWNER')
}

graph.hasAccess = async function (item_rid, user_rid) {
	if (!item_rid.match(/^#/)) item_rid = '#' + item_rid
	const query = `TRAVERSE out() FROM ${item_rid}`
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
	const query = `MATCH (pr:Project)-[:HAS_OWNER]->(p:User) WHERE id(p) = "${me_rid}" AND pr.label = "${data.label}" RETURN count(pr) as projects`
	var response = await db.cypher(query)
	console.log(response.result[0])
	if (response.result[0].projects == 0) {
		const expirationDate = new Date()
		expirationDate.setDate(expirationDate.getDate() + PROJECT_EXPIRATION_DAYS)
		data.expiration_date = expirationDate.toISOString().slice(0, 10)
		project = await this.create('Project', data)
		var project_rid = project['@rid']
		await this.connect(project_rid, 'HAS_OWNER', me_rid)
	} else {
		console.log('Project exists')
		throw ('Project with that name exists!')
	}
	return project

}

graph.deleteProject = async function (project_rid, user_rid, nats) {
	const query = `MATCH {as:project, where:(@rid = ${project_rid})}-HAS_OWNER->{type:User, as:user, where:(@rid = ${user_rid})} return project.@rid AS rid`
	var response = await db.sql(query)
	if(response.result.length == 1) {
		await this.deleteNode(response.result[0]['rid'], nats)
	}
	return response.result[0]['rid']
}

graph.createSet = async function (project_rid, data, me_rid) {

	//const query = `MATCH (p:User)-[:IS_OWNER]->(pr:Project) WHERE id(p) = "${me_rid}" AND id(pr) = "${project_rid}" RETURN pr`
	const query = `MATCH {type:Project, as:pr, where:(@rid = ${project_rid})}-HAS_OWNER->{type:User, as:p, where:(@rid = ${me_rid})} RETURN pr`

	var response = await db.sql(query)

	if (response.result.length == 1) {
		data.project_rid = project_rid
		var set = await this.create('Set', data)
		var set_rid = set['@rid']
		await this.connect(set_rid, 'BELONGS_TO', project_rid)
		const set_path = media.getSetDir(DATA_DIR, project_rid, set.uuid || set_rid)
		const set_filepath = path.join(set_path, 'set.json')
		await media.createProcessDir(set_path)
		await this.setNodeAttribute_old(set_rid, {key: 'path', value: set_path}, 'Set')
		await this.setNodeAttribute_old(set_rid, {key: 'filepath', value: set_filepath}, 'Set')
		set.path = set_path
		set.filepath = set_filepath
		await this.syncSetManifest(set_rid)
		return set
	} else {
		console.log('Project not found')
		throw ('Set creation failed! Project not found!')
	}
}

graph.createSource = async function (project_rid, data, me_rid, nats) {

	const query = `MATCH (pr:Project)-[:HAS_OWNER]->(p:User) WHERE id(p) = "${me_rid}" AND id(pr) = "${project_rid}" RETURN pr`

	var response = await db.cypher(query)
	if (response.result.length == 1) {
		data.status = 'initing...'
		data.project_rid = project_rid
		var source = await this.create('Source', data)
		var source_rid = source['@rid']
		const source_path = media.getSourceDir(DATA_DIR, project_rid, source.uuid || source_rid)
		source.path = source_path
		await this.connect(source_rid, 'BELONGS_TO', project_rid)
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
	? `MATCH {type:User, as:user, where: (id = "${userRid}")}<-HAS_OWNER-{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`
	: `MATCH {type:Project, as:project}-HAS_OWNER->{type:User, as:user}, {type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`;
	//const query = `MATCH {type:User, as:user}-IS_OWNER->{type:Project, as:project}-->{as:file, while: ($depth < 40)} return item, user.@rid AS ownerRid`

}


graph.index = async function (userRid) {
    // Construct the query to index user's data or all data
	const filesQuery = userRid
		? `MATCH {type:User, as:user, where: (@rid = "${userRid}")}<-HAS_OWNER-{type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`
		: `MATCH {type:Project, as:project}-HAS_OWNER->{type:User, as:user}, {type:Project, as:project}-->{as:file, while: ($depth < 40)} return file, user.@rid AS ownerRid`;

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
	const query = `SELECT count() AS users FROM User WHERE id = "${data.id}"`
	var response = await db.sql(query)
	if (response.result[0].users > 0) throw ('User with that email already exists!')
		
	//data['service_groups'] = []
	var user = await this.create('User', data, true)
	console.log('User created: ', user)
	await this.initUserData(user)


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
		const prompt_uuid = uuidv7()
		var query = `CREATE VERTEX Prompt SET uuid = "${prompt_uuid}", name = "${prompt.name}", content = "${prompt.content}", description = "${prompt.description}", json_schema = "${prompt.json_schema}", output_type = "${prompt.output_type}", type = "${prompt.type}", owner = "${userRID}"`
		
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
	const query = `MATCH {as:project, type:Project, where: (@rid = ${rid})}-HAS_OWNER->{as: person, type: User, where: (id = "${me_email}")} RETURN project`
	var result = await db.sql(query)
	return result
}


graph.getProject_old = async function (rid, me_email) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `MATCH {as:project, type:Project, where: (@rid = ${rid})}-HAS_OWNER->{as: person, type: User, where: (id = "${me_email}")}, {as:project, type:Project, where: (@rid = ${rid})}-->{as:file, 
				where:((@type = 'Set' OR @type = 'SetProcess' OR @type = 'Process') OR ( @type = 'File'  AND (set is NULL OR expand = true) )), while: (true)}
				RETURN file`
	
	var result = await db.sql(query)

	return result
}


graph.getProject = async function (rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project,where:(@rid=${rid})}.in() 
		{as:node, where:((@type="Set" OR @type="File" OR @type="SetProcess" OR @type="Source") AND set IS NULL  AND $depth > 0), while:($depth < 20)} return node, node.outE() as edges`


	const options = {
		serializer: 'studio',
		format: 'vueflow'
	}
	
	var result = await db.sql(query, options)

	result = await getSetThumbnails(user_rid, result, rid)
	return result
}

graph.isSearchOutputTask = function(service, task) {
	const taskId = task?.id
	const taskDef = taskId ? service?.tasks?.[taskId] : null
	const output = String(task?.output || taskDef?.output || '').toLowerCase()
	const searchOutput = task?.search_output ?? taskDef?.search_output
	if(searchOutput === true) return true
	if(['search', 'search-set', 'search_set', 'search-output', 'search_output'].includes(output)) return true

	const serviceType = String(service?.type || '').toLowerCase()
	const serviceId = String(service?.id || '').toLowerCase()
	if(output === 'many-to-one' && (serviceType === 'solr' || serviceType === 'faiss' || serviceId.includes('solr') || serviceId.includes('faiss'))) {
		return true
	}

	return false
}


graph.getProject_ = async function (rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid

	const query = `match {type:User, as:user, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project,where:(@rid=${rid})}.out() 
		{as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source" OR @type="Filter") AND (set is NULL OR expand = true) AND $depth > 0), while:($depth < 20)} return node`


	const options = {
		serializer: 'studio',
		format: 'vueflow'
	}
	
	var result = await db.sql(query, options)
	result = await getSetThumbnails(user_rid, result, rid)
	return result
}



graph.getProjects = async function (user_rid, data_dir) {
	const query = `MATCH (pr:Project)-[r:HAS_OWNER]->(p:User) WHERE id(p) = "${user_rid}" RETURN pr`
	var response = await db.cypher(query)
	var data = []

	for (const item of response.result || []) {
		const nestedProject = item?.pr && typeof item.pr === 'object' && !Array.isArray(item.pr)
			? item.pr
			: null
		const fallbackProject = nestedProject ? {} : (item || {})
		const pr = nestedProject || fallbackProject

		const projectRidValue = pr['@rid']
		const projectRid = Array.isArray(projectRidValue)
			? (projectRidValue[0] || null)
			: projectRidValue
		let node_count = 0
		let file_count = 0

		if (projectRid) {
			const countQuery = `match {type:User, as:user, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project,where:(@rid=${projectRid})}.in()
				{as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source" OR @type="Filter") AND $depth > 0), while:($depth < 40)}
				return DISTINCT node.@rid as rid, node.@type as type`
			const countResponse = await db.sql(countQuery)
			const rows = countResponse.result || []
			node_count = rows.length
			file_count = rows.filter((row) => row.type === 'File').length
		}

		const label = Array.isArray(pr.label) ? (pr.label[0] || '') : pr.label
		const name = Array.isArray(pr.name) ? (pr.name[0] || '') : pr.name

		data.push({
			...pr,
			'@rid': projectRid,
			label,
			name,
			node_count,
			file_count,
		})
	}
	// sort data
	data.sort((a, b) => {
		const nameA = String(a?.label || a?.name || '').toUpperCase(); // ignore upper and lowercase
		const nameB = String(b?.label || b?.name || '').toUpperCase(); // ignore upper and lowercase
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
	const query = `select @rid AS rid, path, type, metadata from File where set =  ${set_rid} ORDER by label LIMIT 20`
	var response = await db.sql(query)
	const thumbs = []
	for (const item of response.result || []) {
		if(item?.type === 'pdf' && !(await shouldUsePdfThumbnail(item))) {
			if(thumbs.length < 4) thumbs.push(PDF_ICON_SENTINEL)
			continue
		}
		if(!item?.path) continue
		if(thumbs.length >= 4) break
		const dirPath = item.path.split('/').slice(0, -1).join('/')
		thumbs.push(dirPath.replace('data/', 'api/thumbnails/data/'))
	}

	return thumbs

}

async function getProjectThumbnails(user_rid, data, data_dir) {

	const query = `MATCH (pr:Project)-[r:HAS_OWNER]->(p:User), (pr)-[:HAS_FILE]->(f:File) WHERE id(p) = "${user_rid}" 
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
	if(!data?.nodes || data.nodes.length === 0) return data

	const setNodes = data.nodes.filter((node) => node?.data?.type === 'Set' && node?.data?.id)
	if(setNodes.length === 0) return data

	const setIds = setNodes.map((node) => String(node.data.id))
	const quotedSetIds = setIds.map((rid) => `"${rid.replace(/"/g, '\\"')}"`).join(',')
	const query = `SELECT @rid AS rid, set, path, label, type, info, metadata FROM File WHERE set IN [${quotedSetIds}] ORDER BY label`
	const response = await db.sql(query)

	const thumbsBySet = new Map()
	const typesBySet = new Map()
	const textSamplesBySet = new Map()
	for (const item of response.result || []) {
		if(!item?.set || !item?.path) continue
		const normalizedType = String(item?.type || '').toLowerCase()
		if(!typesBySet.has(item.set)) typesBySet.set(item.set, new Set())
		if(normalizedType) {
			typesBySet.get(item.set).add(normalizedType)
		}

		if(normalizedType === 'text') {
			if(!textSamplesBySet.has(item.set)) textSamplesBySet.set(item.set, [])
			const sampleList = textSamplesBySet.get(item.set)
			if(sampleList.length < 2) {
				const rawInfo = String(item?.info || '').trim()
				if(rawInfo) {
					sampleList.push({
						label: item?.label || '',
						text: rawInfo.length > 280 ? `${rawInfo.slice(0, 280)}...` : rawInfo,
					})
				}
			}
		}

		if(normalizedType !== 'image' && normalizedType !== 'pdf') {
			continue
		}
		if(!thumbsBySet.has(item.set)) thumbsBySet.set(item.set, [])
		const list = thumbsBySet.get(item.set)
		if(list.length >= 2) continue
		if(item?.type === 'pdf' && !(await shouldUsePdfThumbnail(item))) {
			list.push(PDF_ICON_SENTINEL)
			continue
		}
		const dirPath = item.path.split('/').slice(0, -1).join('/')
		list.push(API_URL + 'api/thumbnails/' + dirPath + '/thumbnail.jpg')
	}

	for (const setNode of setNodes) {
		setNode.data.paths = thumbsBySet.get(setNode.data.id) || []
		setNode.data.text_samples = textSamplesBySet.get(setNode.data.id) || []
		const setTypes = Array.from(typesBySet.get(setNode.data.id) || [])
		setNode.data.types = setTypes
	}

	return data
}

async function getSetThumbnails_old(user_rid, data, project_rid) {

	// order image by file label so that result set would show same images as source set
	const query = `MATCH (pr:Project)-[r:HAS_OWNER]->(p:User), (pr)-[*0..10]->(set:Set)-->(file:File) 
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
	const query = `MATCH (pr:Project)-[:HAS_OWNER]->(p:User), (pr)-[:HAS_FILE]->(file:File) WHERE id(pr) = "${rid}" AND id(p) = "${user_rid}" RETURN file`
	
	var result = await db.cypher(query)
	return result
}

graph.getSetFiles = async function (set_rid, user_rid, params) {
	params = params || {}
	if(!isIntegerString(params.skip) && !Number.isInteger(params.skip)) params.skip = 0
	if(!isIntegerString(params.limit) && !Number.isInteger(params.limit)) params.limit = 10
	params.skip = Number(params.skip)
	params.limit = Number(params.limit)
	const groupByOrigin = false
	
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid


	const has_access = await this.hasAccess(set_rid, user_rid)
	if(!has_access) {
		throw new Error('Set not found')
	}

	if(groupByOrigin) {
		const fileQuery = `MATCH {type:File, as:node, where:(set = "${set_rid}")} RETURN DISTINCT node ORDER by node.label`
		let fileResponse = await db.sql(fileQuery)
		if(!fileResponse.result.length) {
			const fallback = `MATCH {type:Set, as:set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:node, where:(@type = 'File')} RETURN DISTINCT node ORDER by node.label`
			fileResponse = await db.sql(fallback)
		}

		const files = (fileResponse.result || []).map((row) => row.node).filter(Boolean)
		const fileRidSet = new Set(files.map((file) => file['@rid']))
		const fileByRid = new Map(files.map((file) => [file['@rid'], file]))

		const edgeQuery = `MATCH {type:File, as:target, where:(set = "${set_rid}")}-DERIVED_FROM->{type:File, as:source} RETURN target.@rid AS target_rid, source.@rid AS source_rid, source.label AS source_label, source.type AS source_type, source.path AS source_path, source.original_filename AS source_original_filename`
		let edgeResponse = await db.sql(edgeQuery)
		if(!edgeResponse.result.length) {
			const edgeFallback = `MATCH {type:Set, as:set, where:(@rid = ${set_rid})}-HAS_ITEM->{type:File, as:target}-DERIVED_FROM->{type:File, as:source} RETURN target.@rid AS target_rid, source.@rid AS source_rid, source.label AS source_label, source.type AS source_type, source.path AS source_path, source.original_filename AS source_original_filename`
			edgeResponse = await db.sql(edgeFallback)
		}

		const parentByTarget = new Map()
		const sourceMetaByRid = new Map()
		for(const row of edgeResponse.result || []) {
			if(!row.target_rid || !row.source_rid) continue
			if(!parentByTarget.has(row.target_rid)) {
				parentByTarget.set(row.target_rid, row.source_rid)
			}
			if(!sourceMetaByRid.has(row.source_rid)) {
				sourceMetaByRid.set(row.source_rid, {
					'@rid': row.source_rid,
					label: row.source_label,
					type: row.source_type,
					path: row.source_path,
					original_filename: row.source_original_filename,
				})
			}
		}

		const ensureSourceMetadata = async (sourceRids) => {
			if(!sourceRids.length) return
			const cleaned = sourceRids.map((rid) => this.sanitizeRID(rid))
			const query = `SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN [${cleaned.join(',')}]`
			const response = await db.sql(query)
			for(const row of response.result || []) {
				sourceMetaByRid.set(row.rid, {
					'@rid': row.rid,
					label: row.label,
					type: row.type,
					path: row.path,
					original_filename: row.original_filename,
				})
			}
		}

		const traverseAncestorsBatched = async (seedRids, maxDepth = 40) => {
			let frontier = Array.from(new Set(seedRids.map((rid) => this.sanitizeRID(rid))))
			const visited = new Set()
			let depth = 0

			while(frontier.length > 0 && depth < maxDepth) {
				const currentBatch = frontier.filter((rid) => !visited.has(rid))
				if(!currentBatch.length) break
				frontier = []

				for(const rid of currentBatch) {
					visited.add(rid)
				}

				const linkQuery = `SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [${currentBatch.join(',')}]`
				const linkResponse = await db.sql(linkQuery)

				const sourceRidsToLoad = []
				for(const row of linkResponse.result || []) {
					if(!row.target_rid || !row.source_rid) continue
					if(!parentByTarget.has(row.target_rid)) {
						parentByTarget.set(row.target_rid, row.source_rid)
					}
					if(!sourceMetaByRid.has(row.source_rid)) {
						sourceMetaByRid.set(row.source_rid, {'@rid': row.source_rid})
						sourceRidsToLoad.push(row.source_rid)
					}
					if(!visited.has(row.source_rid)) {
						frontier.push(row.source_rid)
					}
				}

				await ensureSourceMetadata(Array.from(new Set(sourceRidsToLoad)))
				depth++
			}
		}

		await traverseAncestorsBatched(files.map((file) => file['@rid']))

		const resolveOriginRid = (fileRid) => {
			let cursor = fileRid
			let parent = parentByTarget.get(cursor)
			if(!parent) return fileRid

			let guard = 0
			while(parent && fileRidSet.has(parent) && guard < 20) {
				cursor = parent
				parent = parentByTarget.get(cursor)
				guard++
			}

			return parent || cursor
		}

		const guessOrder = (file) => {
			const md = file?.metadata || {}
			const candidates = [md.page, md.page_number, md.pageIndex, md.index]
			for(const c of candidates) {
				const n = Number(c)
				if(Number.isFinite(n)) return n
			}
			const label = String(file?.label || '')
			const m = label.match(/(\d+)(?!.*\d)/)
			if(m) {
				const n = Number(m[1])
				if(Number.isFinite(n)) return n
			}
			return Number.MAX_SAFE_INTEGER
		}

		const groupsMap = new Map()
		for(const file of files) {
			const originRid = resolveOriginRid(file['@rid'])
			if(!groupsMap.has(originRid)) {
				const sourceMeta = sourceMetaByRid.get(originRid) || fileByRid.get(originRid) || {}
				groupsMap.set(originRid, {
					is_group: true,
					source_rid: originRid,
					'@rid': originRid,
					label: sourceMeta.label || sourceMeta.original_filename || file.label,
					type: sourceMeta.type || file.type,
					path: sourceMeta.path || null,
					file_count: 0,
					children: [],
				})
			}
			const group = groupsMap.get(originRid)
			group.children.push(file)
			group.file_count = group.children.length
		}

		for(const group of groupsMap.values()) {
			group.children.sort((a, b) => {
				const aOrder = guessOrder(a)
				const bOrder = guessOrder(b)
				if(aOrder !== bOrder) return aOrder - bOrder
				return String(a.label || '').localeCompare(String(b.label || ''))
			})

			const cover = group.children.find((child) => child.path)
			if(cover?.path) {
				group.thumb = API_URL + 'api/thumbnails/' + cover.path.split('/').slice(0, -1).join('/')
			}
		}

		const groups = Array.from(groupsMap.values()).sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')))

		const decorateFiles = async (list) => {
			if(!params.thumbnails) return
			for (const file of list) {
				if(file.path && (file.type !== 'pdf' || await shouldUsePdfThumbnail(file))) {
					file.thumb = API_URL + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/')
				}
				const entity_query = `MATCH (file:File)-[r:HAS_ENTITY]->(entity:Entity) WHERE id(file) = "${file['@rid']}" RETURN entity.label AS label, entity.icon AS icon, entity.color AS color, id(entity) AS rid`
				const entity_response = await db.cypher(entity_query)
				file.entities = entity_response.result
			}
		}

		const allSingleFileGroups = groups.length === files.length && groups.every((group) => group.file_count === 1)
		if(!params.source_rid && allSingleFileGroups) {
			const pagedFiles = files.slice(params.skip, params.skip + params.limit)
			await decorateFiles(pagedFiles)
			return {
				grouped: false,
				mode: 'flat',
				file_count: files.length,
				limit: params.limit,
				skip: params.skip,
				groups: [],
				files: pagedFiles,
			}
		}

		if(params.source_rid) {
			const sourceRid = this.sanitizeRID(params.source_rid)
			const selectedGroup = groupsMap.get(sourceRid)
			const children = selectedGroup ? selectedGroup.children : []
			const pagedChildren = children.slice(params.skip, params.skip + params.limit)
			await decorateFiles(pagedChildren)

			return {
				grouped: true,
				mode: 'children',
				source_rid: sourceRid,
				file_count: children.length,
				group_count: groups.length,
				limit: params.limit,
				skip: params.skip,
				groups: [],
				files: pagedChildren,
			}
		}

		const pagedGroups = groups.slice(params.skip, params.skip + params.limit)
		return {
			grouped: true,
			mode: 'groups',
			file_count: files.length,
			group_count: groups.length,
			limit: params.limit,
			skip: params.skip,
			groups: pagedGroups,
			files: [],
		}
	}

	const count_query = `MATCH {type:File, as:node, where:(set = "${set_rid}")} RETURN count(node) AS file_count`
	var response_count = await db.sql(count_query)
	if(!response_count.result.length) {
		const count_query_fallback = `MATCH {type:Set, as:set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:node, where:(@type = 'File')} RETURN count(DISTINCT node) AS file_count`
		response_count = await db.sql(count_query_fallback)
	}

	const query = `MATCH {type:File, as:node, where:(set = "${set_rid}")} RETURN DISTINCT node ORDER by node.label SKIP ${params.skip} LIMIT ${params.limit}`
	console.log('QUERY_FILES: ', query)
	var response = await db.sql(query)
	if(!response.result.length) {
		const query_fallback = `MATCH {type:Set, as:set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:node, where:(@type = 'File')}-->{type:Project, as:project}-HAS_OWNER->{type:User, as:user, where:(@rid = ${user_rid})} RETURN DISTINCT node ORDER by node.label SKIP ${params.skip} LIMIT ${params.limit}`
		response = await db.sql(query_fallback)
	}
	

	var files = response.result.map(obj => obj.node);
	
	
	// thumbnails and entities
	if(params.thumbnails) {
		for (var file of files) {
			if(file.path && (file.type !== 'pdf' || await shouldUsePdfThumbnail(file))) {
				file.thumb = API_URL + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/');
			}
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
	
		const query = `MATCH {type:Source, as: source, where:(@rid = ${source_rid})}<-HAS_SOURCE-{type:Project, as:project}-HAS_OWNER->{type:User, as:user, where:(@rid = "${user_rid}")} RETURN source.path AS path`
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
		// copy description and info from service task definition
		if(service.tasks[task.id].description && !msg.task.description)
			msg.task.description = service.tasks[task.id].description
		if(service.tasks[task.id].info && !msg.task.info)
			msg.task.info = service.tasks[task.id].info
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

	messages.push(msg)
	
console.log('Created messages: ', messages)
	return messages
}


graph.createFilter = async function(filter_id, file_rid, user_rid, params = {}) {
	const filter = filters.getFilter(filter_id)
	var node = await this.getNodeAttributes(file_rid, user_rid)
	console.log('NODE: ', node)
	if(!filter || !node) {
		throw new Error('Filter or file not found: '+ filter_id + ' ' + file_rid )
	}

	if(filter_id === 'mdf-set-filter') {
		return await this.createTagFilterSet(file_rid, user_rid, params)
	}
	//const filter_node = await this.create('Filter', {filter_id: filter_id, label: 'Draw regions'})

	const project_rid = await this.getProjectRidForNode(file_rid)
	const filter_node = await this.create('Process', {filter_id: filter_id, label: 'Draw regions'})
	filter_node.path = media.getProcessFilesDir(DATA_DIR, project_rid, filter_node.uuid)
	// link filter to project
	await this.connect(project_rid, 'BELONGS_TO', filter_node['@rid'])

	// we create Set and link it to source file or source Set
	var set_node = await this.create('Set', {label: 'My regions', 'type': 'roi-set'})
	await this.connectDerivedFrom(set_node['@rid'], file_rid, filter_node['@rid'])

	return filter_node
}

graph.createTagFilterSet = async function(node_rid, user_rid, params = {}) {
	const node = await this.getNodeAttributes(node_rid, user_rid)
	if(!node) {
		throw new Error('Node not found: ' + node_rid)
	}

	const sourceSetRid = node['@type'] === 'Set'
		? this.sanitizeRID(node['@rid'])
		: (node.set ? this.sanitizeRID(node.set) : null)
	if(!sourceSetRid) {
		throw new Error('Tag filter requires a Set node as input')
	}

	const selectionModeRaw = String(params?.selection_mode || params?.mode || 'include').toLowerCase()
	const selectionMode = ['include', 'exclude', 'untagged'].includes(selectionModeRaw)
		? selectionModeRaw
		: 'include'

	const selectedEntityRids = Array.from(new Set((Array.isArray(params?.selected_entity_rids) ? params.selected_entity_rids : [])
		.map((rid) => {
			try {
				return this.sanitizeRID(String(rid))
			} catch {
				return null
			}
		})
		.filter(Boolean)))

	if((selectionMode === 'include' || selectionMode === 'exclude') && !selectedEntityRids.length) {
		throw new Error('No tags selected')
	}

	const matchMode = String(params?.match || 'or').toLowerCase() === 'and' ? 'and' : 'or'
	const project_rid = node.project_rid || await this.getProjectRidForNode(sourceSetRid)

	const getSetFileRids = async () => {
		let response = await db.sql(`SELECT @rid AS rid FROM File WHERE set = "${sourceSetRid}"`)
		if(!response.result.length) {
			response = await db.sql(`MATCH {type:Set, as:set, where:(@rid = ${sourceSetRid})}-HAS_ITEM->{type:File, as:file} RETURN DISTINCT file.@rid AS rid`)
		}
		return (response.result || []).map((row) => row.rid).filter(Boolean)
	}

	const allFileRids = await getSetFileRids()
	if(!allFileRids.length) {
		throw new Error('Input set has no files')
	}

	let selectedLabels = []
	if(selectionMode !== 'untagged') {
		const entityQuery = `SELECT @rid AS rid, label FROM Entity WHERE owner = "${user_rid}" AND @rid IN [${selectedEntityRids.join(',')}]`
		const entityResponse = await db.sql(entityQuery)
		const entityRows = entityResponse.result || []
		if(entityRows.length !== selectedEntityRids.length) {
			throw new Error('One or more selected tags are invalid or inaccessible')
		}
		const entityLabelMap = new Map(entityRows.map((row) => [row.rid, row.label]))
		selectedLabels = selectedEntityRids.map((rid) => entityLabelMap.get(rid)).filter(Boolean)
	}
	const processLabel = 'Tag filter'
	let processInfo = ''
	if(selectionMode === 'include') {
		processInfo = `Tag filter include (${matchMode.toUpperCase()}): ${selectedLabels.join(', ')}`
	} else if(selectionMode === 'exclude') {
		processInfo = `Tag filter exclude: ${selectedLabels.join(', ')}`
	} else {
		processInfo = 'Tag filter untagged files'
	}
	const filterNode = await this.create('SetProcess', {
		filter_id: 'mdf-set-filter',
		label: processLabel,
		project_rid: project_rid || null,
		input_set: sourceSetRid,
		info: processInfo,
		params: JSON.stringify({
			selection_mode: selectionMode,
			selected_entity_rids: selectedEntityRids,
			match: matchMode,
		})
	})
	const process_rid = filterNode['@rid']

	const processPath = media.getProcessFilesDir(DATA_DIR, project_rid, filterNode.uuid || process_rid)
	await media.createProcessDir(processPath)
	await this.setNodeAttribute_old(process_rid, { key: 'path', value: processPath }, 'SetProcess')
	filterNode.path = processPath
	if(project_rid) {
		await this.connect(process_rid, 'BELONGS_TO', project_rid)
	}

	let matchedFileRids = []
	if(selectionMode === 'untagged') {
		let taggedResponse = await db.sql(`MATCH {type:File, as:file, where:(set = "${sourceSetRid}")}-HAS_ENTITY->{type:Entity, as:entity, where:(owner = "${user_rid}")}
			RETURN DISTINCT file.@rid AS file_rid`)
		if(!taggedResponse.result.length) {
			taggedResponse = await db.sql(`MATCH {type:Set, as:set, where:(@rid = ${sourceSetRid})}-HAS_ITEM->{type:File, as:file}-HAS_ENTITY->{type:Entity, as:entity, where:(owner = "${user_rid}")}
				RETURN DISTINCT file.@rid AS file_rid`)
		}
		const taggedFileSet = new Set((taggedResponse.result || []).map((row) => row.file_rid).filter(Boolean))
		matchedFileRids = allFileRids.filter((rid) => !taggedFileSet.has(rid))
	} else {
		const sourceMembershipQuery = `MATCH {type:File, as:file, where:(set = "${sourceSetRid}")}-HAS_ENTITY->{type:Entity, as:entity, where:(@rid IN [${selectedEntityRids.join(',')}])} RETURN file.@rid AS file_rid, entity.@rid AS entity_rid`
		let membershipResponse = await db.sql(sourceMembershipQuery)
		if(!membershipResponse.result.length) {
			const fallbackMembershipQuery = `MATCH {type:Set, as:set, where:(@rid = ${sourceSetRid})}-HAS_ITEM->{type:File, as:file}-HAS_ENTITY->{type:Entity, as:entity, where:(@rid IN [${selectedEntityRids.join(',')}])} RETURN file.@rid AS file_rid, entity.@rid AS entity_rid`
			membershipResponse = await db.sql(fallbackMembershipQuery)
		}
		const membershipRows = membershipResponse.result || []

		const fileEntities = new Map()
		for(const row of membershipRows) {
			if(!row.file_rid || !row.entity_rid) continue
			if(!fileEntities.has(row.file_rid)) fileEntities.set(row.file_rid, new Set())
			fileEntities.get(row.file_rid).add(row.entity_rid)
		}

		if(selectionMode === 'exclude') {
			const excluded = new Set(fileEntities.keys())
			matchedFileRids = allFileRids.filter((rid) => !excluded.has(rid))
		} else {
			for(const [fileRid, entities] of fileEntities.entries()) {
				if(matchMode === 'and') {
					if(entities.size === selectedEntityRids.length) matchedFileRids.push(fileRid)
				} else {
					if(entities.size > 0) matchedFileRids.push(fileRid)
				}
			}
		}
	}

	const requestedSetLabel = typeof params?.set_label === 'string' ? params.set_label.trim() : ''
	let outputLabel = requestedSetLabel
	if(!outputLabel) {
		if(selectionMode === 'include') {
			outputLabel = `Tags (${matchMode.toUpperCase()}): ${selectedLabels.join(', ')}`
		} else if(selectionMode === 'exclude') {
			outputLabel = `Without tags: ${selectedLabels.join(', ')}`
		} else {
			outputLabel = 'Untagged files'
		}
	}
	const outputSet = await this.create('Set', {
		label: outputLabel,
		project_rid: project_rid || null,
	})
	const outputSetRid = outputSet['@rid']
	const outputSetPath = media.getSetDir(DATA_DIR, project_rid, outputSet.uuid || outputSetRid)
	await media.createProcessDir(outputSetPath)
	await this.setNodeAttribute_old(outputSetRid, { key: 'path', value: outputSetPath }, 'Set')
	outputSet.path = outputSetPath
	await this.connectDerivedFrom(outputSetRid, sourceSetRid, process_rid)

	if(matchedFileRids.length > 0) {
		const cleanMatched = Array.from(new Set(matchedFileRids.map((rid) => this.sanitizeRID(rid))))
		const sourceFilesQuery = `SELECT @rid, project_rid, type, extension, label, info FROM File WHERE @rid IN [${cleanMatched.join(',')}] ORDER by label`
		const sourceFilesResponse = await db.sql(sourceFilesQuery)

		for(const sourceFile of sourceFilesResponse.result || []) {
			const message = {
				file: {
					'@rid': sourceFile['@rid'],
					project_rid: sourceFile.project_rid || project_rid,
					type: sourceFile.type,
					extension: sourceFile.extension,
					label: sourceFile.label,
				},
				output_set: outputSetRid,
			}
			await this.createReferenceFileNode(process_rid, message, sourceFile['@rid'], '', sourceFile.info || '')
		}
	}

	await this.updateFileCount(outputSetRid)

	return {
		process: filterNode,
		output_set: outputSet,
		selection_mode: selectionMode,
		matched_files: matchedFileRids.length,
		match: matchMode,
		selected_entity_rids: selectedEntityRids,
	}
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
	else if(msg.task.description) process_attrs.info = msg.task.description

	if(msg.task.description) process_attrs.description = msg.task.description
	if(msg.task.model) process_attrs.model = msg.task.model.id
	if(msg.task.model?.version) process_attrs.model_version = msg.task.model.version
	//if(msg.task.params.prompts?.content) process_attrs.task.params.prompts = msg.task.params.prompts.content.slice(0, 100) + '...'

	// mark if this is part of set processing = not displayed in UI by default
	if(msg.output_set) process_attrs.set = msg.output_set
	if(msg.set_process_rid) process_attrs.set_process = msg.set_process_rid
	if(msg.set_process && !process_attrs.set_process) process_attrs.set_process = msg.set_process
	const process_project_rid = msg.file.project_rid || await this.getProjectRidForNode(file_rid)
	if(process_project_rid) process_attrs.project_rid = process_project_rid

	processNode = await this.create('Process', process_attrs)
	process_rid = processNode['@rid']
	processNode.path = media.getProcessFilesDir(DATA_DIR, process_project_rid, processNode.uuid || process_rid)
	if(process_project_rid) processNode.project_rid = process_project_rid
	processNode.file_rid = file_rid
	// update process path to record
	await this.setNodeAttribute_old(process_rid, {"key": "path", "value": processNode.path}, 'Process')
	if(process_project_rid) {
		await this.connect(process_rid, 'BELONGS_TO', process_project_rid)
	}

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
	if(filegraph.project_rid) process_attrs.project_rid = filegraph.project_rid
	if(task.info) {
		process_attrs.info = task.info
	}

	processNode = await this.create('SetProcess', process_attrs)
	process_rid = processNode['@rid']
	const set_project_rid = filegraph.project_rid || await this.getProjectRidForNode(file_rid)
	if(set_project_rid) {
		await this.connect(process_rid, 'BELONGS_TO', set_project_rid)
	}

	// create process output Set
	if(service.external_tasks || service.tasks[task.id].output != 'always file') {
		setNode = await this.create('Set', {})
		if(set_project_rid) {
			await this.setNodeAttribute_old(setNode['@rid'], {key: 'project_rid', value: set_project_rid}, 'Set')
		}
		const set_path = media.getSetDir(DATA_DIR, set_project_rid, setNode.uuid || setNode['@rid'])
		await media.createProcessDir(set_path)
		await this.setNodeAttribute_old(setNode['@rid'], {key: 'path', value: set_path}, 'Set')
		setNode.path = set_path
		await this.connectDerivedFrom(setNode['@rid'], file_rid, process_rid)
		await this.syncSetManifest(setNode['@rid'])
	}

	return {process: processNode, set: setNode} //processNode

}


graph.createManyToOneProcessNode = async function (topic, service, data, setgraph ) {

	const set_rid = setgraph['@rid']
	const processLabel = String(topic || data?.name || data?.id || service?.name || 'Process').trim() || 'Process'

	const process_attrs = { label: processLabel, path:'' }
	process_attrs.service = service.name
	if(setgraph.project_rid) process_attrs.project_rid = setgraph.project_rid
	if(data.info) {
		process_attrs.info = data.info
	} else if(data.description) {
		process_attrs.info = data.description
	}
	const processNode = await this.create('SetProcess', process_attrs)
	const process_rid = processNode['@rid']

	const process_path = media.getProcessFilesDir(DATA_DIR, setgraph.project_rid, processNode.uuid || process_rid)
	await media.createProcessDir(process_path)
	const update = `MATCH (p:SetProcess) WHERE id(p) = "${process_rid}" SET p.path = "${process_path}" RETURN p`
	var update_response = await db.cypher(update)
	processNode.path = process_path

	if(setgraph.project_rid) {
		await this.connect(process_rid, 'BELONGS_TO',  setgraph.project_rid)
	}

	return processNode
	
}


graph.createOutputSetNode = async function (label, processNode) {

	//const params_str = JSON.stringify(params).replace(/"/g, '\\"')
	//params.topic = topic
	const process_rid = processNode['@rid']
	
	// create process node
	const set_attrs = { label: label }
	const set_project_rid = processNode.project_rid || await this.getProjectRidForNode(process_rid)
	if(set_project_rid) set_attrs.project_rid = set_project_rid


	const setNode = await this.create('Set', set_attrs)
	const set_rid = setNode['@rid']
	const set_path = media.getSetDir(DATA_DIR, set_project_rid, setNode.uuid || set_rid)
	await media.createProcessDir(set_path)
	await this.setNodeAttribute_old(set_rid, {key: 'path', value: set_path}, 'Set')
	setNode.path = set_path

	
	const inputSetRid = processNode.input_set || processNode.file_rid
	if(inputSetRid) {
		await this.connectDerivedFrom(set_rid, inputSetRid, process_rid)
	}
	await this.syncSetManifest(set_rid)

	return setNode

}



graph.createProcessSetNode = async function (process_rid, options) {
	if(!options) options = {}
	const setOptions = { ...options }
	if(setOptions.search_output) {
		setOptions.type = 'search'
	}
	delete setOptions.search_output

	const setNode = await this.create('Set', setOptions)
	var set_rid = setNode['@rid']
	if(setOptions.type && !setNode.type) {
		setNode.type = setOptions.type
	}
	const set_project_rid = setOptions?.project_rid || await this.getProjectRidForNode(process_rid)
		if(set_project_rid && !setOptions?.project_rid) {
			await this.setNodeAttribute_old(set_rid, {key: 'project_rid', value: set_project_rid}, 'Set')
		}
	const set_path = media.getSetDir(DATA_DIR, set_project_rid, setNode.uuid || set_rid)
	await media.createProcessDir(set_path)
	await this.setNodeAttribute_old(set_rid, {key: 'path', value: set_path}, 'Set')
	setNode.path = set_path
	if(set_project_rid) {
		await this.connect(set_rid, 'BELONGS_TO', set_project_rid)
	}
	if(setOptions?.input_set) {
		await this.connectDerivedFrom(set_rid, setOptions.input_set, process_rid)
	}
	await this.syncSetManifest(set_rid)

	return setNode

}

graph.createOriginalFileNode = async function (project_rid, file, file_type, set_rid, data_dir) {

	var description = ''
	var info = ''
	if(file.hapi.description) description = file.hapi.description
	if(file.hapi.info) info = file.hapi.info
	var extension = path.extname(file.hapi.filename).replace('.', '').toLowerCase()

	var vertex_params = {
		uuid: uuidv7(),
		project_rid: project_rid,
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
	await this.connect(file_rid, 'BELONGS_TO', project_rid)
	var file_path = media.getFilePath(data_dir, project_rid, response.result[0].uuid || file_rid, extension)
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path
	
	// link file to set
	if(set_rid) {
		if (!set_rid.match(/^#/)) set_rid = '#' + set_rid
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

	let process_path = ''
	let process_rid = ''

	if(message.process) {
		process_rid = message.process['@rid']
		const path_query = `SELECT path FROM ${process_rid}`
		const path_response = await db.sql(path_query)
		process_path = path_response.result[0].path
	} else {
		console.log('Process not found in message')
		throw new Error('Process not found in message')
	}

	const vertex_params = {
		uuid: uuidv7(),
		project_rid: message.file.project_rid || null,
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
	const error_project_rid = message.file.project_rid || await this.getProjectRidForNode(process_rid)
	var file_path = media.getFilePath(DATA_DIR, error_project_rid, response.result[0].uuid || file_rid, 'json')
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path

	// if output of process is a set, then connect file to set ALSO and add attribute "set"
	if(message.output_set) {
		await this.setNodeAttribute_old(file_rid, {key:"set", value: message.output_set}, 'File' ) // this attribute is used in project query
		await this.connectDerivedFrom(file_rid, message.file['@rid'], process_rid)
		await this.syncSetManifest(message.output_set)
	// otherwise connect file to process
	} else {
		await this.connectDerivedFrom(file_rid, message.file['@rid'], process_rid)
	}

	return response.result[0]
}



graph.createImageROIs = async function(image_rid, set_rid, data, user_rid) {

	if (!image_rid.match(/^#/)) image_rid = '#' + image_rid
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid
	const set_node = await this.getNodeAttributes(image_rid, user_rid)
	if(!set_node) {
		throw new Error('Set not found: '+ image_rid
		)
	}
	// find out images path by stripping filename from file path
	var image_path = set_node.path
	if(image_path) image_path = image_path.split('/').slice(0, -1).join('/')
	else {
		console.log('Image path not found for node: ', set_node)
		throw new Error('Image path not found for node: '+ image_rid )
	}
	// create ROI as a normal File node.
	let roi = null
	try {
		const image_node = await this.getNodeAttributes(image_rid, user_rid)
		const roi_data = {
			type: 'roi.json',
			extension: 'json',
			set: set_rid,
			project_rid: image_node?.project_rid,
			label: `${path.basename(image_node?.label || image_rid)}.roi.json`
		}
		roi = await this.create('File', roi_data, null, null, true)
		await this.connectDerivedFrom(roi['@rid'], image_rid)
		var roi_rid = roi['@rid'].replace('#', '').replace(':', '_')
		media.writeJSON(data, roi_rid + '.roi.json', image_path)
		var roi_path = path.join(image_path, roi_rid + '.roi.json')
		await this.setNodeAttribute_old(roi['@rid'], {"key": "path", "value": roi_path}, 'File')
		await this.setNodeAttribute_old(roi['@rid'], {"key": "set", "value": set_rid}, 'File')
	} catch (error) {
		console.log('Error creating ROI node: ', error)
		throw new Error('Error creating ROI node: '+ error.message )
	}

	return roi

}

graph.editImageROIs = async function(roi_rid, data, user_rid) {

	if (!roi_rid.match(/^#/)) roi_rid = '#' + roi_rid
	const roi_node = await this.getNodeAttributes(roi_rid, user_rid)
	if(!roi_node) {
		throw new Error('ROI not found: '+ roi_rid
		)
	}
	if(roi_node.path) {
		try {
			media.writeJSON(data, path.basename(roi_node.path), path.dirname(roi_node.path))
			return {message: 'ROI updated successfully'}
		} catch (error) {
			console.log('Error updating ROI JSON file: ', error)
			throw new Error('Error updating ROI JSON file: '+ error.message )
		}
	} else {
		console.log('ROI path not found for node: ', roi_node)
		throw new Error('ROI path not found for node: '+ roi_rid )
	}
}

graph.getImageROIs = async function(rid, set_rid, user_rid) {
	if (!rid.match(/^#/)) rid = '#' + rid.replace('_', ':')
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid.replace('_', ':')
	const query = `MATCH {type:File, as:roi, where:(set = "${set_rid}" AND type = "roi.json")}-DERIVED_FROM->{type:File, where:(@rid = ${rid})} RETURN roi`
	var response = await db.sql(query)
	if(!response.result[0] || !response.result[0].roi) {
		const fallbackQuery = `MATCH {type:Set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:roi, where:(@type = 'File' AND type = "roi.json")}-DERIVED_FROM->{type:File, where:(@rid = ${rid})} RETURN roi`
		response = await db.sql(fallbackQuery)
	}
	if(!response.result[0] || !response.result[0].roi) {
		console.log('ROI not found for file: ', rid)
		throw new Error('ROI not found for file: '+ rid )
	}
	try {
		var f = await media.readJSON(response.result[0].roi.path)
		return f
	} catch (error) {
		console.log('Error reading ROI JSON: ', error)
		// return 404 error if file not found, otherwise 500
		if (error.code === 'ENOENT') {
			throw new Error('ROI JSON file not found: ' + response.result[0].roi.path)
		} else {
			throw new Error('Error reading ROI JSON: ' + error.message)
		}
	}
}

graph.updateFileCount = async function (set_rid) {
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	const count_query = `MATCH {type:File, as:file, where:(set = "${set_rid}"), optional:true}
	RETURN count(file) as count`
	var count_response = await db.sql(count_query)
	if(!count_response.result.length) {
		const count_query_fallback = `MATCH {type:Set, as:set, where: ( @rid = "${set_rid}")}-HAS_ITEM->{type:File, as: file, optional:true}
		RETURN count(file) as count`
		count_response = await db.sql(count_query_fallback)
	}

	var count = count_response.result[0].count

	const query = `UPDATE Set SET count = ${count} WHERE @rid = "${set_rid}" `
	var response = await db.sql(query)
	await this.syncSetManifest(set_rid)
	return count
}

graph.syncSetManifest = async function(set_rid) {
	if (!set_rid.match(/^#/)) set_rid = '#' + set_rid

	const setQuery = `SELECT @rid, uuid, label, path, count FROM Set WHERE @rid = ${set_rid}`
	const setResponse = await db.sql(setQuery)
	if(!setResponse.result.length) {
		return null
	}

	const setNode = setResponse.result[0]
	let setPath = setNode.path
	if(!setPath) {
		const set_project_rid = await this.getProjectRidForNode(set_rid)
		setPath = media.getSetDir(DATA_DIR, set_project_rid, setNode.uuid || set_rid)
		await media.createProcessDir(setPath)
		await this.setNodeAttribute_old(set_rid, {key: 'path', value: setPath}, 'Set')
	}

	const itemQuery = `MATCH {type:File, as:item, where:(set = "${set_rid}")}
		RETURN item.@rid AS rid, item.@type AS node, item.label AS label, item.path AS path, item.type AS type`
	let itemsResponse = await db.sql(itemQuery)
	if(!itemsResponse.result.length) {
		const itemQueryFallback = `MATCH {type:Set, as:set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:item, where:(@type = 'File')}
			RETURN item.@rid AS rid, item.@type AS node, item.label AS label, item.path AS path, item.type AS type`
		itemsResponse = await db.sql(itemQueryFallback)
	}

	const manifest = {
		set: {
			rid: setNode['@rid'],
			label: setNode.label || '',
			count: setNode.count || 0,
			path: setPath
		},
		updated_at: new Date().toISOString(),
		items: itemsResponse.result || []
	}

	await media.writeJSON(manifest, 'set.json', setPath)
	return manifest
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
		uuid: uuidv7(),
		project_rid: message.file.project_rid || null,
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
	const process_project_rid = message.file.project_rid || await this.getProjectRidForNode(process_rid)
	var file_path = media.getFilePath(DATA_DIR, process_project_rid, response.result[0].uuid || file_rid, extension)
	await this.setNodeAttribute_old(file_rid, {"key": "path", "value": file_path}, 'File')
	response.result[0]['path'] = file_path

	const isSearchOutput = message?.search_output === true
	const searchSourceSetRid = typeof message?.search_source_set === 'string'
		? message.search_source_set
		: message?.search_source_set?.['@rid']
	const inputSetRid = typeof message?.input_set === 'string'
		? message.input_set
		: message?.input_set?.['@rid']
	const setRid = typeof message?.set_rid === 'string'
		? message.set_rid
		: message?.set_rid?.['@rid']
	const fallbackLineageSourceRid = message?.root_source?.['@rid'] || message?.file?.['@rid']
	const lineageSourceRid = isSearchOutput
		? (searchSourceSetRid || inputSetRid || setRid || fallbackLineageSourceRid)
		: fallbackLineageSourceRid

	// if output of process is a set, then connect file to set ALSO and add attribute "set"
	if(message.output_set) {
		await this.setNodeAttribute_old(file_rid, {key:"set", value: message.output_set}, 'File' ) // this attribute is used in project query
		if(lineageSourceRid) {
			await this.connectDerivedFrom(file_rid, lineageSourceRid, process_rid)
		}
		await this.syncSetManifest(message.output_set)
	// otherwise connect file to process
	} else {
		if(lineageSourceRid) {
			await this.connectDerivedFrom(file_rid, lineageSourceRid, process_rid)
		}
	}

	return response.result[0]
}

graph.createReferenceFileNode = async function (process_rid, message, ref_file_rid, description, info) {
	const file_type = message.file.type
	const extension = message.file.extension
	const label = message.file.label
	var f_info = ''
	var f_description = ''
	if(description) f_description = description
	if(info) f_info = info

	const clean_ref_file_rid = this.sanitizeRID(ref_file_rid)
	const refResponse = await db.sql(`SELECT @rid, path, metadata, info FROM ${clean_ref_file_rid}`)
	if(!refResponse.result?.length || !refResponse.result[0]?.path) {
		throw new Error(`Reference source not found or missing path: ${clean_ref_file_rid}`)
	}

	var vertex_params = {
		uuid: uuidv7(),
		project_rid: message.file.project_rid || null,
		type: file_type,
		extension: extension,
		label: label,
		description: f_description,
		info: f_info,
		expand: false,
		_active: true,
		ref: clean_ref_file_rid
	}
	if(message.set) vertex_params.set = message.set

	const query = `CREATE VERTEX File CONTENT ${JSON.stringify(vertex_params)}`
	var response = await db.sql(query)
	var file_rid = response.result[0]['@rid']
	const file_path = refResponse.result[0].path

	await this.setNodeAttribute_old(file_rid, { key: 'path', value: file_path }, 'File')
	response.result[0]['path'] = file_path
	response.result[0]['ref'] = clean_ref_file_rid

	const isSearchOutput = message?.search_output === true
	const searchSourceSetRid = typeof message?.search_source_set === 'string'
		? message.search_source_set
		: message?.search_source_set?.['@rid']
	const inputSetRid = typeof message?.input_set === 'string'
		? message.input_set
		: message?.input_set?.['@rid']
	const setRid = typeof message?.set_rid === 'string'
		? message.set_rid
		: message?.set_rid?.['@rid']
	const fallbackLineageSourceRid = clean_ref_file_rid
	const lineageSourceRid = isSearchOutput
		? (searchSourceSetRid || inputSetRid || setRid || fallbackLineageSourceRid)
		: fallbackLineageSourceRid

	if(message.output_set) {
		await this.setNodeAttribute_old(file_rid, { key: 'set', value: message.output_set }, 'File')
		if(lineageSourceRid) {
			await this.connectDerivedFrom(file_rid, lineageSourceRid, process_rid)
		}
		await this.syncSetManifest(message.output_set)
	} else {
		if(lineageSourceRid) {
			await this.connectDerivedFrom(file_rid, lineageSourceRid, process_rid)
		}
	}

	return response.result[0]
}


graph.getUserFileMetadata = async function (file_rid, user_rid) {

	const clean_file_rid = this.sanitizeRID(file_rid)
	// file must be somehow related to a project that is owned by user
	var query = `MATCH {type:User, as:p, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project}<--{as:file, where:(@rid = ${clean_file_rid} AND @type = 'File'), while: ($depth < 30)} return file, project`

	var file_response = await db.sql(query)

	if(file_response.result[0] && file_response.result[0].file) {
		file_response.result[0].file.project_rid = file_response.result[0].project['@rid']
		return file_response.result[0].file
	}

	else {
		// check if file is a Set
		var query_set = `MATCH {type:User, as:p, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project}<--{type:Set, as:file, where:(@rid = ${clean_file_rid}), while: ($depth < 30)} return file, project`
			console.log('QUERY_SET: ', query_set)
		var set_response = await db.sql(query_set)
		if(set_response.result[0] && set_response.result[0].file) {
			// we need to get file types of the set content
			const {extensions, types} = await getSetFileTypes(clean_file_rid)
			//console.log('extensions', extensions)
			set_response.result[0].file.extensions = extensions
			set_response.result[0].file.types = types
			set_response.result[0].file.project_rid = set_response.result[0].project['@rid']
			return set_response.result[0].file

		// check if file is source (not file at all!)
		} else {
			var query_source = `MATCH {type:User, as:p, where:(@rid = ${user_rid})}<-HAS_OWNER-{type:Project, as:project}--> {type:Source, as:file, where:(@rid = ${clean_file_rid})} return file, project`
				
			var source_response = await db.sql(query_source)
			if(source_response.result[0] && source_response.result[0].file) {
				source_response.result[0].file.project_rid = source_response.result[0].project['@rid']
				return source_response.result[0].file
			}
		}
	}
		return null
}

graph.getFileSource = async function (file_rid, file_type) {
	console.log('getFileSource', file_rid, file_type)
	const clean_file_rid = this.sanitizeRID(file_rid)
	const sql = `Match {type:File, as:target, where:(@rid = ${clean_file_rid} )}-DERIVED_FROM->{type:File, as:source} return source`
	var response = await db.sql(sql)
	if(response.result[0] && response.result[0].source) return response.result[0].source

	// legacy fallback
	const sql_legacy = `Match {type:File, as:source}-PROCESSED_BY->{type:Process, as:process}-PRODUCED->{type: File, as:target, where:(@rid = ${clean_file_rid} )} return source`
	response = await db.sql(sql_legacy)
	if(response.result[0] && response.result[0].source) return response.result[0].source


	return null
}

graph.getFileAncestors = async function (file_rid, userRID, maxDepth = 40) {
	const clean_rid = this.sanitizeRID(file_rid)
	const access = await this.hasAccess(clean_rid, userRID)
	if (!access) return null

	const ancestors = []
	let current = clean_rid
	let depth = 0

	while (depth < maxDepth) {
		const sql = `MATCH {type:File, as:target, where:(@rid = ${current})}-DERIVED_FROM->{type:File, as:source} RETURN source.@rid AS rid, source.label AS label, source.type AS type, source.extension AS extension, source.path AS path, source.@type AS node_type`
		const response = await db.sql(sql)
		if (!response.result || !response.result.length || !response.result[0].rid) break
		const row = response.result[0]
		ancestors.push({
			'@rid': row.rid,
			label: row.label,
			type: row.type,
			extension: row.extension,
			path: row.path,
			'@type': row.node_type
		})
		current = row.rid
		depth++
	}

	return ancestors
}

graph.getFileSet = async function (file_rid) {
	const clean_file_rid = this.sanitizeRID(file_rid)
	const sql = `SELECT set FROM ${clean_file_rid}`
	var response = await db.sql(sql)
	if(response.result[0] && response.result[0].set) {
		const setNodeResponse = await db.sql(`SELECT FROM ${response.result[0].set}`)
		if(setNodeResponse.result[0]) return setNodeResponse.result[0]
	}
	const sql_legacy = `Match {type:Set, as:set}-CONTAINS->{type:File, as:file, where:(@rid = ${clean_file_rid} )} return set, file`
	response = await db.sql(sql_legacy)
	if(!response.result[0] || !response.result[0].set) {
		const sql_fallback = `Match {type:Set, as:set}-HAS_ITEM->{type:File, as:file, where:(@rid = ${clean_file_rid} )} return set, file`
		response = await db.sql(sql_fallback)
	}
	if(response.result[0] && response.result[0].set) return response.result[0].set
	return null
}

graph.query = async function (body) {
	return db.cypher(body.query)
}

graph.create = async function (type, data, admin, tid) {
	//console.log('create', type, data)
	if(!data) data = {}
	if(!data.uuid) data.uuid = uuidv7()
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
	if(!data) data = {}
	if(!data.uuid) data.uuid = uuidv7()
	
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
	rid = this.sanitizeRID(rid)

	const rootNode = await this.getNodeAttributes(rid, userRID)
	if(!rootNode) throw new Error('Node not found')

	const queue = [rid]
	const visited = new Set()
	const toDelete = new Set()
	const solrTargets = new Set()
	const pathTargets = new Set()

	const enqueueRid = (value) => {
		if(!value) return
		try {
			const clean = this.sanitizeRID(String(value))
			if(!visited.has(clean)) queue.push(clean)
		} catch {
			// ignore invalid/non-RID values in edge attributes
		}
	}

	const isNotFoundError = (error) => {
		const message = String(error?.message || '')
		return /response code 404|not found/i.test(message)
	}

	while(queue.length > 0) {
		const current = queue.pop()
		if(visited.has(current)) continue
		visited.add(current)

		let node = null
		try {
			const nodeResponse = await db.sql(`SELECT @rid, @type, path, service, ref FROM ${current}`)
			node = nodeResponse.result[0]
		} catch (error) {
			if(isNotFoundError(error)) {
				// Stale process_rid references in edge attributes are allowed; just skip missing nodes.
				continue
			}
			throw error
		}
		if(!node || !node['@rid']) continue

		toDelete.add(node['@rid'])

		if(node.service === 'Solr') {
			solrTargets.add(node['@rid'])
		}

		const isReferenceFile = node['@type'] === 'File' && Boolean(node.ref)
		if(node.path && node['@type'] !== 'Filter' && !isReferenceFile) {
			if(node['@type'] === 'Process' && path.basename(node.path) === 'files') {
				pathTargets.add(path.dirname(node.path))
			} else {
				pathTargets.add(node.path)
			}
		}

		// Descendants in lineage graph: child -DERIVED_FROM-> current
		const descendantsResponse = await db.sql(`SELECT @out AS rid, process_rid FROM DERIVED_FROM WHERE @in = ${current}`)
		for(const rel of descendantsResponse.result || []) {
			enqueueRid(rel.rid)
			enqueueRid(rel.process_rid)
		}

		// Process nodes are referenced in edge attributes, not as graph endpoints.
		// Deleting a process must delete output nodes linked via process_rid.
		const processLinkedResponse = await db.sql(`SELECT @out AS rid FROM DERIVED_FROM WHERE process_rid = "${current}"`)
		for(const rel of processLinkedResponse.result || []) {
			enqueueRid(rel.rid)
		}

		// Also remove processes referenced only in file-link edge attributes.
		const linkedEdgesResponse = await db.sql(`SELECT process_rid FROM DERIVED_FROM WHERE @in = ${current} OR @out = ${current}`)
		for(const edge of linkedEdgesResponse.result || []) {
			enqueueRid(edge.process_rid)
		}

		// Set members may not have DERIVED_FROM to Set, include both current and legacy schema.
		if(node['@type'] === 'Set') {
			let filesResponse = await db.sql(`SELECT @rid AS rid FROM File WHERE set = "${current}"`)
			if(!filesResponse.result.length) {
				filesResponse = await db.sql(`MATCH {type:Set, as:set, where:(@rid = ${current})}-HAS_ITEM->{as:file, where:(@type = 'File')} RETURN DISTINCT file.@rid AS rid`)
			}
			for(const file of filesResponse.result || []) {
				enqueueRid(file.rid)
			}
		}

		// SetProcess may own Process nodes via set_process attribute.
		if(node['@type'] === 'SetProcess') {
			const processResponse = await db.sql(`SELECT @rid AS rid FROM Process WHERE set_process = "${current}"`)
			for(const processNode of processResponse.result || []) {
				enqueueRid(processNode.rid)
			}
		}
	}

	for(const solrRid of solrTargets) {
		console.log('deleting solr index', solrRid)
		await solr.dropSetIndex(solrRid)
	}

	const targets = Array.from(toDelete).map((id) => ({id}))
	if(targets.length > 0) {
		await db.deleteMany(targets)
	}

	const uniquePaths = Array.from(pathTargets).sort((a, b) => b.length - a.length)
	for(const p of uniquePaths) {
		await media.deleteNodePath(p)
	}

	return {
		path: uniquePaths[0] || null,
		deleted: targets.length,
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

graph.connectDerivedFrom = async function (target, source, process_rid, tid) {
	if (!target.match(/^#/)) target = '#' + target
	if (!source.match(/^#/)) source = '#' + source
	if (process_rid && !process_rid.match(/^#/)) process_rid = '#' + process_rid

	await this.connect(target, 'DERIVED_FROM', source, tid)
	if(process_rid) {
		let process_id = process_rid
		let cruncher = ''
		let task = ''
		try {
			const processResponse = await db.sql(`SELECT uuid, service_id, service, label, task FROM ${process_rid}`)
			if(processResponse.result[0]) {
				const p = processResponse.result[0]
				if(p.uuid) process_id = p.uuid
				cruncher = p.service_id || p.service || p.label || ''
				task = p.task || ''
			}
		} catch (e) {
			// Keep fallback values if process node lookup fails
		}

		const query = `UPDATE DERIVED_FROM SET process_rid = "${process_rid}", process_id = "${process_id}", cruncher = "${String(cruncher).replace(/"/g, '\\"')}", task = "${String(task).replace(/"/g, '\\"')}" WHERE @out = ${target} AND @in = ${source}`
		return db.sql(query)
	}
	return {result: 'ok'}
}

graph.connectSetContains = async function(set_rid, item_rid, tid) {
	await this.connect(set_rid, 'CONTAINS', item_rid, tid)
	// compatibility for existing queries
	await this.connect(set_rid, 'HAS_ITEM', item_rid, tid)
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
	var query = `MATCH {type:Project, as:project, where:(@rid = :rid)}-HAS_OWNER->{type: User, as:p, where:(@rid = :userRID)} return project`

	var response = await db.sql_params(query, {rid: rid, userRID: userRID}, true)
	return response.result.length > 0
}

graph.isNodeOwner = async function (rid, userRID) {

	// node must be somehow related to a project that is owned by user
	var query = `MATCH {type:User, as:p, where:(@rid = ${userRID})}<-HAS_OWNER-{type:Project, as:project}<--{as:node, where:(@rid = ${rid}), while: ($depth < 100)} return node`
	

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
	const cleanSetRid = this.sanitizeRID(set)
	if(!await this.isNodeOwner(cleanSetRid, userRID)) throw({'message': 'You are not the owner of this set'})
	let query = `SELECT process_rid FROM DERIVED_FROM WHERE @out = ${cleanSetRid} AND process_rid IS NOT NULL LIMIT 1`
	let response = await db.sql(query)
	if(response.result[0] && response.result[0].process_rid) {
		const process = await db.sql(`SELECT FROM ${response.result[0].process_rid}`)
		if(process.result[0]) return {setprocess: process.result[0]}
	}

	// legacy fallback
	query = `MATCH {type: Set, where: (@rid = ${cleanSetRid})}.in('PRODUCED') {as: setprocess} RETURN setprocess`
	response = await db.sql(query)
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

async function getDirectorySizeBytes(targetDir) {
	if (!targetDir) return 0
	const exists = await fse.pathExists(targetDir)
	if (!exists) return 0

	let total = 0
	const entries = await fse.readdir(targetDir, { withFileTypes: true })
	for (const entry of entries) {
		const entryPath = path.join(targetDir, entry.name)
		if (entry.isDirectory()) {
			total += await getDirectorySizeBytes(entryPath)
		} else if (entry.isFile()) {
			const stats = await fse.stat(entryPath)
			total += stats.size
		}
	}

	return total
}

graph.updateProjectSizes = async function (userRID, dataDir = DATA_DIR) {
	const query = `MATCH {type:Project, as:project}-HAS_OWNER->{type:User, as:user, where:(@rid = ${userRID})} RETURN project`
	const response = await db.sql(query)
	const projects = response.result || []
	const updated = []

	for (const item of projects) {
		const project = item.project || item
		if (!project || !project['@rid']) continue

		const projectRID = project['@rid']
		const projectPath = media.getProjectDir(dataDir, projectRID)
		const bytes = await getDirectorySizeBytes(projectPath)
		const sizeMb = Math.round((bytes / 1024 / 1024) * 100) / 100

		await db.sql_params(`UPDATE Project SET size = :size WHERE @rid = :rid`, {
			size: sizeMb,
			rid: projectRID
		})

		updated.push({
			rid: projectRID,
			size: sizeMb,
			bytes
		})
	}

	return {
		updated: updated.length,
		projects: updated
	}
}


graph.setNodeAttribute = async function (rid, data, userRID) {

	if(!await this.isNodeOwner(rid, userRID)) throw({'message': 'You are not the owner of this file'})

	let query = ''
	let params = {rid: rid}
	if(NODE_ATTRIBUTES.includes(data.key)) {
		if(data.value === null) {
			query = `UPDATE :rid REMOVE ${data.key}`
		} else {
			query = `UPDATE :rid SET ${data.key} = :${data.key}`
			params[data.key] = data.value
		}
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
	var query = `MATCH {type:User, as:p, where:(@rid = ${userRID})}<-HAS_OWNER-{type:Project, as:project}<--{as:node, where:(@rid = ${rid}), while: ($depth < 30)} return node`

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


graph.getProjectRidForNode = async function(node_rid) {
	const clean = this.sanitizeRID(node_rid)
	const query = `MATCH {type:Project, as:project}<--{as:node, where:(@rid = ${clean}), while:($depth < 40)} RETURN project.@rid AS rid LIMIT 1`
	const response = await db.sql(query)
	if(response.result[0] && response.result[0].rid) {
		return response.result[0].rid
	}
	return null
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

graph.getSetEntities = async function (set_rid, userRID) {
	const cleanSetRid = this.sanitizeRID(set_rid)
	const setNode = await this.getNodeAttributes(cleanSetRid, userRID)
	if(!setNode || setNode['@type'] !== 'Set') {
		return []
	}

	const query = `MATCH {type:File, as:file, where:(set = "${cleanSetRid}")}-HAS_ENTITY->{type:Entity, as:entity, where:(owner = "${userRID}")}
		RETURN entity.@rid AS rid, entity.label AS label, entity.type AS type, entity.icon AS icon, entity.color AS color, count(file) AS count
		ORDER by count DESC, label`
	let response = await db.sql(query)

	if(!response.result.length) {
		const fallback = `MATCH {type:Set, as:set, where:(@rid = ${cleanSetRid})}-HAS_ITEM->{type:File, as:file}-HAS_ENTITY->{type:Entity, as:entity, where:(owner = "${userRID}")}
			RETURN entity.@rid AS rid, entity.label AS label, entity.type AS type, entity.icon AS icon, entity.color AS color, count(file) AS count
			ORDER by count DESC, label`
		response = await db.sql(fallback)
	}

	return response.result || []
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
	const entity_uuid = uuidv7()
	var query = `CREATE Vertex Entity set uuid = "${entity_uuid}", type = "${data.type}", label = "${data.label}", icon = "${data.icon}", color = "${data.color}", owner = "${userRID}"`
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
	const tag_uuid = uuidv7()
	var query = `create Vertex Tag set uuid = "${tag_uuid}", label = "${label}", owner = "${userRID}"`
	return await db.sql(query)
}

graph.getNode = async function (rid, userRID) {
	var query = `MATCH {type:User, as:user, where: (@rid = "${userRID}")}<-HAS_OWNER-{type:Project, as:project}-->{as:file, while: ($depth < 40), where:(@rid="${rid}")} return file`
	
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

async function getFileSourceType(fileRid) {
	if(!fileRid) return null
	const cleanRid = graph.sanitizeRID(String(fileRid))
	const query = `MATCH {type:File, as:target, where:(@rid = ${cleanRid})}-DERIVED_FROM->{type:File, as:source} RETURN source.type AS source_type LIMIT 1`
	const response = await db.sql(query)
	if(response.result[0] && response.result[0].source_type) {
		return String(response.result[0].source_type).toLowerCase()
	}
	return null
}

async function shouldUsePdfThumbnail(file) {
	if(!file || file.type !== 'pdf') return true

	const pageCountRaw = file?.metadata?.page_count
	const pageCount = Number(pageCountRaw)
	if(Number.isFinite(pageCount) && pageCount > 1) return false

	const sourceType = await getFileSourceType(file.rid || file['@rid'])
	if(!sourceType) return false
	if(sourceType === 'zip') return false

	return true
}

// TODO: this should be saved to Set node when processing of the files in set is done (might slow things in large sets)
async function getSetFileTypes(set_rid) {
	const query = `match {type:File, as:file, where:(set = "${set_rid}")} return distinct file.extension AS extension_group, file.type AS type_group`
	var response = await db.sql(query)	
	if(!response.result.length) {
		const query_fallback = `match {type: Set, as: set, where:(@rid = ${set_rid})}-HAS_ITEM->{as:file} return distinct file.extension AS extension_group, file.type AS type_group`
		response = await db.sql(query_fallback)
	}
	var extensions = []
	var types = []
	for(var result of response.result) {
		extensions.push(result.extension_group)
		types.push(result.type_group)
	}
	return {extensions, types}
}

function roundTo(value, decimals = 2) {
	const factor = Math.pow(10, decimals)
	return Math.round(value * factor) / factor
}

graph.getBatchProcess = async function(process_rid) {
	const clean = this.sanitizeRID(process_rid)
	let response = await db.sql(`SELECT FROM SetProcess WHERE @rid = ${clean} LIMIT 1`)
	if(response.result[0]) return response.result[0]

	response = await db.sql(`SELECT FROM Process WHERE @rid = ${clean} LIMIT 1`)
	if(response.result[0]) return response.result[0]

	return null
}

export function collectProjectSolrReindexSources(rows, projectRid, sanitizeRid) {
	const normalizeRid = typeof sanitizeRid === 'function'
		? sanitizeRid
		: (value) => String(value || '')

	const seen = new Set()
	const sources = []
	for(const row of rows || []) {
		if(!row?.input_set) continue
		const inputSetRid = normalizeRid(String(row.input_set))
		if(!inputSetRid || seen.has(inputSetRid)) continue

		seen.add(inputSetRid)
		sources.push({
			input_set: inputSetRid,
			process_rid: row.process_rid,
			task_id: row.task_id || row.task || 'index',
			task_payload_json: row.task_payload_json || null,
			project_rid: projectRid,
		})
	}

	return sources
}

graph.getProjectSolrReindexSources = async function(project_rid, userRID) {
	const cleanProjectRid = this.sanitizeRID(project_rid)
	if(!await this.isProjectOwner(cleanProjectRid, userRID)) {
		throw new Error('You are not the owner of this project')
	}

	const ridVariants = [cleanProjectRid, cleanProjectRid.replace(/^#/, '')]
	const quoted = ridVariants.map((rid) => `"${rid.replace(/"/g, '\\"')}"`).join(',')
	const whereProject = `project_rid IN [${quoted}]`
	const whereSolrService = '(service_id = "md-solr" OR service = "Solr" OR service = "md-solr" OR topic = "md-solr")'
	const selectFields = '@rid AS process_rid, input_set, task, task_id, task_payload_json, service, service_id, project_rid, topic'

	const setProcessSql = `SELECT ${selectFields} FROM SetProcess WHERE ${whereProject} AND ${whereSolrService}`
	const processSql = `SELECT ${selectFields} FROM Process WHERE ${whereProject} AND ${whereSolrService}`

	const [setProcessResponse, processResponse] = await Promise.all([
		db.sql(setProcessSql),
		db.sql(processSql),
	])

	const rows = [
		...(setProcessResponse.result || []),
		...(processResponse.result || []),
	]

	return collectProjectSolrReindexSources(rows, cleanProjectRid, (rid) => this.sanitizeRID(rid))
}

graph.updateBatchProcess = async function(process_rid, patch) {
	const node = await this.getBatchProcess(process_rid)
	if(!node) return null

	const type = node['@type'] || 'SetProcess'
	for(const key of Object.keys(patch)) {
		await this.setNodeAttribute_old(node['@rid'], {key, value: patch[key]}, type)
		node[key] = patch[key]
	}
	return node
}

graph.initBatchProcess = async function(process_rid, attrs = {}) {
	const now = new Date().toISOString()
	const initial = {
		status: 'running',
		processed_files: 0,
		failed_files: 0,
		total_time_sec: 0,
		avg_sec_per_file: 0,
		eta_sec: null,
		started_at: now,
		updated_at: now,
		...attrs,
	}

	return this.updateBatchProcess(process_rid, initial)
}

graph.incrementBatchProcessed = async function(process_rid, response_time, total_files) {
	const batch = await this.getBatchProcess(process_rid)
	if(!batch) return null

	const now = new Date().toISOString()
	const processed = Number(batch.processed_files || 0) + 1
	const failed = Number(batch.failed_files || 0)
	const total = Number(total_files || batch.total_files || 0)
	const timeDelta = Number(response_time || 0)
	const totalTimeSec = Number(batch.total_time_sec || 0) + (Number.isFinite(timeDelta) ? timeDelta : 0)
	const avgSecPerFile = processed > 0 ? roundTo(totalTimeSec / processed, 3) : 0
	const remaining = total > 0 ? Math.max(total - processed, 0) : 0
	const etaSec = total > 0 && avgSecPerFile > 0 ? Math.round(remaining * avgSecPerFile) : null

	const patch = {
		processed_files: processed,
		failed_files: failed,
		total_files: total || batch.total_files || 0,
		total_time_sec: roundTo(totalTimeSec, 3),
		avg_sec_per_file: avgSecPerFile,
		eta_sec: etaSec,
		updated_at: now,
	}

	if(total > 0 && processed >= total) {
		patch.status = 'done'
		patch.finished_at = now
		patch.eta_sec = 0
	}

	return this.updateBatchProcess(batch['@rid'], patch)
}

graph.incrementBatchFailed = async function(process_rid) {
	const batch = await this.getBatchProcess(process_rid)
	if(!batch) return null

	const now = new Date().toISOString()
	const failed = Number(batch.failed_files || 0) + 1
	const patch = {
		failed_files: failed,
		updated_at: now,
	}

	return this.updateBatchProcess(batch['@rid'], patch)
}

graph.getProcessedInputFileRidsForBatch = async function(process_rid) {
	const clean = this.sanitizeRID(process_rid)
	const query = `SELECT DISTINCT @in AS rid FROM DERIVED_FROM WHERE process_rid = ${clean}`
	console.log('getProcessedInputFileRidsForBatch query', query)
	const edgeResponse = await db.sql(query)
	return edgeResponse.result.map((item) => item.rid).filter(Boolean)
}

graph.groupFilesByRootSource = async function(files, options = {}) {
	const boundary = String(options.boundary || 'pdf').toLowerCase()
	const excludedRootTypes = new Set((options.excludeRootTypes || ['zip']).map((type) => String(type).toLowerCase()))
	if(!Array.isArray(files) || files.length === 0) return []

	const fileByRid = new Map()
	for(const file of files) {
		if(!file || !file['@rid']) continue
		fileByRid.set(this.sanitizeRID(file['@rid']), file)
	}

	const parentByTarget = new Map()
	const nodeMetaByRid = new Map()
	for(const [rid, file] of fileByRid.entries()) {
		nodeMetaByRid.set(rid, {
			'@rid': rid,
			label: file.label,
			type: file.type,
			path: file.path,
			original_filename: file.original_filename,
		})
	}

	const ensureNodeMetadata = async (rids) => {
		const missing = rids.filter((rid) => !nodeMetaByRid.has(rid))
		if(!missing.length) return
		const query = `SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN [${missing.join(',')}]`
		const response = await db.sql(query)
		for(const row of response.result || []) {
			nodeMetaByRid.set(row.rid, {
				'@rid': row.rid,
				label: row.label,
				type: row.type,
				path: row.path,
				original_filename: row.original_filename,
			})
		}
	}

	const traverseAncestorsBatched = async (seedRids, maxDepth = 40) => {
		let frontier = Array.from(new Set(seedRids))
		const visited = new Set()
		let depth = 0

		while(frontier.length > 0 && depth < maxDepth) {
			const currentBatch = frontier.filter((rid) => !visited.has(rid))
			if(!currentBatch.length) break
			frontier = []
			for(const rid of currentBatch) visited.add(rid)

			const edgeQuery = `SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [${currentBatch.join(',')}]`
			const edgeResponse = await db.sql(edgeQuery)
			const sourceRids = []
			for(const edge of edgeResponse.result || []) {
				if(!edge.target_rid || !edge.source_rid) continue
				if(!parentByTarget.has(edge.target_rid)) {
					parentByTarget.set(edge.target_rid, edge.source_rid)
				}
				sourceRids.push(edge.source_rid)
				if(!visited.has(edge.source_rid)) {
					frontier.push(edge.source_rid)
				}
			}

			if(sourceRids.length) {
				await ensureNodeMetadata(Array.from(new Set(sourceRids.map((rid) => this.sanitizeRID(rid)))))
			}
			depth += 1
		}
	}

	const seedRids = Array.from(fileByRid.keys())
	await traverseAncestorsBatched(seedRids)

	const groupsByRid = new Map()
	for(const [fileRid, file] of fileByRid.entries()) {
		let cursor = fileRid
		let boundaryCandidate = null
		let highestNonExcluded = fileRid
		let guard = 0

		while(cursor && guard < 40) {
			const meta = nodeMetaByRid.get(cursor) || {}
			const nodeType = String(meta.type || '').toLowerCase()
			if(!excludedRootTypes.has(nodeType)) {
				highestNonExcluded = cursor
				if(boundary === 'pdf' && nodeType === 'pdf') {
					boundaryCandidate = cursor
				}
			}

			const parent = parentByTarget.get(cursor)
			if(!parent) break
			cursor = parent
			guard += 1
		}

		const rootRid = boundaryCandidate || highestNonExcluded || fileRid
		if(!groupsByRid.has(rootRid)) {
			const rootMeta = nodeMetaByRid.get(rootRid) || {}
			groupsByRid.set(rootRid, {
				source_rid: rootRid,
				label: rootMeta.label || rootMeta.original_filename || file.label,
				type: rootMeta.type || file.type,
				path: rootMeta.path || null,
				files: [],
			})
		}

		groupsByRid.get(rootRid).files.push(file)
	}

	const groups = Array.from(groupsByRid.values())
	groups.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')))
	for(const group of groups) {
		group.files.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')))
	}

	return groups
}



export default graph