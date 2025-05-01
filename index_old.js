const Koa			= require('koa');
const Router		= require('@koa/router');
const { bodyParser }	= require('@koa/bodyparser');
const json			= require('koa-json')
const serve 		= require('koa-static')
const multer 		= require('@koa/multer');
const winston 		= require('winston');
const path 			= require('path')
const fs 			= require('fs')
const fse 			= require('fs-extra')
const { pipeline }  = require('stream');
const websocket 	= require('koa-easy-ws')

const Graph 		= require('./graph.js');
const web 			= require('./web.js');

const media 		= require('./media.js');
const schema 		= require('./schema.js');
const styles 		= require('./styles.js');
const services 		= require('./services.js');
const nomad 		= require('./nomad.js');
let nats
let positions

const DATA_DIR = process.env.DATA_DIR || 'data'
const API_URL = process.env.API_URL || '/'

const AUTH_HEADER = 'mail'
const AUTH_NAME = 'displayname'

const connections = new Map();

(async () => {
	console.log('initing...')
	// migration to ES6 in progress...
	const {queue} = await import('./queue.mjs');
	const {layout} = await import('./layouts.mjs');
	nats = queue
	positions = layout
	await media.createDataDir(DATA_DIR)
	await nomad.getStatus()
	await services.loadServiceAdapters()
	// create main stream and all consumers in NATS
	await nats.init(services.getServices())

	if(process.env.NODE_ENV != 'production') {
		// start thumbnailer and Poppler services
		// var thumb = await services.getServiceAdapterByName('thumbnailer')
		// await nomad.createService(thumb)
		// var ima = await services.getServiceAdapterByName('md-imaginary')
		// await nomad.createService(ima)		
	}

	await Graph.initDB()

})();

process.on( 'SIGINT', async function() {
	console.log( "\nGracefully shutting down from SIGINT (Ctrl-C)" );
	if(process.env.NODE_ENV != 'production') {
		// // we may want to shutdown nomad jobs if we are developing locally
		// await nomad.stopService('MD-thumbnailer')
		// await nomad.stopService('MD-imaginary')
	}

	process.exit( );
  })


// LOGGING
require('winston-daily-rotate-file');

var rotatedLog = new (winston.transports.DailyRotateFile)({
	filename: 'logs/messydesk-%DATE%.log',
	datePattern: 'YYYY-MM',
	zippedArchive: false,
	maxSize: '20m'
});

const logger = winston.createLogger({
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.prettyPrint()
	),
	transports: [
		new winston.transports.Console(),
		rotatedLog
	]
});

logger.info('MessyDesk started');
// LOGGING ENDS

// open endpoints
const openEndpoints = [
	'/api/sso',
	'/api/permissions/request'
]


const app = new Koa();
var router = new Router();

app.use(websocket())
app.use(json({ pretty: true, param: 'pretty' }))
app.use(bodyParser());
app.use(serve(path.join(__dirname, '/public')))


// check that user has rights to use app
app.use(async function handleError(context, next) {

	if(process.env.MODE === 'development') {
		//console.log('auth header: ', context.request.headers[AUTH_HEADER])
		// allow sending AUTH_HEADER for development
		if(!context.request.headers[AUTH_HEADER]) {
			context.request.headers[AUTH_HEADER] = "local.user@localhost" // dummy shibboleth
			if(process.env.DEV_USER) 
				context.request.headers[AUTH_HEADER] = process.env.DEV_USER			
		}
		context.request.user = await Graph.myId(context.request.headers[AUTH_HEADER])
	} else {
		context.request.user = await Graph.myId(context.request.headers[AUTH_HEADER])
	}
	await next()
});

const upload = multer({
	dest: './data/uploads/',
	fileSize: 1048576
});


// catch errors in routes
app.use(async function handleError(context, next) {

	try {
		if(!context.request.user && !openEndpoints.includes(context.request.path) && context.request.path) 
			context.status = 401
		else 
			await next();
	} catch (error) {
		context.status = 500;
		var error_msg = error
		if(error.status) context.status = error.status
		if(error.message) error_msg = error.message

		logger.error({
			user:context.request.headers.mail,
			message: error_msg,
			params: context.params,
			path: context.path,
			body: context.request.body,
			error: error
		});
		context.body = {'error':error_msg};

		//debug(error.stack);
	}
});


router.all('/ws', async (ctx, next) => {
	if (ctx.ws) {
	  const ws = await ctx.ws()
	  const userId = ctx.headers[AUTH_HEADER] 
	  console.log(userId)
  
	  // Store WebSocket connection with user ID
	  connections.set(userId, ws);
	  ws.on('message', function message(data) {
		//console.log('received: %s', data);
		positions.updateProjectNodePosition(JSON.parse(data), userId)
	  });
	}
  })


// these two routes are the only endpoints that doesn't require user permissions
// return user's email (sso)
router.get('/api/sso', function (ctx) {
	ctx.body = {mail:ctx.headers[AUTH_HEADER], name:ctx.headers[AUTH_NAME]}
})

// allow users to ask user permissions
router.post('/api/permissions/request', async function (ctx) { // "/p/r" = /permissions/request
	console.log(ctx.headers)
	const userId = ctx.headers[AUTH_HEADER] 
	var userName = ctx.headers[AUTH_NAME] 
	if(!userName) userName = userId

	if(userId) {
		try {
			const query = `SELECT FROM Request WHERE id = "${userId}"`
			var res = await web.sql(query)
			const query2 = `SELECT FROM User WHERE id = "${userId}"`
			var res2 = await web.sql(query)
			if(res.result.length > 0 || res2.result.length > 0) throw new Error('Already requested')
			await Graph.createWithSQL('Request', {
				id: userId,
				label: userName,
				date: '[TIMESTAMP]'
			})
			//await mailer.sendUserRequest(userId)
		
		} catch (error) {
			console.log('User request failed: ', userId, error)
			logger.error({
				user:userId,
				message: error.message,
				error: error
			});
			throw error
		}
	}
	ctx.body = {status: 'ok'}
})


