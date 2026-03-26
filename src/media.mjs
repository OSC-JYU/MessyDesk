import path from 'path';
import fs from 'fs';
import fse from 'fs-extra';


import sizeOf from 'image-size';
import archiver from 'archiver';
import os from 'os';
import logger from './logger.mjs';
import unzipper from 'unzipper';


const TYPES = ['image'] 


let media = {}


media.ROIPercentagesToPixels = function(roi, message) {
	// Ensure percentages are between 0 and 100
	const top = Math.max(0, Math.min(100, roi.top));
	const left = Math.max(0, Math.min(100, roi.left));
	const width = Math.max(0, Math.min(100, roi.width));
	const height = Math.max(0, Math.min(100, roi.height));

	// Calculate pixel values
	const areaWidth = Math.round(width/100 * message.file.metadata.width);
	const areaHeight = Math.round(height/100 * message.file.metadata.height);
	const topPixels = Math.round(top/100 * message.file.metadata.height);
	const leftPixels = Math.round(left/100 * message.file.metadata.width);

	// Ensure final coordinates don't exceed image boundaries
	const finalWidth = Math.min(areaWidth, message.file.metadata.width - leftPixels);
	const finalHeight = Math.min(areaHeight, message.file.metadata.height - topPixels);

	message.task.params.left = leftPixels;
	message.task.params.top = topPixels;
	message.task.params.areawidth = finalWidth;
	message.task.params.areaheight = finalHeight;
	
	return message;
}



media.zipFilesAndStream2 = async function(fileList, ctx) {
    try {
        return await new Promise((resolve, reject) => {
	// Create a new archive (zip) with no compression (store mode)
	const archive = archiver('zip', {
	  zlib: { level: 0 } // 0 means no compression, just store
	});
  
	// Set the response headers for streaming the zip file
	ctx.set('Content-Type', 'application/zip');
	ctx.set('Content-Disposition', 'attachment; filename="files.zip"');

            // Handle archive errors
            archive.on('error', (err) => {
                console.error('Archive error:', err);
                reject(err);
            });

            // Handle response stream errors
            ctx.res.on('error', (err) => {
                console.error('Response stream error:', err);
                reject(err);
            });

            // Handle response stream close
            ctx.res.on('close', () => {
                console.log('Archive finalized, response stream closed');
                resolve();
            });
  
	// Pipe the archive output to the response stream
	archive.pipe(ctx.res);
  
	// Add files to the archive
	fileList.forEach(filePath => {
	  const fullPath = path.resolve(filePath);
	  if (fse.existsSync(fullPath)) {
		// Add each file to the zip as a file entry
		archive.file(fullPath, { name: path.basename(filePath) });
	  } else {
		console.error(`File not found: ${fullPath}`);
	  }
	});

            // Finalize the archive
	archive.finalize();
        });
    } catch (err) {
        console.error('Error in zipFilesAndStream2:', err);
		ctx.status = 500;
        ctx.body = 'Error creating zip file';
        throw err;
    }
  }


// NOTE: this removes parent directory! (the basename is stripper away)
  media.deleteNodePath = async function(dir) {
	try {
		if(!dir) return
		const clean = path.normalize(dir)
		const parsed = path.parse(clean)
		var target = clean
		if(parsed.ext) {
			target = path.dirname(clean)
		}

		const protectedDirs = [
			'data',
			'data/projects',
			'data/uploads',
			'data/layouts',
			'data/files',
			'data/processes',
			'data/sets'
		]

		const normalizedTarget = target.replace(/\\/g, '/').replace(/\/$/, '')
		if(protectedDirs.includes(normalizedTarget)) {
			throw('Protecting data root dir!')
		}

		await fse.remove(target)
	} catch(e) {
		console.log('error deleting node data directory. ' + e)
		//throw('Could not delete directory!' + e.message)
	}	
}





media.createDataDir = async function(data_dir) {
	try {
		await fse.ensureDir(path.join(data_dir, 'files'))
		await fse.ensureDir(path.join(data_dir, 'processes'))
		await fse.ensureDir(path.join(data_dir, 'sets'))

		// legacy paths (kept for migration / backward compatibility)
		await fse.ensureDir(path.join(data_dir, 'projects'))
		await fse.ensureDir(path.join(data_dir, 'uploads'))
		await fse.ensureDir(path.join(data_dir, 'layouts'))
	} catch(e) {
		throw('Could not create data directory!  [' + data_dir + '] ' + e.message)
	}
}

