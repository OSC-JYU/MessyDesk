import path from 'path';
import fs from 'fs';

import nomad from './nomad.mjs';
//const queue = require('./queue.js');

const services = {service_list: {}}

function filterTask(filter, task) {
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



function checkService(array, service) {
	// check if service already exists
	for (const obj of array) {
		if (obj.id = service) {
		  return true;
		}
	}
}

services.loadServiceAdapters = async function (service_path = 'services', nomad = false) {
	const directoryPath = service_path
	try {
		// Create an object to store the results
		const servicesObject = {};

		// Read the subdirectories in the specified directory
		const subdirectories = await fs.promises.readdir(directoryPath, { withFileTypes: true })
			.then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));

		// Loop through each subdirectory
		for (const subdirectory of subdirectories) {
			// Get the path to the JSON file in the subdirectory
			const filePath = path.join(directoryPath, subdirectory)

			try {
				// Read the content of the JSON file
				const fileContent = await fs.promises.readFile(path.join(filePath, 'service.json'), 'utf-8');

				// Parse the JSON content
				const jsonData = JSON.parse(fileContent);
				jsonData['path'] = filePath
				jsonData['consumers'] = []

				// mark nomad services
				try {
					const nomadFile = await fs.promises.readFile(path.join(filePath, 'nomad.hcl'), 'utf-8');
					if(nomadFile) {
						jsonData['nomad'] = true
						jsonData['nomad_hcl'] = nomadFile
					}
					else jsonData['nomad'] = false

				} catch(e) {
					//console.error(`Error reading nomad.hcl file in ${subdirectory}: ${e.message}`);
				}

				// Add the data to the result object with the subdirectory name as the key
				servicesObject[subdirectory] = jsonData;
			} catch (error) {
				console.error(`Error reading or parsing JSON file in ${subdirectory}: ${error.message}`);
			}


		}

		this.service_list = await markRegisteredAdapter(servicesObject, nomad)
		// add some default consumers (not vis)
		//this.service_list['solr'] = {consumers:[], id:'solr', supported_types: []	}
		//this.service_list['pdf-splitter'] = {consumers:[], id:'pdf-splitter', supported_types: []	}

		// We must loop over all services and fetch params_help from API
		// for(var service in this.service_list) {
		// 	for(var task in this.service_list[service].tasks) {
		// 		for(var param in this.service_list[service].tasks[task].params_help) {
		// 			if(this.service_list[service].tasks[task].params_help[param].values == '/api') {
		// 				this.service_list[service].tasks[task].params_help[param].values = await this.getParamsHelp(service, task, param)
		// 			}
		// 		}
		// 	}
		// }
		return this.service_list

	} catch (error) {
		console.error(`Error reading subdirectories: ${error.message}`);
		throw error;
	}
}