// NEEDS AUTH
router.get('/api', function (ctx) {
	ctx.body = 'MessyDesk API'
})

router.get('/api/permissions/request', async function (ctx) {
	const query = `SELECT FROM Request`
	var res = await web.sql(query)		
	ctx.body = res.result
})

router.delete('/api/permissions/request/:rid', async function (ctx) {
	const query = `DELETE FROM Request WHERE @rid = ${Graph.sanitizeRID(ctx.params.rid)}`
	var res = await web.sql(query)		
	ctx.body = res
})

router.get('/api/settings', function (ctx) {
	ctx.body = {
		info: 'MessyDesk API',
		version: require('./package.json').version,
		mode: process.env.MODE,
		data_dir: DATA_DIR,
		db: process.env.DB_NAME,
		user: ctx.request.user}
})

router.get('/connections', function (ctx) {
	const itr = connections.keys()
	var arr = []
	for (const value of itr) {
		arr.push(value);
	  }
	ctx.body = arr
})

router.get('/connections/test', async function (ctx) {
	await send2UI(ctx.headers[AUTH_HEADER], {command: 'add', target:'#43:10', node:{'@rid':'#'+Math.random(),type:'process'}})
	ctx.body = 'message send'

})

router.get('/api/me', async function (ctx) {
	var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	ctx.body = {rid: me.rid, admin: me.admin, group:me.group, access:me.access, id: ctx.request.headers[AUTH_HEADER], mode:process.env.MODE ? process.env.MODE : 'production' }
})

router.get('/api/users', async function (ctx) {
	if(ctx.request.user.access == 'admin') {
		ctx.body = await Graph.getUsers()
	}
})

router.post('/api/users', async function (ctx) {
	if(ctx.request.user.access == 'admin') {
		ctx.body = await Graph.createUser(ctx.request.body)
	}
})

router.post('/api/search', async function (ctx) {
	var n = await web.solr(ctx.request.body, ctx.request.user.id)
	ctx.body = n
})


router.post('/api/index', async function (ctx) {
	//if(ctx.request.user.access == 'admin') {
		var n = await Graph.index()
		ctx.body = n
	//}
})

router.post('/api/index/me', async function (ctx) {
	console.log(ctx.request.user.rid)
	var n = await Graph.index(ctx.request.user.rid)
	ctx.body = n
})

router.post('/api/index/:rid', async function (ctx) {
	var n = await Graph.index(ctx.request.body, ctx.request.params.rid, ctx.request.user.rid)
	ctx.body = n
})

router.delete('/api/index/:rid', async function (ctx) {
	var n = await Graph.indexRemove(ctx.request.body, ctx.request.params.rid, ctx.request.user.rid)
	ctx.body = n
})

router.get('/api/prompts', async function (ctx) {
	var n = await Graph.getPrompts(ctx.request.user.id)
	ctx.body = n
})

router.post('/api/prompts', async function (ctx) {
	var n = await Graph.savePrompt(ctx.request.body, ctx.request.user.id)
	ctx.body = n
})

router.post('/api/entities/:rid/vertex/:vid', async function (ctx) {
	var n = await Graph.linkEntity(ctx.request.params.rid, ctx.request.params.vid, ctx.request.user.rid)
	ctx.body = n
})

router.delete('/api/entities/:rid/vertex/:vid', async function (ctx) {
	var n = await Graph.unLinkEntity(ctx.request.params.rid, ctx.request.params.vid, ctx.request.user.rid)
	ctx.body = n
})


router.post('/api/entities', async function (ctx) {
	var n = await Graph.createEntity(ctx.request.body, ctx.request.user.rid)
	ctx.body = n
})

router.get('/api/entities', async function (ctx) {
	var n = await Graph.getEntityTypes(ctx.request.user.rid)
	ctx.body = n
})

router.get('/api/entities/types', async function (ctx) {
	var n = await Graph.getEntityTypeSchema(ctx.request.user.rid)
	ctx.body = n
})

router.get('/api/entities/types/:type', async function (ctx) {
	var n = await Graph.getEntitiesByType(ctx.request.params.type)
	ctx.body = n
})

router.get('/api/entities/items', async function (ctx) {
	var n = await Graph.getEntityItems(ctx.request.query.entities, ctx.request.user.rid)
	ctx.body = n
})

router.get('/api/entities/:rid', async function (ctx) {
	var n = await Graph.getEntity(ctx.request.params.rid)
	ctx.body = n
})



// router.get('/api/tags', async function (ctx) {
// 	var n = await Graph.getTags(ctx.request.headers[AUTH_HEADER])
// 	ctx.body = n
// })

// router.post('/api/tags', async function (ctx) {
// 	var n = await Graph.createTag(ctx.request.body.label, ctx.request.headers[AUTH_HEADER])
// 	ctx.body = n
// })

// data source