media.createProjectDir = async function(project, data_dir) {
	try {
		await this.createDataDir(data_dir)
		const projectDir = this.getProjectDir(data_dir, project['@rid'])
		await fse.ensureDir(path.join(projectDir, 'files'))
		await fse.ensureDir(path.join(projectDir, 'processes'))
		await fse.ensureDir(path.join(projectDir, 'sets'))
		await fse.ensureDir(path.join(projectDir, 'sources'))
	} catch(e) {
		throw('Could not create project directory!' + e.message)
	}
}

media.createProcessDir = async function(process_path) {
	try {
		await fse.ensureDir(process_path)
	} catch(e) {
		throw('Could not create process directory!' + e.message)
	}
}

media.uploadFile = async function(uploadpath, filegraph) {


	var filepath = filegraph.path.split('/').slice( 0, -1 ).join('/')

	var filedata = null
	try {
		await fse.ensureDir(filepath)
	
		//filedata.filepath = path.join(data_dir, filepath, this.rid2path(file_rid) + '.' + filedata.extension)
		var exists = await checkFileExists(filegraph.path)
		if(!exists) {
			await fse.move(uploadpath, filegraph.path);
			const stats = await fse.stat(filegraph.path);
			filedata = { size: Math.round(stats.size / 1024 / 1024 * 100) / 100 }; // size in MB, rounded to 2 decimals
			if(filegraph.type == 'image') {
				const imageData = await this.getImageSize(filegraph.path);
				filedata = { ...filedata, ...imageData };
			}
		} else {
			throw('file exists!')
		}

		return filedata

	} catch (e) {
		console.log(e.message)
		await fse.unlink(uploadpath)
		throw('file saving failed')
	}
}

media.replaceFile = async function(originalPath, filegraph) {
	try {
		await fse.rename(originalPath, filegraph.path);
	} catch (error) {
		console.log('Error replacing file:', error);
	}
}


