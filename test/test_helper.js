const DB_HOST = 'http://localhost'
const DB = 'messydesk'
const PORT = 2480
const URL = `${DB_HOST}:${PORT}/api/v1/command/${DB}`


const axios = require("axios")
const fs = require('fs-extra');

const DATA_DIR = './data'

const config = {
	auth: {
		username: 'root',
		password: 'node_master'
	}
};


before((done) => {
	(async (done) => {
		try {
			var url = URL.replace(`/command/${DB}`, '/server')
			await axios.post(url, {command: `drop database ${DB}`}, config)
		} catch(e) {
			console.log(e)
			console.log('Dropping database failed') 
		}

		try {
			await axios.post(url, {command: `create database ${DB}`}, config)
			await createVertexType('Person')
			await createVertexType('File')
			await createVertexType('Process')
			await createVertexType('Project')
	
			const query = "CREATE Vertex Person CONTENT {id:'local.user@localhost', label:'Just human'}"

			await axios.post(URL, {command: query, language: 'sql'}, config)
		} catch(e) {
			console.log('Could not create database')
			throw('error')
		}

		try {
			// Remove all data from data directory
			const pathExists = await fs.pathExists(DATA_DIR);
			if (!pathExists) {
				console.log("Path does not exist.");
				return;
			}
	
			// Remove all files and directories within the path
			await fs.emptyDir(DATA_DIR);
			console.log("All files and directories removed successfully.");
		} catch (err) {
			console.error("Error removing files and directories:", err);
		}




	})().then(() => {
		done();
	})
});


async function createVertexType(type) {
	var query = `CREATE VERTEX TYPE ${type} IF NOT EXISTS`
	var response = await axios.post(URL, {command: query, language: 'sql'}, config)
}