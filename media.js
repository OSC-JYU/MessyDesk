
const util			= require('util');
const path 			= require('path');
const stream 		= require('stream');
const fs 			= require('fs-extra');


const TYPES = ['image', 'text'] 


let media = {}

media.createProjectDir = async function(project) {
	const rid = this.rid2path(project['@rid'])
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

media.uploadFile = async function(uploadpath, filegraph, data_dir = './') {

	console.log(filegraph)
	var file_rid = filegraph['@rid']
	var filepath = filegraph.path.split('/').slice( 0, -1 ).join('/')

	const filedata = {}
	try {
		await fs.ensureDir(path.join(data_dir, filepath, 'process'))
	
		filedata.filepath = path.join(data_dir, filepath, this.rid2path(file_rid) + '.' + filedata.extension)
		var exists = await checkFileExists(path.join(data_dir, filegraph.path))
		if(!exists) {
			await fs.rename(uploadpath, path.join(data_dir, filegraph.path));
			console.log('File moved successfully!')
			//ctx.body = 'done';
		} else {

			//await fs.unlink(uploadpath)
			throw('file exists!')
		}

		return filedata

	} catch (e) {
		console.log(e.message)
		await fs.unlink(uploadpath)
		throw('file saving failed')
	}
}

media.saveThumbnail = async function(uploadpath, basepath, filename) {
	console.log(filename)
	const filedata = {}
	try {
		await fs.ensureDir(path.join(basepath))
		const filepath = path.join(basepath, filename)
		console.log(uploadpath)
		console.log(filepath)

		await fs.rename(uploadpath, filepath);
		console.log('File moved successfully!')

		return filedata

	} catch (e) {
		await fs.unlink(uploadpath)
		console.log(e.message)
		throw('thumbnail saving failed')
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
		return first.replace(/[^a-zA-Z.,<>\s\/äöåÄÖÅøØæÆ-]/g, '') + '...'
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
