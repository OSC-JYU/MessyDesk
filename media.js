
const util			= require('util');
const path 			= require('path');
const stream 		= require('stream');
const fs 			= require('fs-extra');
const sizeOf		= require('image-size');


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

	var filedata = null
	try {
		await fs.ensureDir(path.join(data_dir, filepath, 'process'))
	
		//filedata.filepath = path.join(data_dir, filepath, this.rid2path(file_rid) + '.' + filedata.extension)
		var exists = await checkFileExists(path.join(data_dir, filegraph.path))
		if(!exists) {
			await fs.rename(uploadpath, path.join(data_dir, filegraph.path));
			filedata = await this.getImageSize(path.join(data_dir, filegraph.path))
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

media.getImageSize = async function(filepath) {
	var filedata = {}
	try {
		const dimensions = await sizeOf(filepath)
		filedata.width = dimensions.width
		filedata.height = dimensions.height
		filedata.imgtype = dimensions.type
		if(dimensions.orientation && dimensions.orientation !== 1) {
			filedata.orientation = dimensions.orientation
			// convert exif orientation to degrees needed
			switch(dimensions.orientation) {
				case 3:
					filedata.rotate = 180
					break;
				case 6:
					filedata.rotate = 90
					break;
				case 8:
					filedata.rotate = 270
					break;
			}
		}
		return filedata
	} catch (error) {
		console.error('Image size reading failed:');
		return null
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

media.readJSON =  async function(fpath) {

	try {
		const jsonData = await fs.promises.readFile(fpath, 'utf8');
		return jsonData
	  } catch (error) {
		console.error('Error reading data from json:', error);
		return {}
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

media.getText = async function (filePath) {
	try {
		const data = await fs.promises.readFile(filePath, 'utf8');
		return data
	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
	  }
}

media.getTextDescription = async function (filePath, file_type) {
	const maxCharacters = 150;
	try {
		const data = await fs.promises.readFile(filePath, 'utf8');
		// get number of characters	
		const linecount = data.split(/\n/).length

		if(file_type == 'ner.json') {
			return NERsummary(data)

		} else if(file_type == 'osd.json') {
			var json_str = JSON2text(data)
			if(json_str) {
				return json_str.substring(0, maxCharacters);
			}	
		} else {
			var first = data.substring(0, maxCharacters);
			first = first.replace(/[^a-zA-Z0-9.,<>\s\/äöåÄÖÅøØæÆ-]/g, '') + '...'
			return 'lines: ' + linecount + '\n' + 'characters:' + data.length + '\n' + first
		}

	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
	  }
}

function NERsummary(data) {
	try {

		var json = JSON.parse(data)
		const entityCounts = {};

		// Iterate over each entity in the list
		json.forEach(entity => {
			const group = entity.entity_group;
			// Increment the count for each entity group
			entityCounts[group] = (entityCounts[group] || 0) + 1;
		});
		
		// Create the summary as a plain text string
		let summary = "Entity Groups Found:\n";
		for (const [group, count] of Object.entries(entityCounts)) {
			summary += `- ${group}: ${count}\n`;
		}
console.log(summary)
		return summary;


	} catch(e) {
		console.log('erro in NER summary', e)
		return null
	}
}

function JSON2text(data) {
	try {
		var str_json = []
		var json = JSON.parse(data)
		for(var key in json) {
			if(typeof json[key] == 'object') {
				str_json.push(key + ': ' + JSON.stringify(json[key], null, 2))
			} else {
				str_json.push(key + ': ' + json[key])
			}
		}
		return str_json.join('\n')
	} catch(e) {
		return null
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