router.post('/api/projects/:rid/sources', async function (ctx) {
	var source = await Graph.createSource(ctx.request.params.rid, ctx.request.body, ctx.request.user.rid)
	const source_rid = source['@rid']
	// DATA_DIR + '/projects/' + project_rid + '/files/' + source_rid
	const source_path = path.join(DATA_DIR, 'projects', media.rid2path(ctx.request.params.rid), 'files', media.rid2path(source_rid))
	source.path = source_path
	await media.createProcessDir(source.path)
	await Graph.setNodeAttribute(source['@rid'], {key: 'path', value: source.path})
	// make request to nextcloud queu
	var get_dirs = {
		id:"md-nextcloud",
		task:"info",
		file:source,
		params: {url:`${source.url}`, task:"info"},
		info:"",
		userId: ctx.request.user.id
	}
	nats.publish(get_dirs.id, JSON.stringify(get_dirs))
	ctx.body = source

})

// upload

router.post('/api/projects/:rid/upload/:set?', upload.single('file'), async function (ctx)  {

	var response = await Graph.getProject_old(ctx.request.params.rid, ctx.request.headers.mail)
	if (response.result.length == 0) throw('Project not found')

	project_rid = response.result[0]["@rid"]
	file_type = await media.detectType(ctx)
	
	if(file_type == 'text') {
		ctx.file.info = await media.getTextDescription(ctx.file.path)
	}

	var filegraph = await Graph.createOriginalFileNode(project_rid, ctx, file_type, ctx.params.set, DATA_DIR)
	const file_info = await media.uploadFile(ctx.file.path, filegraph, DATA_DIR)
	if(file_info) await Graph.setNodeAttribute(filegraph['@rid'], {key: 'metadata', value: file_info})

	// ************** EXIF FIX **************
	// if file has EXIF orientation, then we need to rotate it
	// if(file_info && file_info.rotate) {

	// 	var rotatedata = {
	// 		id:"md-imaginary",
	// 		task:"rotate",
	// 		params: {rotate:`${file_info.rotate}`, stripmeta:'true', task:"rotate"},
	// 		info:"I auto-rotated image based on EXIF orientation.",
	// 	}
	// 	fetch(`http://localhost:3000/api/queue/md-imaginary/files/${filegraph['@rid'].replace('#','')}`, {
	// 		method: 'POST',
	// 		headers: {
	// 			'Content-Type': 'application/json'
	// 		},
	// 		body: JSON.stringify(rotatedata)
	// 	})
	// }

	// ************** EXIF FIX ends**************

	// send to indexer queue if text
	if (file_type == 'text') {
		var index_msg = {
			id:'solr', 
			task: 'index', 
			file: filegraph, 
			userId: ctx.request.user.id, 
			target: filegraph['@rid']
		}
		console.log('publishing index message', JSON.stringify(index_msg, null, 2))
		nats.publish(index_msg.id, JSON.stringify(index_msg))					
	}

	// send to thumbnailer queue if image or PDF
	if(file_type == 'image') {
		var data = {file: filegraph}
		data.userId = ctx.headers[AUTH_HEADER]
		data.target = filegraph['@rid']
		data.task = 'thumbnail'
		data.params = {width: 800, type: 'jpeg'}
		data.id = 'md-thumbnailer'
		nats.publish('md-thumbnailer', JSON.stringify(data))	

	} else if(file_type == 'pdf') {
		var data = {file: filegraph}
		data.userId = ctx.headers[AUTH_HEADER]
		data.target = filegraph['@rid']
		data.task = 'pdf2images'
		data.params = {
			firstPageToConvert: '1',
			lastPageToConvert: '1',
			resolutionXYAxis: '80',
			task: 'pdf2images'
		},
		data.role = 'thumbnail'
		data.id = 'md-poppler'
		nats.publish('md-poppler', JSON.stringify(data))
	}

	if(ctx.headers[AUTH_HEADER]) {
		console.log('add file node to visual graph')
		var wsdata = {
			command: 'add', 
			type: file_type, 
			node: filegraph,
			set: ctx.params.set
		}
		console.log(wsdata)
		send2UI(ctx.headers[AUTH_HEADER], wsdata)
	}

	ctx.body = filegraph

})


// get source file of a file
router.get('/api/files/:file_rid/source', async function (ctx) {
	console.log('getting source')
	try {
		var source = await Graph.getFileSource(ctx.request.params.file_rid)
		console.log(source)
		if(!source) {
			ctx.status = 404
			ctx.body = {}
		}

		var file_metadata = await Graph.getUserFileMetadata(source['@rid'], ctx.request.headers.mail)
		const src = fs.createReadStream(path.join(DATA_DIR, file_metadata.path))
		if(file_metadata.type =='pdf') {
			ctx.set('Content-Disposition', `inline; filename=${file_metadata.label}`);
			ctx.set('Content-Type', 'application/pdf');
		} else if(file_metadata.type =='image') {
			ctx.set('Content-Type', 'image/png');
		} else if(file_metadata.type =='text') {
			ctx.set('Content-Type', 'text/plain; charset=utf-8');
		} else if(file_metadata.type =='data') {
			ctx.set('Content-Type', 'text/plain; charset=utf-8');
		} else {
			ctx.set('Content-Disposition', `attachment; filename=${file_metadata.label}`);
		}
	   ctx.body = src
	} catch(e) {
		ctx.status = 403
		ctx.body = {}
	}

})

router.get('/api/files/:file_rid', async function (ctx) {
	try {
		var file_metadata = await Graph.getUserFileMetadata(Graph.sanitizeRID(ctx.request.params.file_rid), ctx.request.headers.mail)

		const src = fs.createReadStream(file_metadata.path)
		if(file_metadata.type =='pdf') {
			ctx.set('Content-Disposition', `inline; filename=${file_metadata.label}`);
			ctx.set('Content-Type', 'application/pdf');
		} else if(file_metadata.type =='image') {
			ctx.set('Content-Type', 'image/png');
		} else if(file_metadata.type =='text') {
			ctx.set('Content-Type', 'text/plain; charset=utf-8');
		} else if(file_metadata.type =='data') {
			ctx.set('Content-Type', 'text/plain; charset=utf-8');
		} else {
			ctx.set('Content-Disposition', `attachment; filename=${file_metadata.label}`);
		}
	   ctx.body = src
	} catch(e) {
		ctx.status = 403
		ctx.body = {}
	}

})