services.getParamsHelp = async function(service, task, param) {
	console.log(this.service_list[service])
	const url = this.service_list[service].url ? this.service_list[service].url : this.service_list[service].local_url
	if(url) {
		const response = await fetch(`${url}/params_help/${task}/${param}`)
		const data = await response.json()
		return data
	}
	return []
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


services.getService = function (service) {
	return this.service_list[service]
}

services.getServicesForNode = async function(node, filter, user, prompts) {

	// we first check supporter types (internal types)
	// if not found, we check supported formats

	const matches = {for_type: [], for_format: []}
	if(!node) return matches

	for(var service in this.service_list) {

		
		// for Sets we compare only extensions
		if(node['@type'] == 'Set') {
			// check if service is disabled for Sets
			if(this.service_list[service].set_disabled) {
				continue
			}
			if(this.service_list[service].consumers.length > 0) {
				var service_with_tasks = pickTasks(this.service_list[service], node.extensions, node.types, filter, user, prompts, node['@type'])
				if(service_with_tasks) {
					matches.for_format.push(service_with_tasks)
				}
			}	
		// services for data sources like Nextcloud
		} else if (node['@type'] == 'Source') {
			if(this.service_list[service].consumers.length > 0) {
				var service_with_tasks = pickTasks(this.service_list[service], [node.extension],[node.type], filter, user, prompts, node.type)
				if(service_with_tasks) {
					matches.for_format.push(service_with_tasks)
				}
			}			
				
		// for Files we compare first (internal)type and then extension
		} else if (node['@type'] == 'File') {
			if(this.service_list[service].consumers.length > 0) {
				var service_with_tasks = pickTasks(this.service_list[service], [node.extension], [node.type], filter, user, prompts, node.type)
				if(service_with_tasks) {
					matches.for_format.push(service_with_tasks)
				}
			}
		}
	}
	return matches
}

function pickTasks(service, extensions, types, filter, user, prompts, node_type) {
	const service_object = JSON.parse(JSON.stringify(service))
	service_object.tasks = {}


	//console.log(service_object)
	// if service has service groups, check if user has access to any of them
	// if not, return empty object
	if(service_object.service_groups) {
		if(!service_object.service_groups.some(value => user.service_groups.includes(value))) {
			return 
		}
	}

	// LLM services have tasks defined in prompts
	if(service_object.external_tasks) {

		service_object.models = pickModels(node_type, extensions, service_object)
		// without models we can not have tasks
		console.log('model count: ', Object.keys(service_object.models).length)
		if(Object.keys(service_object.models).length === 0) {
			service_object.tasks = {}
			return service_object
		}
		service_object.tasks = promptsToTasks(filter,prompts, node_type, extensions, service_object)
		return service_object
	}

	for(var task in service.tasks) {

		// task can be disabled/enabled by service_groups
		if(service.tasks[task].service_groups) {
			if(!service.tasks[task].service_groups.some(value => user.service_groups.includes(value))) {
				continue
			}
		}
		
		// task can be disabled for Sets
		if(node_type == 'Set') {
			if(service.tasks[task].set_disabled) {
				continue
			}
		}

		
		// if task has its own supported types then compare to node type (NOT @type!)
		if(service.tasks[task].supported_types && service.tasks[task].supported_types.length > 0) {
			console.log('supported types: ', service.tasks[task].supported_types)
			console.log('types: ', types)
			if(service.tasks[task].supported_types.some(value => types.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
		// if task has its own supported formats then compare to file extension
		} else if(service.tasks[task].supported_formats && service.tasks[task].supported_formats.length > 0) {
			if(service.tasks[task].supported_formats.some(value => extensions.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
		

		// otherwise compare file extension to service's supported formats
		} else if(service.supported_types && service.supported_types.length > 0) {
			if(service.supported_types.some(value => types.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
			
		} else if(service.supported_formats && service.supported_formats.length > 0) {
			if(service.supported_formats.some(value => extensions.includes(value))) {
				if(filterTask(filter, service.tasks[task]))
					service_object.tasks[task] = service.tasks[task]
			}
		}
		
	}
	if(Object.keys(service_object.tasks).length === 0) {
		return null
	}
	return service_object
}

function pickModels(type, extensions, service) {

	var models = {}

	for(var model in service.models) {
		// model must have same type than import node and one of the extensions must match supported formats
		if(service.models[model].supported_formats.some(value => extensions.includes(value))) {
			if(service.models[model].supported_types.includes(type) || type == 'Set') {
				models[model] = service.models[model]
			}
		}
	}
	return models	
}

function promptsToTasks(filter, prompts, type, extensions, service) {

	var tasks = {}

	// currently there are no filtered prompts
	if(filter) {
		return tasks
	}

	// if type is Set, we return all tasks that have supported formats
	if(type == 'Set') {
		for(var prompt of prompts) {
			prompt.system_params = {prompts: {content: prompt.content}}
			if(extensions.includes('txt') && prompt.type == 'text') {
				tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
			} else if(extensions.includes('pdf') && prompt.type == 'pdf') {
				tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
			} else if(extensions.includes('jpg') && prompt.type == 'image') {
				tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
			} else if(extensions.includes('png') && prompt.type == 'image') {
				tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
			}
		}
		// for(var prompt of prompts) {
		// 	prompt.system_params = {prompts: {content: prompt.content}}
		// 	if(service.supported_formats.some(value => extensions.includes(value))) {
		// 		if(service.supported_types.includes(prompt.type)) {
		// 			tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
		// 		}
		// 	}
		// }
	} else {
		for(var prompt of prompts) {
			prompt.system_params = {prompts: {content: prompt.content}}
			if(type == prompt.type) {
				tasks[prompt.name.toLowerCase().replace(/ /g, '_')] = prompt
			}	
		}
	}

	return tasks
}


services.addServiceAdapter = async function(service, id) {

	if(this.service_list[service]) {
		if(this.service_list[service].consumers.includes(id)) {
			return {status: 'consumer already exists', name: service}
		}
		this.service_list[service].consumers.push(id)
		return this.service_list[service]
	}
	return {error: 'service not found', name: service}
}

services.removeServiceAdapter = async function(service, id) {

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


async function markRegisteredAdapter(services, nomad = false) {
	
	for(var key in services) {
		if(nomad) {
			const service_url = await nomad.getServiceURL(key)
			services[key].url = service_url
			services[key].nomad = true
		} else {
			services[key].url = ''
			services[key].nomad = false
		}
	}

	return services
}


export default services