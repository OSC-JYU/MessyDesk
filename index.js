const Koa			= require('koa');
const Router		= require('koa-router');
const bodyParser	= require('koa-body');
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

const media 		= require('./media.js');
const schema 		= require('./schema.js');
const styles 		= require('./styles.js');
const services 		= require('./services.js');
const nomad 		= require('./nomad.js');
let nats
let positions

const connections = new Map();

(async () => {
	console.log('initing...')
	// migration to ES6 in progress...
	const {queue} = await import('./queue.mjs');
	const {layout} = await import('./layouts.mjs');
	nats = queue
	positions = layout
	await nomad.getStatus()
	await services.loadServiceAdapters()
	// create main stream and all consumers in NATS
	await nats.init(services.getServices())
	// start thumbnailer and Poppler services
	//var thumb = await services.getServiceAdapterByName('thumbnailer')
	//await nomad.createService(thumb)
	//var ima = await services.getServiceAdapterByName('md-imaginary')
	//await nomad.createService(ima)
	await Graph.initDB()

})();

process.on( 'SIGINT', async function() {
	console.log( "\nGracefully shutting down from SIGINT (Ctrl-C)" );
	// we may want to shutdown nomad jobs if we are developing locally
	//await nomad.stopService('MD-thumbnailer')
	//await nomad.stopService('MD-imaginary')
	process.exit( );
  })


const AUTH_HEADER = 'mail'

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
var visitors = []


//var app				= new Koa();
//const app = websockify(new Koa());
const app = new Koa();
var router			= new Router();

app.use(websocket())
app.use(json({ pretty: true, param: 'pretty' }))
app.use(bodyParser());
app.use(serve(path.join(__dirname, '/public')))


// check that user has rights to use app
app.use(async function handleError(context, next) {
	if(process.env.MODE === 'development') {
		context.request.headers[AUTH_HEADER] = "local.user@localhost" // dummy shibboleth
		if(process.env.DEV_USER) 
			context.request.headers[AUTH_HEADER] = process.env.DEV_USER
	}
	await next()
});

const upload = multer({
	dest: './uploads/',
	fileSize: 1048576
});


// catch errors in routes
app.use(async function handleError(context, next) {

	try {
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
  
	  // Store WebSocket connection with user ID
	  connections.set(userId, ws);
	  ws.on('message', function message(data) {
		//console.log('received: %s', data);
		positions.updateProjectNodePosition(JSON.parse(data))
		//ws.send(JSON.stringify({target:'#267:25', label:'joo'}))
		
	  });
	}
  })

router.get('/api', function (ctx) {
	ctx.body = 'MessyDesk API'
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
	await sendWS(ctx.headers[AUTH_HEADER], {msg: 'test'})
	ctx.body = 'message send'

})



router.get('/api/me', async function (ctx) {
	// if(process.env.CREATE_USERS_ON_THE_FLY) {
	// 	// keep list of visitors so that we do not create double users on sequential requests
	// 	if(!visitors.includes(ctx.request.headers[AUTH_HEADER])) {
	// 		visitors.push(ctx.request.headers[AUTH_HEADER])
	// 		await Graph.checkMe(ctx.request.headers[AUTH_HEADER])
	// 	}
	// }
	var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	ctx.body = {rid: me.rid, admin: me.admin, group:me.group, access:me.access, id: ctx.request.headers[AUTH_HEADER], mode:process.env.MODE ? process.env.MODE : 'production' }
})

router.get('/api/stall', async function (ctx) {

})


// upload