router.get('/api/thumbnails/(.*)', async function (ctx) {

	const src = await media.getThumbnail(ctx.request.path.replace('/api/thumbnails/','./'))
	ctx.set('Content-Type', 'image/jpeg');
   	ctx.body = src
})

router.get('/api/process/(.*)', async function (ctx) {

    const src = fs.createReadStream(path.join(DATA_DIR, ctx.request.path.replace('/api/process/','/'), 'params.json'));
	ctx.set('Content-Type', 'application/json');
    ctx.body = src
})

// project

router.post('/api/projects', async function (ctx) {
	var me = await Graph.myId(ctx.request.headers.mail)
	if(!ctx.request.body.label) throw new Error('label required')
	var n = await Graph.createProject(ctx.request.body, me.rid)

	await media.createProjectDir(n, DATA_DIR)
	ctx.body = n
})


router.post('/api/projects/:rid/sets', async function (ctx) {
	var me = await Graph.myId(ctx.request.headers.mail)
	console.log('creating set')
	var set = await Graph.createSet(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.body, me.rid)
	console.log('Set created')
	console.log(set)
	ctx.body = set
})

router.get('/api/projects', async function (ctx) {
	var n = await Graph.getProjects(ctx.request.headers.mail, DATA_DIR)
	ctx.body = n
})


router.get('/api/projects/:rid', async function (ctx) {
	var n = await Graph.getProject_backup(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.headers.mail)
	ctx.body = n
})

router.delete('/api/projects/:rid', async function (ctx) {
	var n = await Graph.deleteProject(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.headers.mail, nats)
	ctx.body = n
})

router.get('/api/projects/:rid/files', async function (ctx) {
	var n = await Graph.getProjectFiles(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.headers.mail)
	ctx.body = n.result
})

// services

// register consumer
router.post('/api/services/:service/consumer/:id', async function (ctx) {
	var response = await services.addConsumer(ctx.request.params.service, ctx.request.params.id)
	ctx.body = response
})

// unregister consumer
router.delete('/api/services/:service/consumer/:id', async function (ctx) {
	var adapter = await services.getServiceAdapterByName(ctx.request.params.service)
	var response = await services.removeConsumer(ctx.request.params.service, ctx.request.params.id)
	await nomad.stopService(adapter)
	ctx.body = response
})

// router.post('/api/services', async function (ctx) {
// 	await queue.registerService(ctx.request.body)
// 	ctx.body = ctx.request.body
// })

router.get('/api/services', async function (ctx) {
	ctx.body = await services.getServices()
})

router.post('/api/services/reload', async function (ctx) {
	// reload all service adapters
	try {
		await services.loadServiceAdapters()
		ctx.body = {status: 'ok', service:services}
	} catch(e) {
		console.log(e)
		ctx.status = 500
		ctx.body = {error:e}
	}
})

// get services for certain node
router.get('/api/services/files/:rid', async function (ctx) {
	var file = await Graph.getUserFileMetadata(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.headers.mail)
	var prompts = await Graph.getPrompts(ctx.request.user.id)

	if(file) {
		var service_list = await services.getServicesForNode(file, ctx.request.query.filter, ctx.request.user, prompts)
		ctx.body = service_list
	} else {
		ctx.body = []
	}
})


router.post('/api/notify', async function (ctx) {
	//if(ctx.request.user.access == 'admin') {
		var n = await Graph.index()
		ctx.body = n
	//}
})
// pipeline queue for single file
router.post('/api/pipeline/files/:file_rid/:roi?', async function (ctx) {

	const clean_rid = Graph.sanitizeRID(ctx.request.params.file_rid)
	var clean_roi = ''
	if(ctx.request.params.roi) clean_roi = Graph.sanitizeRID(ctx.request.params.roi)
	let messages = []
	
	var requests = await Graph.createRequestsFromPipeline(ctx.request.body, clean_rid, clean_roi)
	
	for(var request of requests) {
		var service = services.getServiceAdapterByName(request.params.topic)
		messages = await Graph.createQueueMessages(service, request.body, ctx.request.params.file_rid, ctx.request.headers.mail)
		for(var msg of messages) {
			var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process, image:API_URL + 'icons/wait.gif'}
			send2UI(ctx.request.headers.mail, wsdata)
			nats.publish(request.params.topic, JSON.stringify(msg))
		}
	}

	ctx.body = messages

})

router.get('/api/queue/:topic/status', async function (ctx) {
	const topic = ctx.request.params.topic
	const status = await nats.getQueueStatus(topic)
	ctx.body = status
})

// single queue
router.post('/api/queue/:topic/files/:file_rid/:roi?', async function (ctx) {

	try {
		const topic = ctx.request.params.topic
		const service = services.getServiceAdapterByName(topic)
		var messages = await Graph.createQueueMessages(service, ctx.request.body, ctx.request.params.file_rid, ctx.request.headers.mail, ctx.request.params.roi)
		const queue = Graph.getQueueName(service, ctx.request, topic)

		// add Process node to UI
		if(messages.length > 0) {
			var msg = messages[0]
			if(ctx.request.params.roi) {
				var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process}
			} else {
				var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process, image:API_URL + 'icons/wait.gif'}
			}
			// there is output Set node, then add it too to UI
			if(msg.set_node) {
				wsdata.set_node = msg.set_node
			}
			send2UI(ctx.request.headers.mail, wsdata)
		}

		for(var msg of messages) {	

			// send message to queue
			nats.publish(queue, JSON.stringify(msg))
		}

		ctx.body = ctx.request.params.file_rid

	} catch(e) {
		console.log('Queue failed!', e)
	}
})



