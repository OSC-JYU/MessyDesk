const fs 			= require('fs').promises;
const path 			= require('path');
const axios 		= require('axios');


const URL = 'http://localhost:4646/v1'

let nomad = {}



nomad.getStatus = async function() {
	const url = URL + '/status/leader'
	console.log('Connecting Nomad at ' + url)
	try {
		var response = await axios.get(url)
	} catch(error) {
		console.error("\nERROR: Nomad connection failed!\n")
        console.log(error.message);
        process.exit(1)	
	}

}

nomad.getJobs = async function() {
	var response = await axios.get(URL + '/jobs')
	return response.data
}

nomad.getServices = async function() {
	var response = await axios.get(URL + '/services')
	return response.data
}

nomad.getService = async function(service) {
	var response = await axios.get(URL + `/service/${service}`)
	return response.data
}

nomad.createService = async function(service) {
	if(service && service.nomad_hcl) {
		console.log(`NOMAD: creating service: ${service.id}`)
		try {
			if(process.env.PODMAN) {
				service.nomad_hcl = service.nomad_hcl.replace('driver = "docker"','driver = "podman"')
			}
			console.log(service.nomad_hcl)
			var c = service.nomad_hcl.replace(/"/g, '\\"').replace(/\n/g, '\\n')
			var js = `{"JobHCL":"${c}","Canonicalize":true}'`
			var response = await axios.post(URL + `/jobs/parse`, js)
			var response_create = await axios.post(URL + '/jobs', {Job:response.data})
			return response_create.data
		} catch (e) {
			console.log(e)
			throw(`Service start problem: "${e}"!`)
		}

	} else {
		throw(`nomad.hcl not found for "${service.id}"!`)
	}
}

nomad.getService = async function(service) {
	const url = URL + `/service/${service}`
	var response = await axios.get(url)
	if(response.data.length > 0) return response.data
}

nomad.getServiceURL = async function(service) {
	// NOTE: this gives only the first address
	const url = URL + `/service/${service}`
	console.log(url)
	var service_url = ''
	var response = await axios.get(url)
	if(response.data.length > 0) {
		service_url = `${response.data[0].Address}:${response.data[0].Port}`
	}
	return service_url
}

nomad.stopService = async function(service) {
	if(service) {
		var response_stop = await axios.delete(URL + '/job/' + service)
		return response_stop.data
	} else {
		throw(`nomad.hcl not found for "${service.id}"!`)
	}
}

module.exports = nomad