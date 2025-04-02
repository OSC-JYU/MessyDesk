const fs 			= require('fs').promises;
const path 			= require('path');
const web 		= require('./web.js');
const nomad 		= require('./nomad.js');
//const queue = require('./queue.js');

let services = {service_list: {}}

services.loadServiceAdapters = async function (service_path = 'services') {
	const directoryPath = service_path
	try {
		// Create an object to store the results
		const servicesObject = {};

		// Read the subdirectories in the specified directory
		const subdirectories = await fs.readdir(directoryPath, { withFileTypes: true })
			.then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));

		// Loop through each subdirectory
		for (const subdirectory of subdirectories) {
			// Get the path to the JSON file in the subdirectory
			const filePath = path.join(directoryPath, subdirectory)

			try {
				// Read the content of the JSON file
				const fileContent = await fs.readFile(path.join(filePath, 'service.json'), 'utf-8');

				// Parse the JSON content
				const jsonData = JSON.parse(fileContent);
				jsonData['path'] = filePath
				jsonData['consumers'] = []

				// mark nomad services
				try {
					const nomadFile = await fs.readFile(path.join(filePath, 'nomad.hcl'), 'utf-8');
					if(nomadFile) {
						jsonData['nomad'] = true
						jsonData['nomad_hcl'] = nomadFile
					}
					else jsonData['nomad'] = false

				} catch(e) {}

				// Add the data to the result object with the subdirectory name as the key
				servicesObject[subdirectory] = jsonData;
			} catch (error) {
				console.error(`Error reading or parsing JSON file in ${subdirectory}: ${error.message}`);
			}


		}

		this.service_list = await markRegisteredAdapter(servicesObject)
		this.service_list['solr'] = {consumers:[], id:'solr', supported_types: []	}
		return this.service_list

	} catch (error) {
		console.error(`Error reading subdirectories: ${error.message}`);
		throw error;
	}
}


function sleep(ms) {
	return new Promise((resolve) => {
	  setTimeout(resolve, ms);
	});
  } 

services.getServices = function () {
	//this.service_list = await markRegisteredAdapter(this.service_list)
	return this.service_list
}


services.getServicesForFile = async function(file, filter, user, prompts) {

	const matches = {for_type: [], for_format: []}
	if(!file) return matches
	console.log('here', file['@type'])

	for(var service in this.service_list) {

		
		// for Sets we compare only extensions
		if(file['@type'] == 'Set') {
			if(this.service_list[service].consumers.length > 0) {
				var service_with_tasks = pickTasks(this.service_list[service], file.extensions, filter, user, prompts, file.type)
				if(service_with_tasks) {
					matches.for_format.push(service_with_tasks)
				}
			}	
		// services for data sources like Nextcloud
		} else if (file['@type'] == 'Source') {
			console.log(file.type)
			console.log(this.service_list[service])
			if(this.service_list[service].consumers.length > 0) {
				console.log(file.type)
				console.log(this.service_list[service])
				var service_with_tasks = pickTasks(this.service_list[service], file.type, filter, user, prompts, file.type)
				if(service_with_tasks) {
					matches.for_format.push(service_with_tasks)
				}
			}			
				
		// for Files we compare first type and then extension
		} else {
			// check service for supported types
			if(this.service_list[service].supported_types.includes(file.type)) {
				// we take only services that has consumer app listening (i.e are active services)
				if(this.service_list[service].consumers.length > 0) {
					var service_with_tasks = pickTasks(this.service_list[service], [file.extension], filter, user, prompts, file.type)
					if(service_with_tasks) {
						matches.for_format.push(service_with_tasks)
					}
				}
			} 
		}


	}
	return matches
}


pickTasks = function(service, extensions, filter, user, prompts, file_type) {

	const service_object = JSON.parse(JSON.stringify(service))
	service_object.tasks = {}

	// if service has service groups, check if user has access to any of them
	// if not, return empty object
	if(service_object.service_groups) {
		if(!service_object.service_groups.some(value => user.service_groups.includes(value))) {
			return 
		}
	}

	// LLM services have tasks defined in prompts
	if(service_object.external_tasks) {
		service_object.tasks = promptsToTasks(prompts, file_type)
		return service_object
	}

	for(var task in service.tasks) {

		if(service.tasks[task].service_groups) {
			if(!service.tasks[task].service_groups.some(value => user.service_groups.includes(value))) {
				continue
			}
		}

		// if task has its own supported formats then compare to file extension
		if(service.tasks[task].supported_formats) {
			if(service.tasks[task].supported_formats.some(value => extensions.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
			
		// otherwise compare file extension to service's supported formats
		} else {
			if(service.supported_formats.some(value => extensions.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
			
		}
		
	}	
	return service_object
}

filterTask = function(filter, task) {
	// When filter is provided, we return only tasks that has that filter that matches to query filter
	if(filter) {
		if(task.filter && task.filter == filter) {
			return true
		}
		return false

	// by default we filter out tasks with "filter" property
	} else if(!task.filter) {
		return true
	}

	return false

}

promptsToTasks = function(prompts, file_type) {

	var tasks = {}

	for(var prompt of prompts) {
		prompt.system_params = {prompts: {content: prompt.content}}
		
		if(prompt.type == file_type) {
			tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
		}
	}
	return tasks
}

checkService = function(array, service) {
	// check if service already exists
	for (const obj of array) {
		if (obj.id = service) {
		  return true;
		}
	}

}

// note: consumer here means consumer application, not NATS consumers
services.addConsumer = async function(service, id) {
	console.log(service)
console.log(this.service_list)
	if(this.service_list[service]) {
		this.service_list[service].consumers.push(id)
		return this.service_list[service]
	}
	return {error: 'service not found', name: service}
}

// note: consumer here means consumer application, not NATS consumers
services.removeConsumer = async function(service, id) {

	if(this.service_list[service]) {
		let arr = this.service_list[service].consumers.filter(item => item !== id)
		this.service_list[service].consumers = arr 
		return this.service_list[service]
	}
	return {error: 'service not found for deletion', name: service}
}

services.getServiceAdapterByName = function(name) {
	if (this.service_list[name]) {
		return this.service_list[name]
	} else {
		throw(`Service adapter not found for service "${name}"`)
	}
}


async function markRegisteredAdapter(services) {
	
	for(var key in services) {
		const service_url = await nomad.getServiceURL(key)
		if(service_url) {
			services[key].url = service_url
			services[key].nomad = true
		} else {
			services[key].url = ''
			services[key].nomad = false
		}
	}

	return services
}


module.exports = services