// set queue
router.post('/api/queue/:topic/sets/:set_rid', async function (ctx) {

	const topic = ctx.request.params.topic
	const set_rid = Graph.sanitizeRID(ctx.request.params.set_rid)
	try {
		console.log('****************** set queue ******************')
		const service = services.getServiceAdapterByName(topic)
		var msg = JSON.parse(JSON.stringify(ctx.request.body))
		var task_name = ''
		// LLM services have tasks defined in prompts
		if(service.external_tasks) {
			msg.external = 'yes'
			msg.info = ctx.request.body.info
			msg.params = ctx.request.body.system_params
			task_name = ctx.request.body.name	
		} else {
			task_name = service.tasks[ctx.request.body.task].name
		}

		var set_metadata = await Graph.getUserFileMetadata(set_rid, ctx.request.headers.mail)
		var nodes = await Graph.createSetProcessNode(task_name, service, ctx.request.body, set_metadata, ctx.request.headers.mail)
		
		// add node to UI
		var wsdata = {command: 'add', type: 'process', target: set_rid, node:nodes.process, set_node:nodes.set,image:API_URL + 'icons/wait.gif'}
		send2UI(ctx.request.headers.mail, wsdata)

		// next we create process nodes for each file in set and put them in queue
		var set_files = await Graph.getSetFiles(set_rid, ctx.request.headers.mail, {limit:'500'})
		
		for(var file of set_files.files) {
			var file_metadata = await Graph.getUserFileMetadata(file['@rid'], ctx.request.headers.mail)
			console.log(file_metadata)
			var processNode = await Graph.createProcessNode(task_name, service, ctx.request.body, file_metadata, ctx.request.headers.mail, set_rid)
			await media.createProcessDir(processNode.path)

			// do we need info about "parent" file? (when processing osd.json for example)
			if(service.tasks[ctx.request.body.task]?.source == 'source_file') {
				const source = await Graph.getFileSource(file['@rid'])
				console.log('source: ', source)
				if(source) {
					const source_metadata = await Graph.getUserFileMetadata(source['@rid'], ctx.request.headers.mail)
					msg.source = source_metadata
				}
			}

			await media.writeJSON(ctx.request.body, 'params.json', path.join(path.dirname(processNode.path)))

			msg.process = processNode
			msg.file = file_metadata
			msg.target = file_metadata['@rid']
			msg.userId = ctx.request.headers[AUTH_HEADER]
			msg.output_set = nodes.set['@rid']  // link file to output Set
			nats.publish(topic + '_batch', JSON.stringify(msg))
	
		}
		
		ctx.body = ctx.request.params.set_rid

	} catch(e) {
		console.log('Queue failed!', e)
	}
})

router.post('/api/queue/:topic/sources/:rid', async function (ctx) {

	const topic = ctx.request.params.topic
	const source_rid = Graph.sanitizeRID(ctx.request.params.rid)
	try {
		const service = services.getServiceAdapterByName(topic)
		var task_name = service.tasks[ctx.request.body.task].name
		var source_metadata = await Graph.getUserFileMetadata(source_rid, ctx.request.headers.mail)
		var nodes = await Graph.createSetProcessNode(task_name, service, ctx.request.body, source_metadata, ctx.request.headers.mail)
		
		//await media.writeJSON(ctx.request.body, 'params.json', path.join(DATA_DIR, path.dirname(processNode.path)))
		// add node to UI
		var wsdata = {command: 'add', type: 'process', target: '#'+source_rid, node:nodes.process, set_node:nodes.set,image:API_URL + 'icons/wait.gif'}
		send2UI(ctx.request.headers.mail, wsdata)
		console.log('source process..')

		// // next we create process nodes for each file in set and put them in queue
		var source_files = await Graph.getSourceFiles(source_rid, ctx.request.headers.mail)
		
		for(var file of source_files) {
			console.log('*************')
			console.log(file)

			var msg = JSON.parse(JSON.stringify(ctx.request.body))
			msg.task = ctx.request.body.task
			msg.process = nodes.process
			msg.source = source_metadata
			msg.file = file
			//msg.target = file_metadata['@rid']
			msg.userId = ctx.request.headers[AUTH_HEADER]
			msg.output_set = nodes.set['@rid']  // link file to output Set
			console.log(msg)
			nats.publish(topic + '_batch', JSON.stringify(msg))
	
		}
		
		ctx.body = ctx.request.params.rid

	} catch(e) {
		console.log('Queue failed!', e)
	}
})


// NOMAD
// nomad endpoints has different authorisation (auth header)

router.get('/api/nomad/status', async function (ctx) {
	ctx.body = await nomad.getStatus()

})


// endpoint for consumer apps for starting their work horses
router.post('/api/nomad/service/:name', async function (ctx) {
	// reload all service adapters
	//await services.loadServiceAdapters()
	var adapter = await services.getServiceAdapterByName(ctx.request.params.name)
	try {
		var service = await nomad.createService(adapter)
		ctx.body = service
	} catch(e) {
		console.log(e)
		ctx.status = 500
		ctx.body = {error:e}
	}
})

router.delete('/api/nomad/service/:name', async function (ctx) {
	// reload all service adapters
	//await services.loadServiceAdapters()
	var adapter = await services.getServiceAdapterByName(ctx.request.params.name)
	try {
		var service = await nomad.stopService(adapter)
		ctx.body = service
	} catch(e) {
		console.log(e)
		ctx.status = 500
		ctx.body = {error:e}
	}
})


