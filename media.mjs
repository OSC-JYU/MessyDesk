import path from 'path';
import fs from 'fs';
import fse from 'fs-extra';


import util from 'util';
import stream from 'stream';
import sizeOf from 'image-size';
import archiver from 'archiver';
import os from 'os';


const TYPES = ['image', 'text'] 


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

	message.params.left = leftPixels;
	message.params.top = topPixels;
	message.params.areawidth = finalWidth;
	message.params.areaheight = finalHeight;
	
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

  media.createZip = function(files, ctx) {
	const archive = archiver('zip', { zlib: { level: 9 } });
	const zipName = 'files.zip';
  
	// Set the response headers
	ctx.attachment(zipName);
	ctx.set("Content-Type", "application/zip");
  
	// Pipe the archive data to the response
	archive.pipe(ctx.res);
  
	// Add files to the archive
	files.forEach((file) => {
	  const filePath = path.resolve(file);
	  const fileName = path.basename(file);
  
	  if (fse.existsSync(filePath)) {
		archive.file(filePath, { name: fileName });
	  } else {
		console.error(`File not found: ${filePath}`);
	  }
	});
  
	// Finalize the archive
	archive.finalize();
  }
// NOTE: this removes parent directory! (the basename is stripper away)
  media.deleteNodePath = async function(dir) {
	try {
		var p = path.dirname(dir)
		if(p == 'data/projects' || p == 'data/projects/') throw('Protecting projects dir!')
		await fse.remove(p)
	} catch(e) {
		console.log('error deleting node data directory. ' + e)
		//throw('Could not delete directory!' + e.message)
	}	
}


media.createDataDir = async function(data_dir) {
	try {
		//await fse.ensureDir(data_dir)
		await fse.ensureDir(path.join(data_dir, 'projects'))
		await fse.ensureDir(path.join(data_dir, 'uploads'))
		await fse.ensureDir(path.join(data_dir, 'layouts'))
	} catch(e) {
		throw('Could not create data directory!' + e.message)
	}
}

media.createProjectDir = async function(project, data_dir) {
	const rid = this.rid2path(project['@rid'])
	try {
		await fse.ensureDir(path.join(data_dir, 'projects', rid, 'files'))
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

	console.log(filegraph)
	console.log(uploadpath)
	var file_rid = filegraph['@rid']
	var filepath = filegraph.path.split('/').slice( 0, -1 ).join('/')

	var filedata = null
	try {
		await fse.ensureDir(path.join(filepath, 'process'))
	
		//filedata.filepath = path.join(data_dir, filepath, this.rid2path(file_rid) + '.' + filedata.extension)
		var exists = await checkFileExists(filegraph.path)
		if(!exists) {
			await fse.move(uploadpath, filegraph.path);
			filedata = await this.getImageSize(filegraph.path)
			console.log('File moved successfully!')
			//ctx.body = 'done';
		} else {

			//await fs.unlink(uploadpath)
			throw('file exists!')
		}

		return filedata

	} catch (e) {
		console.log(e.message)
		await fse.unlink(uploadpath)
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
		return filedata
	}	
}

media.saveThumbnail = async function(uploadpath, basepath, filename) {
	console.log(filename)
	const filedata = {}
	try {
		await fse.ensureDir(path.join(basepath))
		const filepath = path.join(basepath, filename)
		console.log(uploadpath)
		console.log(filepath)

		await fse.move(uploadpath, filepath);
		console.log('File moved successfully!')

		return filedata

	} catch (e) {
		await fse.unlink(uploadpath)
		console.log(e.message)
		throw('thumbnail saving failed')
	}
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
		console.log('Data successfully written to params.json!');
	  } catch (error) {
		console.error('Error writing data to params.json:', error);
	  }

}

media.detectType = async function(file) {
	const originalFilename = file.hapi.filename;
	const mimeType = file.hapi.headers['content-type'];
    var extension = path.extname(originalFilename)

    var ftype = mimeType.split('/')[0]
    console.log(ftype)
    if(TYPES.includes(ftype)) {
        return ftype
    } else if(mimeType == 'application/pdf') {
        return 'pdf'
    } else if(mimeType == 'application/octet-stream') {
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
			//return first + '\n' + ' -lines: ' + linecount + '\n' + ' -characters:' + data.length
			return first 
		}

	  } catch (error) {
		console.error('Error reading file:', error);
		return ''
	  }
}


media.getThumbnail = async function(filePath) {
	console.log(filePath)
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
		console.log(fullPath)

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
	  	await fse.access(filePath);
	  	return true;
	} catch (err) {
		return false;
	}
}

media.createZipAndStream = async function(fileList, ctx, set_rid) {
    try {
        if (!fileList || fileList.length === 0) {
            ctx.status = 404;
            ctx.body = 'No files found to zip';
            return;
        }

        console.log(set_rid)
        const filename = `files_${set_rid.replace('#', '')}.zip`
        // Create a temporary file path for the zip
        const tempZipPath = path.join(os.tmpdir(), filename);
        
        // Create a write stream to the temporary file
        const output = fs.createWriteStream(tempZipPath);
        
        // Create a new archive with compression
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });
        
        // Set up event handlers for the archive
        archive.on('error', (err) => {
            console.error('Archive error:', err);
            throw err;
        });
        
        // Pipe the archive to the output file
        archive.pipe(output);
        
        // Add README.txt with creation date
        const creationDate = new Date().toISOString();
        const readmeContent = `Zip Archive Creation Details:
Created on: ${creationDate}
Number of files: ${fileList.length}
Set ID: ${set_rid}`;
        
        archive.append(readmeContent, { name: 'README.txt' });
        
        // Add files to the archive
        let filesAdded = false;
        for (const filePath of fileList) {
            const fullPath = path.resolve(filePath);
            if (await fse.pathExists(fullPath)) {
                archive.file(fullPath, { name: path.basename(filePath) });
                filesAdded = true;
            } else {
                console.error(`File not found: ${fullPath}`);
            }
        }

        if (!filesAdded) {
            ctx.status = 404;
            ctx.body = 'No valid files found to zip';
            return;
        }

        // Finalize the archive
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.finalize();
        });

        // Set response headers
        ctx.set('Content-Type', 'application/zip');
        ctx.set('Content-Disposition', 'attachment; filename="' + filename + '"');
        
        // Send the file
        ctx.body = fs.createReadStream(tempZipPath);
        
        // Clean up the temporary file after sending
        ctx.res.on('finish', () => {
            fse.unlink(tempZipPath, (err) => {
                if (err) console.error('Error deleting temporary zip file:', err);
            });
        });

    } catch (err) {
        console.error('Error in createZipAndStream:', err);
        ctx.status = 500;
        ctx.body = 'Error creating zip file';
	}
}

export default media