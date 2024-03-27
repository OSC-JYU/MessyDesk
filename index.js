const Koa			= require('koa');
const Router		= require('koa-router');
const bodyParser	= require('koa-body');
const json			= require('koa-json')
const serve 		= require('koa-static')
const multer 		= require('@koa/multer');
const winston 		= require('winston');
const path 			= require('path')
const fs 			= require('fs')
const websocket 	= require('koa-easy-ws')

const Graph 		= require('./graph.js');
const queue 		= require('./queue.js');
const media 		= require('./media.js');
const schema 		= require('./schema.js');
const styles 		= require('./styles.js');
const services 		= require('./services.js');
const nomad 		= require('./nomad.js');

const connections = new Map();

(async () => {
	console.log('initing...')
	await nomad.getStatus()
	await services.loadServiceAdapters()
	await queue.init(connections, services.getServices())
	//await queue.init(services.getServices())
	// start thumbnailer and Poppler services
	var thumb = await services.getServiceAdapterByName('thumbnailer')
	await nomad.createService(thumb)
	var ima = await services.getServiceAdapterByName('md-imaginary')
	await nomad.createService(ima)
	// import schema
	await Graph.initDB()
	await schema.importSystemSchema()
	await styles.importSystemStyle()
})();


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
	  queue.connections.set(userId, ws);
	  ws.on('message', function message(data) {
		console.log('received: %s', data);
		ws.send(JSON.stringify({target:'#267:25', label:'joo'}))
	  });
	  return ws.send('chancellor palpatine is evil')
	}
  })

router.get('/api', function (ctx) {
	ctx.body = 'MessyDesk API'
})

router.get('/connections', function (ctx) {
	const itr = queue.connections.keys()
	var arr = []
	for (const value of itr) {
		arr.push(value);
	  }
	ctx.body = arr
})

router.get('/api/me', async function (ctx) {
	if(process.env.CREATE_USERS_ON_THE_FLY) {
		// keep list of visitors so that we do not create double users on sequential requests
		if(!visitors.includes(ctx.request.headers[AUTH_HEADER])) {
			visitors.push(ctx.request.headers[AUTH_HEADER])
			await Graph.checkMe(ctx.request.headers[AUTH_HEADER])
		}
	}
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
	await media.uploadFile(ctx, filegraph)
	var data = {file: filegraph.result[0]}
	data.userId = ctx.headers[AUTH_HEADER]

	// send to thumbnailer queue 
	queue.add('thumbnailer', data)

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

// register service
router.post('/api/services/:name', async function (ctx) {
	var response = await services.getServiceAdapterByName(ctx.request.params.name, queue.services)
	ctx.body = response
})

router.post('/api/services', async function (ctx) {
	await queue.registerService(ctx.request.body)
	ctx.body = ctx.request.body
})

router.get('/api/services', async function (ctx) {
	ctx.body = await services.getServices(queue.services)
})

// get services for certain file
router.get('/api/services/files/:rid', async function (ctx) {
	var service_list = await Graph.getServicesForFile(services.getServices(), ctx.request.params.rid)
	ctx.body = service_list
})


// un-register

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

		queue.add(topic, ctx.request.body)
		ctx.body = ctx.request.params.file_rid

	} catch(e) {
		console.log('Queue failed!', e)
	}




	
	// if(topic in queue.services) {
	// 	var file_metadata = await Graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
	// 	if(file_metadata.path) {
	// 		// add process to graph
	// 		var task_name = queue.services[topic].tasks[ctx.request.body.task].name
	// 		var process = await Graph.createProcessGraph(task_name, ctx.request.body, file_metadata, ctx.request.headers.mail)
	// 		await media.createProcessDir(process.path) 
	// 		await media.writeJSON(ctx.request.body, 'params.json', path.dirname(process.path))

	// 		ctx.request.body.process = process
	// 		ctx.request.body.file = file_metadata
	// 		ctx.request.body.target = ctx.request.params.file_rid
	// 		ctx.request.body.userId = ctx.headers[AUTH_HEADER]
	// 		const message = {
	// 			key: "md",
	// 			value: JSON.stringify(ctx.request.body),
	// 		};

	// 		await queue.producer.send({
	// 			topic,
	// 			messages: [message],
	// 		});
		
	// 		ctx.body = ctx.request.params.file_rid
	// 	} else {
	// 		throw('File not found!')
	// 	}
	// } else {
	// 	ctx.body = 'ERROR: service not available'
	// }
})



// router.post('/api/queue/:topic/files/:file_rid', async function (ctx) {

// 	const topic = ctx.request.params.topic 
// 	if(topic in queue.services) {
// 		var file_metadata = await Graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
// 		if(file_metadata.path) {
// 			// add process to graph
// 			var task_name = queue.services[topic].tasks[ctx.request.body.task].name
// 			var process = await Graph.createProcessGraph(task_name, ctx.request.body, file_metadata, ctx.request.headers.mail)
// 			await media.createProcessDir(process.path) 
// 			await media.writeJSON(ctx.request.body, 'params.json', path.dirname(process.path))

// 			ctx.request.body.process = process
// 			ctx.request.body.file = file_metadata
// 			ctx.request.body.target = ctx.request.params.file_rid
// 			ctx.request.body.userId = ctx.headers[AUTH_HEADER]
// 			const message = {
// 				key: "md",
// 				value: JSON.stringify(ctx.request.body),
// 			};

// 			await queue.producer.send({
// 				topic,
// 				messages: [message],
// 			});
		
// 			ctx.body = ctx.request.params.file_rid
// 		} else {
// 			throw('File not found!')
// 		}
// 	} else {
// 		ctx.body = 'ERROR: service not available'
// 	}
// })




router.get('/api/nomad/status', async function (ctx) {
	ctx.body = await nomad.getStatus()

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
	var n = await Graph.setLayout(ctx.request.body)
	ctx.body = n
})

router.get('/api/layouts/:rid', async function (ctx) {
	//var me = await Graph.myId(ctx.request.headers[AUTH_HEADER])
	var n = await Graph.getLayoutByTarget(ctx.request.params.rid)
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




app.use(router.routes());

var set_port = process.env.PORT || 8200
var server = app.listen(set_port, function () {
   var host = server.address().address
   var port = server.address().port
   server.requestTimeout = 0 // https://github.com/b3nsn0w/koa-easy-ws/issues/36
   server.headersTimeout = 0

   console.log('MessyDesk running at http://%s:%s', host, port)
})
