const fs 			= require('fs').promises;
const path 			= require('path');
const web 		= require('./web.js');
const nomad 		= require('./nomad.js');
//const queue = require('./queue.js');

let services = {service_list: {}}

services.loadServiceAdapters = async function () {
	const directoryPath = 'services'
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

services.getServices = async function () {
	this.service_list = await markRegisteredAdapter(this.service_list)
	return this.service_list
}


services.getServicesForFile = async function(file) {

	const matches = {for_type: [], for_format: []}
	if(!file) return matches
	
	for(var service in this.service_list) {
		if(this.service_list[service].supported_types.includes(file.type)) {
			// we take only services that has consumer app listening
			if(this.service_list[service].consumers.length > 0) {
				if(this.service_list[service].supported_formats.includes(file.extension)) {
					matches.for_format.push(this.service_list[service])
				} else {
					matches.for_type.push(this.service_list[service])
				}
			}
			

		}
	}
	return matches
}

// note: consumer here means consumer application, not NATS consumers
services.addConsumer = async function(service, id) {

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
	return {error: 'service not found', name: service}
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