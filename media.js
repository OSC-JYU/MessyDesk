
const util			= require('util');
const path 			= require('path');
const stream 		= require('stream');
const fs 			= require('fs');
const fsPromises 	= require('fs').promises;

const pipeline = util.promisify(stream.pipeline);


const TYPES = ['image', 'text'] 


let media = {}


media.uploadFile = async function(ctx) {

	const filedata = {}
    filedata.type = await this.detectType(ctx)
	filedata.originalname = ctx.file.originalname
	filedata.extension = path.extname(ctx.file.originalname).replace('.','')
	var uploaded_filename = path.basename(ctx.file.path)
	console.log(uploaded_filename)

	filedata.filepath = path.join('media', uploaded_filename + '.' + filedata.extension)
	var exists = await checkFileExists(filedata.filepath)
	if(!exists) {
		await fsPromises.rename(ctx.file.path, filedata.filepath);
		console.log('File moved successfully!')
		ctx.body = 'done';
	} else {
		await fsPromises.unlink(ctx.file.path)
		throw('file exists!')
	}

	return filedata

}

media.detectType = async function(ctx) {

    var extension = path.extname(ctx.file.originalname)

    var ftype = ctx.file.mimetype.split('/')[0]
    console.log(ftype)
    if(TYPES.includes(ftype)) {
        return ftype
    } else if(ctx.file.mimetype == 'application/pdf') {
        return 'pdf'
    } else if(ctx.file.mimetype == 'application/octet-stream') {
        if(extension == '.csv') {
            return 'data'
        }
    }

}


async function checkFileExists(filePath) {
	try {
		console.log(filePath)
	  	await fs.access(filePath);
	  	return true;
	} catch (err) {
		return false;
	}
}


module.exports = media