router.post('/api/projects/:rid/upload', upload.single('file'), async function (ctx)  {

	var response = await Graph.getProject_old(ctx.request.params.rid, ctx.request.headers.mail)
	if (response.result.length == 0) throw('Project not found')

	project_rid = response.result[0]["@rid"]
	file_type = await media.detectType(ctx)
	var filegraph = await Graph.createProjectFileGraph(project_rid, ctx, file_type)
	await media.uploadFile(ctx.file.path, filegraph)
	var data = {file: filegraph.result[0]}
	data.userId = ctx.headers[AUTH_HEADER]
	data.target = filegraph.result[0]['@rid']
	data.task = 'thumbnail'
	data.params = {width: 800, type: 'jpeg'}
	data.id = 'thumbnailer'

	// send to thumbnailer queue 
	nats.publish(data.id, JSON.stringify(data))

	ctx.body = filegraph

})


router.get('/api/files/:file_rid', async function (ctx) {
	var file_metadata = await Graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
    const src = fs.createReadStream(file_metadata.path);
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


router.get('/api/thumbnails/(.*)', async function (ctx) {

    const src = fs.createReadStream(path.join('data',ctx.request.path.replace('/api/thumbnails/','/'), 'preview.jpg'));
	ctx.set('Content-Type', 'image/jpeg');
   ctx.body = src
})

router.get('/api/process/(.*)', async function (ctx) {

    const src = fs.createReadStream(path.join('data',ctx.request.path.replace('/api/process/','/'), 'params.json'));
	ctx.set('Content-Type', 'application/json');
   ctx.body = src
})

// project

router.post('/api/projects', async function (ctx) {
	var me = await Graph.myId(ctx.request.headers.mail)
	console.log(me)
	console.log('creating project')
	var n = await Graph.createProject(ctx.request.body, me.rid)
	console.log('project created')
	console.log(n)
	await media.createProjectDir(n)
	ctx.body = n
})

router.get('/api/projects', async function (ctx) {
	var n = await Graph.getProjects(ctx.request.headers.mail)
	ctx.body = n
})


router.get('/api/projects/:rid', async function (ctx) {
	var n = await Graph.getProject(ctx.request.params.rid, ctx.request.headers.mail)
	ctx.body = n
})

router.get('/api/projects/:rid/files', async function (ctx) {
	var n = await Graph.getProjectFiles(ctx.request.params.rid, ctx.request.headers.mail)
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
	var response = await services.removeConsumer(ctx.request.params.service, ctx.request.params.id)
	ctx.body = response
})

// router.post('/api/services', async function (ctx) {
// 	await queue.registerService(ctx.request.body)
// 	ctx.body = ctx.request.body
// })

router.get('/api/services', async function (ctx) {
	ctx.body = await services.getServices()
})

// get services for certain file
router.get('/api/services/files/:rid', async function (ctx) {
	var file = await Graph.getUserFileMetadata(ctx.request.params.rid, ctx.request.headers.mail)
	var service_list = await services.getServicesForFile(file)
	ctx.body = service_list
})


// add to queue

router.post('/api/queue/:topic/files/:file_rid', async function (ctx) {

	const topic = ctx.request.params.topic 
	try {
		const service = services.getServiceAdapterByName(topic)
		console.log(service)
		var task_name = service.tasks[ctx.request.body.task].name
		var file_metadata = await Graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
		console.log(file_metadata)
		var process = await Graph.createProcessGraph(task_name, ctx.request.body, file_metadata, ctx.request.headers.mail)
		await media.createProcessDir(process.path)
		await media.writeJSON(ctx.request.body, 'params.json', path.dirname(process.path))
		ctx.request.body.process = process
		ctx.request.body.file = file_metadata
		ctx.request.body.target = ctx.request.params.file_rid
		ctx.request.body.userId = ctx.headers[AUTH_HEADER]

		nats.publish(topic, JSON.stringify(ctx.request.body))
		ctx.body = ctx.request.params.file_rid

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
router.post('/api/nomad/service/:name/create', async function (ctx) {
	var adapter = await services.getServiceAdapterByName(ctx.request.params.name)
	var service = await nomad.createService(adapter)
	ctx.body = service
})

// endpoint for consumer apps to get file to be processed
router.get('/api/nomad/files/:file_rid', async function (ctx) {
	var file_metadata = await Graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
    const src = fs.createReadStream(file_metadata.path);
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
	
		// check if this is thumbnail
		if(message.id === 'thumbnailer') {

			var filepath = message.file.path
			const base_path = path.join(path.dirname(filepath))
			const filename = message.thumb_name || 'preview.jpg'

			try {
				await media.saveThumbnail(contentFilepath, base_path, filename)
				console.log('sending thumbnail WS')
				if(filename == 'thumbnail.jpg') {
					var wsdata = {target: message.file['@rid']}
					wsdata.image = base_path.replace('data/', 'api/thumbnails/')
					await sendWS(message.userId, wsdata)
				}
			} catch(e) {
				throw('Could not move file!' + e.message)
			}

		} else if(infoFilepath && contentFilepath) {
			const process_rid = message.process['@rid']
			var fileNode = await Graph.createProcessFileNode(process_rid, message.file.type, message.file.extension, message.file.label)
			console.log(fileNode)
			await media.uploadFile(contentFilepath, fileNode)

			if(message.userId) {
				console.log('sending text WS')
				const ws = connections.get(message.userId)
				if(ws) {
					var wsdata = {target: process_rid, node:{rid: fileNode.result[0]['@rid']}}
					ws.send(JSON.stringify(wsdata))
				}
			}

		// something went wrong in file processing	
		} else {
			console.log('PROCESS FAILED!')
			console.log(ctx.request.body)
		}
	} catch(e) {
		console.log(e)
	}
	ctx.body = 's'
})


router.post('/api/nomad/process/files/error', async function (ctx) {
	console.log(ctx.request.body)
	ctx.body = []

})




router.get('/api/queries', async function (ctx) {
	ctx.body = []
})


router.get('/api/menus', async function (ctx) {
	ctx.body = []
})


router.get('/api/groups', async function (ctx) {
	ctx.body = []

})

router.post('/api/layouts', async function (ctx) {
	//var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	var n = await positions.setLayout(ctx.request.body)
	ctx.body = n
})

router.get('/api/layouts/:rid', async function (ctx) {
	//var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	var n = await positions.getLayoutByTarget(ctx.request.params.rid)
	ctx.body = n
})


router.get('/api/sets/:rid/files', async function (ctx) {
	var n = await Graph.getSetFiles(ctx.request.params.rid, ctx.request.headers[AUTH_HEADER])
	ctx.body = n
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
	var n = await Graph.getDataWithSchema(ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/vertices/:rid', async function (ctx) {
	var n = await Graph.setNodeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.delete('/api/graph/vertices/:rid', async function (ctx) {
	var n = await Graph.deleteNode(ctx.request.params.rid)
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
	var n = await Graph.deleteEdge('#' + ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/edges/:rid', async function (ctx) {
	var n = await Graph.setEdgeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/connect/me', async function (ctx) {
	var me = await Graph.myId(user)
	ctx.request.body.from = me
	var n = await Graph.connect(ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/unconnect/me', async function (ctx) {
	var me = await Graph.myId(user)
	console.log(me)
	ctx.request.body.from = me
	var n = await Graph.unconnect(ctx.request.body)
	ctx.body = n
})

router.get('/api/documents', async function (ctx) {
	var n = await Graph.getListByType(ctx.request.query)
	ctx.body = n
})

router.get('/api/documents/:rid', async function (ctx) {
	var n = await Graph.getNodeAttributes(ctx.request.params.rid)
	ctx.body = n
})

async function sendWS(userId, data) {
	const ws = connections.get(userId)
	if(ws)
		await ws.send(JSON.stringify(data))
	else
		console.log('WS connection not found!', userId)

}


app.use(router.routes());

var set_port = process.env.PORT || 8200
var server = app.listen(set_port, function () {
   var host = server.address().address
   var port = server.address().port
   server.requestTimeout = 0 // https://github.com/b3nsn0w/koa-easy-ws/issues/36
   server.headersTimeout = 0

   console.log('MessyDesk running at http://%s:%s', host, port)
})