// endpoint for consumer apps to get file to be processed
router.get('/api/nomad/files/:file_rid', async function (ctx) {
	const clean_rid = Graph.sanitizeRID(ctx.request.params.file_rid)
	var file_metadata = await Graph.getUserFileMetadata(clean_rid, ctx.request.headers.mail)
    const src = fs.createReadStream(path.join(DATA_DIR, file_metadata.path));
	if(file_metadata.type =='pdf') {
		ctx.set('Content-Disposition', `inline; filename=${file_metadata.label}`);
		ctx.set('Content-Type', 'application/pdf');
	} else if(file_metadata.type =='image') {
		ctx.set('Content-Type', 'image/png');
	} else if(file_metadata.type =='text') {
		ctx.set('Content-Type', 'text/plain; charset=utf-8');
	} else if(file_metadata.type =='data') {
		ctx.set('Content-Type', 'text/plain; charset=utf-8');
	} else {
		ctx.set('Content-Disposition', `attachment; filename=${file_metadata.label}`);
	}
   ctx.body = src
})



// endpoint for consumer apps to submit processing result files
router.post('/api/nomad/process/files', upload.fields([
    { name: 'request', maxCount: 1 },
    { name: 'content', maxCount: 1 }
]), async function (ctx) {

	console.log('save process file call...')
	let infoFilepath, contentFilepath = null
	let message = {}
	try {
		if(ctx.request.files['request']) {
			infoFilepath = ctx.request.files['request'][0].path
	
			var info = await fse.readFile(infoFilepath)
			message = JSON.parse(info)
			console.log(message)
		}
	
		if(ctx.request.files['content']) {
			contentFilepath = ctx.request.files['content'][0].path
	
		}
	
		// check if this is thumbnail ('role' is for PDF thumbnail via Poppler)
		if(message.id === 'md-thumbnailer' || message.role === 'thumbnail') {

			var filepath = message.file.path
			const base_path = path.dirname(filepath)
			const filename = message.thumb_name || 'preview.jpg'

			try {
				console.log('saving thumbnail to', base_path, filename)
				await media.saveThumbnail(contentFilepath, base_path, filename)
				if(filename == 'thumbnail.jpg' || message.role === 'thumbnail') {
					console.log('sending thumbnail WS', filename)
					var wsdata = {
						command: 'update', 
						type: 'image',
						target: message.file['@rid']
					}
					// direct link to thumbnail
					wsdata.image = API_URL + 'api/thumbnails/' + base_path
					await send2UI(message.userId, wsdata)
				}
			} catch(e) {
				throw('Could not move file!' + e.message)
			}

		} else if(infoFilepath && contentFilepath) {

			
			// if this is "info" task then we save metadata to file node
			if(message.task == 'info') {
				try {
					var info = await fse.readFile(contentFilepath)
					var info_json = JSON.parse(info)
					if (message.file.type == 'image') {
						// image info
						await Graph.setNodeAttribute(message.file['@rid'], {key: 'metadata', value: {width:info_json.width, height:info_json.height}})
					} else {
						// nextcloud directory info
						await Graph.setNodeAttribute(message.file['@rid'], {key: 'metadata', value: info_json})
						var filepath = message.file.path
						const base_path = path.dirname(filepath)
						await media.uploadFile(contentFilepath, {path: message.file.path + '/source.json'})
						var wsdata = {
							command: 'update', 
							type: message.file.type, 
							target: message.file['@rid'], 
							count:info_json.count,
							description: info_json.size + ' MB'
						}
						send2UI(message.userId, wsdata)
					}
				} catch(e) {
					console.log('file metadata failed!', e.message)
				}
				// if this is response file then we save it to the process node directory and not in the graph
			} else if (message.file.type == 'response') {
				var process_rid = message.process['@rid']
				var process_dir = path.dirname(message.process.path)
				await media.uploadFile(contentFilepath, {path: process_dir + '/response.json'})
				await Graph.setNodeAttribute(process_rid, {key: 'response', value: message.file.path})
				
				// else save content to processFileNode
			} else {
				var info = ''
				// for text nodes we create a description from the content of the file
				if (message.file.type == 'text' || message.file.type == 'osd.json' || message.file.type == 'ner.json') {
					info = await media.getTextDescription(contentFilepath, message.file.type)

					// EXPERIMENTAL: auto-tagger
					if(message.file.type == 'ner.json') {
						//const auto_tagger_msg = await Graph.autoTagger(contentFilepath, message)
					}
				}

				const process_rid = message.process['@rid']	
				const fileNode = await Graph.createProcessFileNode(process_rid, message, '', info)
	
				await media.uploadFile(contentFilepath, fileNode, DATA_DIR)
	
				// for images and pdf files we create normal thumbnails
				if(message.file.type == 'image' || message.file.type == 'pdf') {
					var th = {
						id:'md-thumbnailer', 
						task: 'thumbnail', 
						file: fileNode, 
						userId: message.userId, 
						target: fileNode['@rid']
					}
					th.params = {width: 800, type: 'jpeg'}
					nats.publish(th.id, JSON.stringify(th))
	
					// image resolution info
					if(message.file.type == 'image') {
						var info = {
							id:'md-imaginary', 
							task: 'info', 
							file: fileNode, 
							userId: message.userId, 
							target: fileNode['@rid'],
							params:{task:'info'}
						}
						//console.log(info)
						nats.publish(info.id, JSON.stringify(info))
						console.log(`published info task\nservice: ${info.id}\ntarget: ${info.target}`)
					}
				} 

				// send to indexer queue if text
				if (message.file.type == 'text') {
					var index_msg = {
						id:'solr', 
						task: 'index', 
						file: fileNode, 
						userId: message.userId, 
						target: fileNode['@rid']
					}
					console.log(`published info task\nservice: ${info.id}\ntarget: ${info.target}`)
					nats.publish(index_msg.id, JSON.stringify(index_msg))					
				}

				// create ROIs for ner.json and human.json
				if(message.file.type == 'ner.json' || message.file.type == 'human.json') {
					console.log('ner file detected')
					await Graph.createROIsFromJSON(process_rid, message, fileNode)
					//console.log('ner file processed')
					//path.join(data_dir, filegraph.path)
				}

				// update set file count or add file to visual graph
				if(message.userId) {
					// update set's file count if file is part of set
					if(message.output_set) {
						var count = await Graph.updateFileCount(message.output_set) // TODO: this might be slow
						var wsdata = {
							command: 'update', 
							type: 'set',
							target: message.output_set,
							count: count
						}
					// otherwise add node to visual graph
					} else {
						var wsdata = {
							command: 'add', 
							type: message.file.type, 
							target: process_rid, 
							node:fileNode
					}
		
					}
					//console.log(wsdata)
					send2UI(message.userId, wsdata)
				}


				// finally check if there is pipeline in message
				if(message.pipeline && message.pipeline.length > 0) {
					// if file_count and file_total are integers and they are equal, then call pipeline
					if(Number.isInteger(message.file_count) && Number.isInteger(message.file_total) && message.file_total == message.file_count) {
						console.log('\n\n\n\n--------------PIPELINE detected')
						console.log(message.file_total, message.file_count)
						console.log('pipeline target: ', fileNode['@rid'])
						console.log(message.pipeline)

						let messages = []
	
						var requests = await Graph.createRequestsFromPipeline(message, fileNode['@rid'].replace('#', ''))
						
						for(var request of requests) {
							var service = services.getServiceAdapterByName(request.params.topic)
							messages = await Graph.createQueueMessages(service, request.body, fileNode['@rid'].replace('#', ''),ctx.request.headers[AUTH_HEADER])
							for(var msg of messages) {
								var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process, image:API_URL + 'icons/wait.gif'}
								send2UI(ctx.request.headers.mail, wsdata)
								nats.publish(request.params.topic, JSON.stringify(msg))
							}
						}

					}
		
				}

			}

		// something went wrong in file processing	
		} else {
			console.log(infoFilepath, contentFilepath)
			console.log('PROCESS FAILED!')
			console.log(ctx.request.body)
		}
	} catch(e) {
		console.log(e)
	}


	ctx.body = 's'
})