media.getImageSize = async function(filepath) {
	var filedata = {}
	try {
		const dimensions = sizeOf(filepath)
		filedata.width = dimensions.width
		filedata.height = dimensions.height
		filedata.imgtype = dimensions.type
		if(dimensions.orientation && dimensions.orientation !== 1) {
			filedata.orientation = dimensions.orientation
			// convert exif orientation to degrees if needed
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
		return filedata
	}	
}

media.saveThumbnail = async function(uploadpath, basepath, filename) {

	const filedata = {}
	try {
		await fse.ensureDir(path.join(basepath))
		const filepath = path.join(basepath, filename)

		await fse.move(uploadpath, filepath);

		return filedata

	} catch (e) {
		await fse.unlink(uploadpath)
		console.log(e.message)
		throw('thumbnail saving failed')
	}
}

media.ifExists = async function(fpath) {
	return await fse.pathExists(fpath)
}

media.readJSON =  async function(fpath) {

	try {
		const jsonData = await fse.readFile(fpath, 'utf8');
		return jsonData
	  } catch (error) {
		console.error('Error reading data from json:', error);
		return {}
	  }
}

media.writeJSON =  async function(data, filename, fpath) {

	try {
		const jsonData = JSON.stringify(data, null, 2);
		await fse.writeFile(path.join(fpath, filename), jsonData);
	  } catch (error) {
		console.error('Error writing data to params.json:', error);
	  }

}

media.detectType = async function(file) {
	const originalFilename = file.hapi.filename;
	const mimeType = file.hapi.headers['content-type'];
    var extension = path.extname(originalFilename).toLowerCase()

    var ftype = mimeType.split('/')[0]
    if(mimeType == 'application/zip' || extension == '.zip') {
        return 'zip'
    }

    if(ftype == 'image') {  // image formats
        return ftype
    } else if(mimeType == 'application/pdf' || extension == '.pdf') {
        return 'pdf'
    } else if(mimeType == 'application/octet-stream' || extension == '.csv') {
        if(extension == '.csv') {
            return 'csv'
        }
    } else if(mimeType == 'application/json' || extension == '.json') {
        return 'json'
    } else if(mimeType == 'application/html'  || extension == '.html') {
        return 'html'
    } else if(mimeType == 'text/plain' || extension == '.txt') {
        return 'text'
    }

}

media.rid2path = function (rid) {
	return rid.replace('#', '').replace(':', '_')
}

media.getProjectDir = function(data_dir, project_rid) {
	if(!project_rid) return data_dir
	return path.join(data_dir, 'projects', this.rid2path(project_rid))
}

media.ridShardPath = function(rid) {
	if(!rid) throw new Error('RID is required')
	const clean = rid.replace('#', '')
	const [bucketStr, posStr] = clean.split(':')
	const bucket = Number(bucketStr)
	const pos = Number(posStr)

	if(Number.isNaN(bucket) || Number.isNaN(pos)) {
		throw new Error('Invalid RID format')
	}

	const block = Math.floor(pos / 1000)
	return path.join(String(bucket), String(block), String(pos))
}

media.isUUID = function(value) {
	if(!value || typeof value !== 'string') return false
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

media.uuid2path = function(uuid) {
	return uuid.toLowerCase().replace(/-/g, '')
}

media.uuidShardPath = function(uuid) {
	if(!this.isUUID(uuid)) throw new Error('Invalid UUID format')
	const id = this.uuid2path(uuid)
	// Use head bytes to group UUIDv7 by time
	const s1 = id.slice(0, 2)
	const s2 = id.slice(2, 4)
	const s3 = id.slice(4, 6)
	return path.join(s1, s2, s3, id)
}

media.shardPath = function(identifier) {
	if(this.isUUID(identifier)) {
		return this.uuidShardPath(identifier)
	}
	return this.ridShardPath(identifier)
}

media.getFileDir = function(data_dir, project_rid, rid) {
	if(!rid) {
		rid = project_rid
		project_rid = null
	}
	return path.join(this.getProjectDir(data_dir, project_rid), 'files', this.shardPath(rid))
}

media.getProcessDir = function(data_dir, project_rid, rid) {
	if(!rid) {
		rid = project_rid
		project_rid = null
	}
	return path.join(this.getProjectDir(data_dir, project_rid), 'processes', this.shardPath(rid))
}

media.getProcessFilesDir = function(data_dir, project_rid, rid) {
	if(!rid) {
		rid = project_rid
		project_rid = null
	}
	return path.join(this.getProcessDir(data_dir, project_rid, rid), 'files')
}

media.getSetDir = function(data_dir, project_rid, rid) {
	if(!rid) {
		rid = project_rid
		project_rid = null
	}
	return path.join(this.getProjectDir(data_dir, project_rid), 'sets', this.shardPath(rid))
}

media.getSourceDir = function(data_dir, project_rid, rid) {
	if(!rid) {
		rid = project_rid
		project_rid = null
	}
	return path.join(this.getProjectDir(data_dir, project_rid), 'sources', this.shardPath(rid))
}

media.getFilePath = function(data_dir, project_rid, rid, extension) {
	if(extension === undefined) {
		extension = rid
		rid = project_rid
		project_rid = null
	}
	const ext = (extension || '').replace('.', '').toLowerCase()
	const baseName = this.isUUID(rid) ? this.uuid2path(rid) : this.rid2path(rid)
	const fileName = ext ? `${baseName}.${ext}` : baseName
	return path.join(this.getFileDir(data_dir, project_rid, rid), fileName)
}

media.getText = async function (filePath) {
	try {
		const data = await fse.readFile(filePath, 'utf8');
		return data
	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
	  }
}

media.getTextDescription = async function (filePath, file_type) {
	const maxCharacters = 150;
	try {
		const data = await fse.readFile(filePath, 'utf8');
		console.log('data', data)

		// get number of characters	
		const linecount = data.split(/\n/).length

		if(file_type == 'ner.json') {
			return NERsummary(data)
	
		} else if(file_type == 'ocr.json') {
			// let's assume the json looks like this:
			// [{"coordinates":[{"x":0.05599300087489064,"y":0.164519906323185},{"x":0.5433070866141733,"y":0.15515222482435598},{"x":0.5441819772528433,"y":0.1797423887587822},{"x":0.0568678915135608,"y":0.18969555035128804}],"text":"kapäiväinen lentoyhteys Uumajaan.","confidence":0.9961017370223999}]
			// we want to return the few lines of text 
			var text = ''
			var json = JSON.parse(data)
			for(var i = 0; i < json.length; i++) {
				text += json[i].text + ' '
			}
			return text.substring(0, maxCharacters)

		} else {
			var first = data.substring(0, maxCharacters);
			first = first.replace(/[^a-zA-Z0-9.,<>\s\/äöåÄÖÅøØæÆ-]/g, '') + '...'
			//return first + '\n' + ' -lines: ' + linecount + '\n' + ' -characters:' + data.length
			return first 
		}

	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
	  }
}


media.getThumbnail = async function(filePath) {

	try {
		if(!filePath) {
			return fs.createReadStream('images/image_not_found.jpg')
		}
		
		var thumbfile = 'preview.jpg'
		var base = path.dirname(filePath)
		// get filename from path	
		var f = path.basename(filePath)
		if(f.includes('.')) {
			if(f == 'preview.jpg' || f == 'thumbnail.jpg') {
				thumbfile = f
			}
		} else {
			base = path.join(base, f)
		}

		let fullPath = path.join(base.replace('/api/thumbnails/', './'), thumbfile)
	

        // Check if the file exists asynchronously
        var fileExists = await fse.pathExists(fullPath)
        if (!fileExists) {
			// for pdf there are no smaller thumbnails currently
			if(f == 'thumbnail.jpg') {
				thumbfile = 'preview.jpg'
				fullPath = path.join(base.replace('/api/thumbnails/', './'), 'preview.jpg')
				var fileExists = await fse.pathExists(fullPath)
			}
			if (!fileExists) {
				fullPath = path.join('images/image_not_found.jpg')
			}
			
        }
		return fs.createReadStream(fullPath)

	} catch (err) {
		console.log('thumbnail not found')
		return false;
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

		return summary;


	} catch(e) {
		console.log('erro in NER summary', e)
		return null
	}
}

function JSON2text(data) {
	try {
		var str_json = []
		
		// Check if data contains newlines and might be NDJSON
		if (data.includes('\n') && data.trim().split('\n').length > 1) {
			// Try to parse as newline-delimited JSON (NDJSON)
			var lines = data.trim().split('\n')
			var validJsonLines = []
			var hasValidJson = false
			
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim()
				if (line) {
					try {
						var jsonObj = JSON.parse(line)
						validJsonLines.push(jsonObj)
						hasValidJson = true
					} catch (lineError) {
						// If any line fails to parse as JSON, fall back to regular JSON parsing
						break
					}
				}
			}
			
			// If we successfully parsed multiple lines as JSON objects, treat as NDJSON
			if (hasValidJson && validJsonLines.length > 1) {
				str_json.push('NDJSON Data (' + validJsonLines.length + ' objects):')
				validJsonLines.forEach((jsonObj, index) => {
					str_json.push('Object ' + (index + 1) + ':')
					processObject(jsonObj, '  ')
				})
				return str_json.join('\n')
			}
		}
		
		// Fall back to regular JSON parsing
		var json = JSON.parse(data)
		
		function processValue(key, value, indent = '') {
			if (Array.isArray(value)) {
				// Handle arrays
				str_json.push(indent + key + ':')
				value.forEach((item) => {
					if (typeof item === 'object' && item !== null) {
						processObject(item, indent + '  ')
					} else {
						str_json.push(indent + '  - ' + item)
					}
				})
			} else if (typeof value === 'object' && value !== null) {
				// Handle objects
				str_json.push(indent + key + ':')
				processObject(value, indent + '  ')
			} else {
				// Handle primitives
				str_json.push(indent + key + ': ' + value)
			}
		}
		
		function processObject(obj, indent = '') {
			for (var key in obj) {
				processValue(key, obj[key], indent)
			}
		}
		
		// Handle root level
		if (Array.isArray(json)) {
			// If root is an array
			json.forEach((item) => {
				if (typeof item === 'object' && item !== null) {
					processObject(item, '')
				} else {
					str_json.push('- ' + item)
				}
			})
		} else {
			// If root is an object
			processObject(json)
		}
		
		return str_json.join('\n')
	} catch(e) {
		return ''
	}
}

async function checkFileExists(filePath) {
	try {
	  	await fse.access(filePath);
	  	return true;
	} catch (err) {
		return false;
	}
}



export default media