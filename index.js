const Koa			= require('koa');
const Router		= require('koa-router');
const bodyParser	= require('koa-body');
const json			= require('koa-json')
const serve 		= require('koa-static')
const multer 		= require('@koa/multer');
const winston 		= require('winston');
const path 			= require('path')
const fs 			= require('fs')
const { Index, Document, Worker } = require("flexsearch");
const Graph 		= require('./graph.js');
const queue 		= require('./queue.js');
const media 		= require('./media.js');



(async () => {
	console.log('initing...')
	await queue.init()
})();

const global_services = {}

const graph = new Graph()


const docIndex = new Document( {
	tokenize: "full",
	document: {
		id: "id",
		index: ["label", "description"]
	}
})

//graph.createIndex(docIndex)

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

var app				= new Koa();
var router			= new Router();

app.use(json({ pretty: true, param: 'pretty' }))
app.use(bodyParser());
app.use(serve(path.join(__dirname, '/public')))


// check that user has rights to use app
app.use(async function handleError(context, next) {
	context.request.headers.mail = "ari.hayrinen@jyu.fi" // dummy shibboleth
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



router.get('/api', function (ctx) {
	ctx.body = 'MessyDesk API'
})

router.get('/api/me', async function (ctx) {
	var me = await graph.myId(ctx.request.headers.mail)
	ctx.body = {rid: me, id: ctx.request.headers.mail}
})

router.get('/api/stall', async function (ctx) {

})


// upload

router.post('/api/projects/:rid/upload', upload.single('file'), async function (ctx)  {

	var response = await graph.getProject(ctx.request.params.rid, ctx.request.headers.mail)
	if (response.result.length == 0) throw('Project not found')


	project_rid = response.result[0]["@rid"]
	file_type = await media.detectType(ctx)
	var filegraph = await graph.createFileGraph(project_rid, ctx, file_type)
	await media.uploadFile(ctx, filegraph)
	ctx.body = filegraph

})


// project

router.post('/api/projects', async function (ctx) {
	var me_rid = await graph.myId(ctx.request.headers.mail)
	var n = await graph.createProject(ctx.request.body, me_rid)
	await media.createProjectDir(n)
	ctx.body = n
})

router.get('/api/projects', async function (ctx) {
	var n = await graph.getProjects(ctx.request.headers.mail)
	ctx.body = n.result
})


router.get('/api/projects/:rid', async function (ctx) {
	var n = await graph.getProject(ctx.request.params.rid, ctx.request.headers.mail)
	ctx.body = n.result
})

router.get('/api/projects/:rid/files', async function (ctx) {
	var n = await graph.getProjectFiles(ctx.request.params.rid, ctx.request.headers.mail)
	ctx.body = n.result
})

// services

// register service
router.post('/api/services', async function (ctx) {

	await queue.registerService(ctx.request.body)
	ctx.body = ctx.request.body

})

router.get('/api/services', async function (ctx) {
	ctx.body = queue.services

})

// get services for certain file
router.get('/api/services/files/:rid', async function (ctx) {
	var services = await graph.getServicesForFile(global_services, ctx.request.params.rid)
	ctx.body = services
})


// un-register

// add to queue
router.post('/api/queue/:topic/files/:file_rid', async function (ctx) {

	const topic = ctx.request.params.topic 
	if(topic in queue.services) {
		console.log('calleing qe')
		var file_metadata = await graph.getUserFileMetadata(ctx.request.params.file_rid, ctx.request.headers.mail)
		console.log(file_metadata)
		if(file_metadata.path) {
			// add process to graph
			var process = await graph.createProcessGraph(topic, ctx.request.body, file_metadata, ctx.request.headers.mail)
			await media.createProcessDir(process.path) 
			console.log('Writing params.json...')
			await media.writeJSON(ctx.request.body, 'params.json', process.path)

			ctx.request.body.file = file_metadata
			ctx.request.body.target = ctx.request.params.file_rid
			const message = {
				key: "md",
				value: JSON.stringify(ctx.request.body),
			  };
			await queue.producer.send({
				topic,
				messages: [message],
			  });
		
			ctx.body = ctx.request.params.file_rid
		} else {
			throw('File not found!')
		}
	} else {
		ctx.body = 'ERROR: service not available'
	}
})





router.get('/api/search', async function (ctx) {
	var result =  docIndex.search(ctx.request.query.search)
	var n = await graph.getSearchData(result)
	ctx.body = n.result

})

router.post('/api/query', async function (ctx) {
	var n = await graph.query(ctx.request.body)
	ctx.body = n
})

router.get('/api/schemas', async function (ctx) {
	var n = await graph.getSchemaTypes()
	ctx.body = n
})

router.get('/api/tags', async function (ctx) {
	var n = await graph.getTags()
	ctx.body = n
})

router.get('/api/queries', async function (ctx) {
	var n = await graph.getQueries()
	ctx.body = n
})

router.get('/api/schemas/:schema', async function (ctx) {
	var n = await graph.getSchema(ctx.request.params.schema)
	ctx.body = n
})

router.post('/api/graph/query/me', async function (ctx) {
	var n = await graph.myGraph(user, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/query', async function (ctx) {
	var n = await graph.getGraph(ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/vertices', async function (ctx) {
	var type = ctx.request.body.type
	var n = await graph.create(type, ctx.request.body)
	console.log(n)
	var node = n.result[0]
	docIndex.add({id: node['@rid'],label:node.label})
	ctx.body = n
})


router.get('/api/graph/vertices/:rid', async function (ctx) {
	var n = await graph.getDataWithSchema(ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/vertices/:rid', async function (ctx) {
	var n = await graph.setNodeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges', async function (ctx) {
	var n = await graph.connect(
		ctx.request.body.from,
		ctx.request.body.relation,
		ctx.request.body.to)
	ctx.body = n
})

router.delete('/api/graph/edges/:rid', async function (ctx) {
	var n = await graph.deleteEdge('#' + ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/edges/:rid', async function (ctx) {
	var n = await graph.setEdgeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/connect/me', async function (ctx) {
	var me = await graph.myId(user)
	ctx.request.body.from = me
	var n = await graph.connect(ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/unconnect/me', async function (ctx) {
	var me = await graph.myId(user)
	console.log(me)
	ctx.request.body.from = me
	var n = await graph.unconnect(ctx.request.body)
	ctx.body = n
})

router.get('/api/documents', async function (ctx) {
	var n = await graph.getListByType(ctx.request.query)
	ctx.body = n
})

router.get('/api/documents/:rid', async function (ctx) {
	var n = await graph.getNodeAttributes(ctx.request.params.rid)
	ctx.body = n
})




app.use(router.routes());

var set_port = process.env.PORT || 8200
var server = app.listen(set_port, function () {
   var host = server.address().address
   var port = server.address().port

   console.log('MessyDesk running at http://%s:%s', host, port)
})
