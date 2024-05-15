
// this file is for testing purposes

const path 			= require('path')
const fse 			= require('fs-extra')
const websocket 	= require('koa-easy-ws')

const Graph 		= require('../graph.js');

const media 		= require('../media.js');
const web 		    = require('../web.js');
const services 		= require('../services.js');
const nomad 		= require('../nomad.js');

let nats
let positions

const connections = new Map();
const AUTH_HEADER = 'mail'
const user = 'local.user@localhost'

process.on( 'SIGINT', async function() {
	console.log( "\nGracefully shutting down from SIGINT (Ctrl-C)" );
    await nats.close()
	process.exit( );
  })


async function main() {
    

	console.log('initing...')
	// migration to ES6 in progress...
	const {queue} = await import('../queue.mjs');
	const {layout} = await import('../layouts.mjs');
	nats = queue
	positions = layout
	await nomad.getStatus()
	await services.loadServiceAdapters('../services')
    await nats.connect() 


    // we create fake 'uploads' dir
    await fse.ensureDir('uploads')

    // create/get test project
    const project = await createTestProject()
    console.log('project RID:', project['@rid'])

    //const test_png =await addFileToProject('test.png', 'image', project['@rid'])
    //const jyudig = await addFileToProject('jyudig.pdf', 'pdf', project['@rid'])
    //const face = await addFileToProject('face.jpeg', 'image', project['@rid'])
    const test_txt = await addFileToProject('test.txt', 'text', project['@rid'])


    // await processFile(jyudig, 'md-poppler:pdf2text', {
    //     info: 'tekstii', 
    //     params: {firstPageToConvert:1, lastPageToConvert: 2}, 
    // }, user)
    await processFile(test_txt, 'md-azure-ai:discpiline_info', {
        info: 'tekstii', 
    }, user)
    //await processFile(jyudig, 'md-poppler:pdf2images', {info: 'Rendered images from PDF'}, user)
    //await processFile(jyudig, 'md-poppler:pdfimages', {info: 'images from PDF'}, user)

    //await nats.close()

}


async function processFile(fileNode, service_task, options, user) {
    // split service task to variables service and task
    let [servicename, task] = service_task.split(':')
    console.log(servicename)
    const service = services.getServiceAdapterByName(servicename)
    var task_name = service.tasks[task].name
    var processNode = await createProcess(task_name, options, fileNode, user)
    if(options.params) options.params.task = task
    else options.params = {task: task}


    // send to queue
    const data = {
        params: options.params,
        process: processNode,
        file: fileNode,
        target: fileNode['@rid'],
        userId: user
    }

    if(service.tasks[task].output_node && service.tasks[task].output_node == 'Set') {
        const setNode = await Graph.createProcessSetNode(processNode['@rid'], {label: 'testisetti', type:'set'}, user)
        data.set = setNode['@rid']
    }

    nats.publish(servicename, JSON.stringify(data))
}

async function createProcess(task_name, info, file, user) {
    // we could get file node like this (if we had only rid):
	//var file_metadata = await Graph.getUserFileMetadata(rid, user)
    var processNode = await Graph.createProcessNode(task_name, info, file, user)
    console.log(processNode)
    await media.createProcessDir(processNode.path)
    await media.writeJSON(info, 'params.json', path.join(path.dirname(processNode.path)))
    return processNode
}

async function addFileToProject(filename, type, project_rid) {
    // 'upload' file
    await fse.copy('files/' + filename, 'uploads/' + filename)
    // create file node
    const ctx = {file: {originalname: filename}}
    var filegraph = await Graph.createProjectFileGraph(project_rid, ctx, type)
    // move file to data dir
    await media.uploadFile('uploads/' + filename, filegraph)
    console.log(filegraph)
    // send it to a thumbnail service
    if(type == 'image' || type == 'pdf') {
        var data = {
            file: filegraph,
            userId: user,
            target: filegraph['@rid'],
            task: 'thumbnail',
            params: {width: 800, type: 'jpeg'},
            id: 'thumbnailer'   
        }
        // send to thumbnailer queue 
        nats.publish(data.id, JSON.stringify(data))
    }


    return filegraph
}
async function createTestProject() {        
    try {
        var me = await Graph.myId(user)
        console.log(me)
        var n = await Graph.createProject({label: 'dev_test'}, me.rid)
        console.log('project created')
        console.log(n)
        await media.createProjectDir(n)
        return n.result[0]
    } catch (e) {
        console.log(e)  
        var n = await Graph.getProjects(user)
        await fse.remove('data/projects/' + n[0]['@rid'].replace('#', '').replace(':', '_') + '/files')
        await clearFiles()
        return n[0]
    }
}

async function clearFiles() {
    const sql = 'DELETE from File'
    await web.sql(sql)
}

   // const data = await fse.promises.readFile(file_1, 'utf8');
    //await fse.promises.writeFile('uploads/dev_test.png', data, 'utf8');

main()