// endpoint for process errors
router.post('/api/nomad/process/files/error', async function (ctx) {
	if(ctx.request.body && ctx.request.body.error) {
		var error = ctx.request.body.error
		if(ctx.request.body.message) {
			var message = ctx.request.body.message
			var target = message.target

			if(message.task == 'index') {

			} else {
				if(message.process && message.process['@rid']) target = message.process['@rid']
				var wsdata = {
					command: 'update', 
					target: target,
					error: 'error'
	
				}
				// write error to node, send update to UI and index error
				var targetNode = target
				if(message.process && message.process['@rid']) targetNode = message.process['@rid']
				await Graph.setNodeAttribute(targetNode, {key: 'node_error', value: 'error'})
				console.log('ERROR')
				console.log(message)
				await send2UI(message.userId, wsdata)
	
				var index_msg = [{
					type: 'error',
					id: target + '_error', 
					error_node: target, 
					error: JSON.stringify(error), 
					message: JSON.stringify(message), 
					owner: message.userId
				}]
				await web.indexDocuments(index_msg)		
			}
		
		
		}

	}
	if(error.status == 'created_duplicate_source') {
		
		console.log('DUPLICATE')

	}
	ctx.body = []

})

// get node error
router.get('/api/errors/:rid', async function (ctx) {

	var n = await web.getError(Graph.sanitizeRID(ctx.request.params.rid))
	ctx.body = n
})

router.post('/api/layouts', async function (ctx) {
	//var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	var n = await positions.setLayout(ctx.request.body)
	ctx.body = n
})

router.get('/api/layouts/:rid', async function (ctx) {
	//var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	var n = await positions.getLayoutByTarget(ctx.request.headers[AUTH_HEADER])
	ctx.body = n
})


router.get('/api/sets/:rid/files', async function (ctx) {
	var n = await Graph.getSetFiles(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.headers[AUTH_HEADER], ctx.request.query)
	ctx.body = n
})


router.get('/api/sets/:rid/files/zip', async function (ctx) {
    try {
        // Get the set files with proper authentication
		const set_rid = Graph.sanitizeRID(ctx.request.params.rid)
        var n = await Graph.getSetFiles(set_rid, ctx.request.headers[AUTH_HEADER], ctx.request.query)
        
        if (!n || !n.files || n.files.length === 0) {
            ctx.status = 404	
            ctx.body = 'No files found in set'
            return
        }

        var fileList = []
        n.files.forEach(file => {
            if (file.path) {
                fileList.push(file.path)
            }
        })

        if (fileList.length === 0) {
            ctx.status = 404
            ctx.body = 'No valid file paths found'
            return
        }

        // Create and stream the zip file
        await media.createZipAndStream(fileList, ctx, set_rid)
        
    } catch (err) {
        console.error('Error creating zip:', err)
        ctx.status = 500
        ctx.body = 'Error creating zip file'
    }
})




router.get('/api/styles', async function (ctx) {
	var n = await styles.getStyle()
	ctx.body = n
})


