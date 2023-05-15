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
const Cypher 		= require('./cypher.js');
const media 		= require('./media.js');



(async () => {
	console.log('initing...')
})();

const global_services = {}

const cypher = new Cypher()

const docIndex = new Document( {
	tokenize: "full",
	document: {
		id: "id",
		index: ["label", "description"]
	}
})

//cypher.createIndex(docIndex)

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
	if(!process.env.DOCKER) context.request.headers.mail = "ari.hayrinen@jyu.fi" // dummy shibboleth
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
	var me = await cypher.myId(ctx.request.headers.mail)
	ctx.body = {rid: me, id: ctx.request.headers.mail}
})



// upload

router.post('/api/projects/:rid/upload', upload.single('file'), async function (ctx)  {

	var response = await cypher.getProject(ctx.request.params.rid)
	if (response.result.length == 0) return

	var filedata = await media.uploadFile(ctx)
	await cypher.createFileGraph(response.result[0]["@rid"], filedata)

})


// project

router.post('/api/projects', async function (ctx) {
	console.log(ctx.request.body)
	var n = await cypher.createProject(ctx.request.body)
	ctx.body = n
})

router.get('/api/projects/:rid', async function (ctx) {
	var n = await cypher.getProject(ctx.request.params.rid)
	ctx.body = n.result
})

// services

router.post('/api/services', async function (ctx) {
	if(ctx.request.body.id && ctx.request.body.url && ctx.request.body.api && ctx.request.body.supported_formats && ctx.request.body.supported_types && ctx.request.body.name && ctx.request.body.api_type) {
		global_services[ctx.request.body.id] = ctx.request.body
		ctx.body = ctx.request.body
	} else {
		throw('invalid service data!')
	}

})

router.get('/api/services', async function (ctx) {
	ctx.body = global_services

})

// get services for certain file
router.get('/api/services/files/:rid', async function (ctx) {
	var services = await cypher.getServicesForFile(global_services, ctx.request.params.rid)
	ctx.body = services

})


// un-register

// add to queue




router.get('/api/search', async function (ctx) {
	var result =  docIndex.search(ctx.request.query.search)
	var n = await cypher.getSearchData(result)
	ctx.body = n.result

})

router.post('/api/query', async function (ctx) {
	var n = await cypher.query(ctx.request.body)
	ctx.body = n
})

router.get('/api/schemas', async function (ctx) {
	var n = await cypher.getSchemaTypes()
	ctx.body = n
})

router.get('/api/tags', async function (ctx) {
	var n = await cypher.getTags()
	ctx.body = n
})

router.get('/api/queries', async function (ctx) {
	var n = await cypher.getQueries()
	ctx.body = n
})

router.get('/api/schemas/:schema', async function (ctx) {
	var n = await cypher.getSchema(ctx.request.params.schema)
	ctx.body = n
})

router.post('/api/graph/query/me', async function (ctx) {
	var n = await cypher.myGraph(user, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/query', async function (ctx) {
	var n = await cypher.getGraph(ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/vertices', async function (ctx) {
	var type = ctx.request.body.type
	var n = await cypher.create(type, ctx.request.body)
	console.log(n)
	var node = n.result[0]
	docIndex.add({id: node['@rid'],label:node.label})
	ctx.body = n
})


router.get('/api/graph/vertices/:rid', async function (ctx) {
	var n = await cypher.getDataWithSchema(ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/vertices/:rid', async function (ctx) {
	var n = await cypher.setNodeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges', async function (ctx) {
	var n = await cypher.connect(
		ctx.request.body.from,
		ctx.request.body.relation,
		ctx.request.body.to)
	ctx.body = n
})

router.delete('/api/graph/edges/:rid', async function (ctx) {
	var n = await cypher.deleteEdge('#' + ctx.request.params.rid)
	ctx.body = n
})

router.post('/api/graph/edges/:rid', async function (ctx) {
	var n = await cypher.setEdgeAttribute('#' + ctx.request.params.rid, ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/connect/me', async function (ctx) {
	var me = await cypher.myId(user)
	ctx.request.body.from = me
	var n = await cypher.connect(ctx.request.body)
	ctx.body = n
})

router.post('/api/graph/edges/unconnect/me', async function (ctx) {
	var me = await cypher.myId(user)
	console.log(me)
	ctx.request.body.from = me
	var n = await cypher.unconnect(ctx.request.body)
	ctx.body = n
})

router.get('/api/documents', async function (ctx) {
	var n = await cypher.getListByType(ctx.request.query)
	ctx.body = n
})

router.get('/api/documents/:rid', async function (ctx) {
	var n = await cypher.getNodeAttributes(ctx.request.params.rid)
	ctx.body = n
})




app.use(router.routes());

var set_port = process.env.PORT || 8200
var server = app.listen(set_port, function () {
   var host = server.address().address
   var port = server.address().port

   console.log('MessyDesk running at http://%s:%s', host, port)
})
