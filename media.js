
const util			= require('util');
const path 			= require('path');
const stream 		= require('stream');
const fs 			= require('fs-extra');


const TYPES = ['image', 'text'] 


let media = {}

media.createProjectDir = async function(project) {
	const rid = this.rid2path(project.result[0]['@rid'])
	try {
		await fs.ensureDir(path.join('data', 'projects', rid, 'files'))
	} catch(e) {
		throw('Could not create project directory!' + e.message)
	}
}

media.createProcessDir = async function(process_path) {
	try {
		await fs.ensureDir(process_path)
	} catch(e) {
		throw('Could not create process directory!' + e.message)
	}
}

media.uploadFile = async function(ctx, filegraph) {

	console.log(filegraph)
	var file_rid = filegraph.result[0]['@rid']
	var filepath = filegraph.result[0].path.split('/').slice( 0, -1 ).join('/')

	const filedata = {}
	try {
		await fs.ensureDir(path.join(filepath, 'process'))
	
		filedata.filepath = path.join(filepath, this.rid2path(file_rid) + '.' + filedata.extension)
		var exists = await checkFileExists(filegraph.result[0].path)
		if(!exists) {
			await fs.rename(ctx.file.path, filegraph.result[0].path);
			console.log('File moved successfully!')
			ctx.body = 'done';
		} else {
			await fs.unlink(ctx.file.path)
			throw('file exists!')
		}

		return filedata

	} catch (e) {
		console.log('File upload failed')
		console.log(e.message)
	}
}

media.writeJSON =  async function(data, filename, fpath) {

	try {
		const jsonData = JSON.stringify(data, null, 2);
		await fs.promises.writeFile(path.join(fpath, filename), jsonData);
		console.log('Data successfully written to params.json!');
	  } catch (error) {
		console.error('Error writing data to params.json:', error);
	  }

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

media.rid2path = function (rid) {
	return rid.replace('#', '').replace(':', '_')
}

media.getTextDescription = async function (filePath) {
	const maxCharacters = 100;
	try {
		const data = await fs.promises.readFile(filePath, 'utf8');
		const first = data.substring(0, maxCharacters);
		console.log(first);
		return first
	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
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
