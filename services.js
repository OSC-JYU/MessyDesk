const fs 			= require('fs').promises;
const path 			= require('path');
const web 		= require('./web.js');

let services = {}

services.getServiceAdapters = async function (enabledServices) {
	const directoryPath = 'test/services'
	try {
		// Create an object to store the results
		const resultObject = {};

		// Read the subdirectories in the specified directory
		const subdirectories = await fs.readdir(directoryPath, { withFileTypes: true })
			.then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name));

		// Loop through each subdirectory
		for (const subdirectory of subdirectories) {
			// Get the path to the JSON file in the subdirectory
			const filePath = path.join(directoryPath, subdirectory, 'service.json');

			try {
			// Read the content of the JSON file
			const fileContent = await fs.readFile(filePath, 'utf-8');

			// Parse the JSON content
			const jsonData = JSON.parse(fileContent);

			// Add the data to the result object with the subdirectory name as the key
			resultObject[subdirectory] = jsonData;
			} catch (error) {
				console.error(`Error reading or parsing JSON file in ${subdirectory}: ${error.message}`);
			}
		}

		const services = await markRegisteredAdapter(resultObject, enabledServices)
		return services

	} catch (error) {
		console.error(`Error reading subdirectories: ${error.message}`);
		throw error;
	}
}

services.getServiceAdapterByName = async function(name, enabledServices) {
	const adapters = await this.getServiceAdapters(enabledServices) 
	for(var adapter in adapters) {
		if(adapters[adapter].id == name) {
			return adapters[adapter]
		}
	}
	return {}
}

async function markRegisteredAdapter(services, enabledServices) {
	// check registered services
	if(enabledServices) {
		console.log(enabledServices)
		for(var key in services) {
			// check if service responds
			services[key].online = await web.checkService(services[key].url)
			if(key in enabledServices) {
				services[key].enabled = true

			}
		}
	}

	return services
}


module.exports = services