router.post('/api/query', async function (ctx) {
	var n = await Graph.query(ctx.request.body)
	ctx.body = n
})

router.get('/api/schemas', async function (ctx) {
	var n = await schema.getSchemaTypes()
	ctx.body = n
})

router.get('/api/tags', async function (ctx) {
	var n = await Graph.getTags()
	ctx.body = n
})

router.get('/api/queries', async function (ctx) {
	var n = await Graph.getQueries()
	ctx.body = n
})

router.get('/api/schemas/:schema', async function (ctx) {
	var n = await schema.getSchema(ctx.request.params.schema)
	ctx.body = n
})

// GRAPH API

router.get('/api/graph/traverse/:rid/:direction', async function (ctx) {

	try {
		var traverse = await Graph.traverse(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.params.direction, ctx.request.user.rid)
		console.log(traverse)
		if(!traverse) {
			console.log('ei muka ole')
			ctx.status = 404
			ctx.body = {}
		}
		ctx.body = traverse
	} catch(e) {
		throw(e)
	}
})


router.post('/api/graph/query/me', async function (ctx) {
	var n = await Graph.myGraph(user, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/query', async function (ctx) {
	var n = await Graph.getGraph(ctx.request.body, ctx)
	ctx.body = n
})

router.post('/api/graph/vertices', async function (ctx) {
	var type = ctx.request.body.type
	var n = await Graph.create(type, ctx.request.body)
	console.log(n)
	var node = n.result[0]
	ctx.body = n
})


router.get('/api/graph/vertices/:rid', async function (ctx) {
	//var n = await Graph.getDataWithSchema(ctx.request.params.rid)
	var n = await Graph.getNode(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.user.rid)
	ctx.body = n
})

router.post('/api/graph/vertices/:rid', async function (ctx) {
	var clean_rid = Graph.sanitizeRID(ctx.request.params.rid)
	var n = await Graph.setNodeAttribute(clean_rid, ctx.request.body)
	if(ctx.request.body.key && ctx.request.body.key == 'description') {
		var wsdata = {
			command: 'update', 
			target: clean_rid, 
			description: ctx.request.body.value
		}
		send2UI(ctx.request.user.id, wsdata)	
	}
	ctx.body = n
})

router.delete('/api/graph/vertices/:rid', async function (ctx) {
	var n = await Graph.deleteNode(Graph.sanitizeRID(ctx.request.params.rid), nats)
	console.log(n)
	if(n.path) {
		// TODO: delete path
		console.log(n.path)
	}
	ctx.body = n
})

router.post('/api/graph/vertices/:rid/rois', async function (ctx) {
	var n = await Graph.createROIs(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.body)
	var wsdata = {command: 'update', type: 'image', target: '#'+ctx.request.params.rid, roi_count: n}
	send2UI(ctx.request.headers.mail, wsdata)
	ctx.body = n
})

router.post('/api/graph/edges', async function (ctx) {
	var n = await Graph.connect(
		ctx.request.body.from,
		ctx.request.body.relation,
		ctx.request.body.to)
	ctx.body = n
})

router.delete('/api/graph/edges/:rid', async function (ctx) {
	var n = await Graph.deleteEdge(Graph.sanitizeRID(ctx.request.params.rid))
	ctx.body = n
})

router.post('/api/graph/edges/:rid', async function (ctx) {
	var n = await Graph.setEdgeAttribute(Graph.sanitizeRID(ctx.request.params.rid), ctx.request.body)
	ctx.body = n
})

// router.post('/api/graph/edges/connect/me', async function (ctx) {
// 	var me = await Graph.myId(user)
// 	ctx.request.body.from = me
// 	var n = await Graph.connect(ctx.request.body)
// 	ctx.body = n
// })

// router.post('/api/graph/edges/unconnect/me', async function (ctx) {
// 	var me = await Graph.myId(user)
// 	console.log(me)
// 	ctx.request.body.from = me
// 	var n = await Graph.unconnect(ctx.request.body)
// 	ctx.body = n
// })

router.get('/api/documents', async function (ctx) {
	var n = await Graph.getListByType(ctx.request.query)
	ctx.body = n
})

router.get('/api/documents/:rid', async function (ctx) {
	var clean_rid = Graph.sanitizeRID(ctx.request.params.rid)
	var n = await Graph.getNodeAttributes(clean_rid)
	var entities = await Graph.getLinkedEntities(clean_rid, ctx.request.user.rid)
	var rois = await Graph.getROIs(clean_rid)
	if(n.result && n.result.length) {
		n.result[0].rois = rois
		n.result[0].entities = entities
		ctx.body = n.result[0]
	} else {
		ctx.status = 404; 
		ctx.body = {}
	}
})


async function send2UI(userId, data) {
	const ws = connections.get(userId)
	if(ws)
		await ws.send(JSON.stringify(data))
	else
		console.log('WS connection not found!', userId)

}


app.use(router.routes());


app.use(async (ctx, next) => {
    

    // Check if ctx.body is not set and the request method is GET
    if (!ctx.body && ctx.method === 'GET') {
        // Send index.html as the default response
        const indexStream = fs.createReadStream(path.join(__dirname, 'public', 'index.html'));
        ctx.type = 'text/html';
        ctx.body = indexStream;
    } else {
		await next();
	}
});


var set_port = process.env.PORT || 8200
var server = app.listen(set_port, function () {
   var host = server.address().address
   var port = server.address().port
   server.requestTimeout = 0 // https://github.com/b3nsn0w/koa-easy-ws/issues/36
   server.headersTimeout = 0

   console.log('MessyDesk running at http://%s:%s', host, port)
})
