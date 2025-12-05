// this script is to test the concurrent writes to the database
import got from 'got'
import db from '../db.mjs'

const test = async () => {
    var gotOptions = {
		username: 'root',
		password: 'node_master'
	}
    var response = await got.post('http://localhost:2480/api/v1/begin/test', gotOptions)
	const transactionId = response.headers['arcadedb-session-id']
    console.log('Transaction started:', transactionId)
    gotOptions.headers = {
        'arcadedb-session-id': transactionId
    }
    gotOptions.json = {language:'sql', command: 'Create Vertex File content {name: "Test1"}', params: null}
    var response2 = await got.post('http://localhost:2480/api/v1/command/test', gotOptions).json()
    console.log('Command executed:', response2)
    //await db.writeAndCommit('Create Vertex File content {name: "Test1"}', null, 3, 5000)
    //await writeWithTransaction('Create Vertex File content {name: "Test1"}', null, 3, 5000, tid)
    // let's wait for 1 second
    await new Promise(resolve => setTimeout(resolve, 1000))

    await got.post('http://localhost:2480/api/v1/commit/test', gotOptions)
    //await db.commit(tid)
    console.log('Transaction committed:', transactionId)
   
}

const test2 = async () => {

    await db.writeAndCommit('Create Vertex File content {name: "Test1"}', null, 3, 5000)
    console.log('Transaction committed')
    await new Promise(resolve => setTimeout(resolve, 1000))
   
}

const test3 = async () => {
    var tid = await db.startTransaction()
    await db.writeWithTransaction('Create Vertex File content {name: "Test1"}', null, 3, 5000, tid)
    await db.commit(tid)
    console.log('Transaction committed')
    await new Promise(resolve => setTimeout(resolve, 1000))
   
}

async function startTransaction() {
	var url = 'http://localhost:2480/api/v1/begin/test'
	var gotOptions = {
		username: 'root',
		password: 'node_master'
	}
	
	try {
		// get transaction id from response header
		var response = await got.post(url, gotOptions)
		const transactionId = response.headers['arcadedb-session-id']
		
		if (!transactionId) {
			throw new Error('No transaction ID returned from ArcadeDB')
		}
		
		//console.log('Transaction started:', transactionId)
		return transactionId
	} catch (error) {
		console.log('Failed to start transaction:', error.message)
		throw error
	}
}


async function writeWithTransaction(query, params, retries = 3, timeout = 5000, tid) {

	var gotOptions = {
		username: 'root',
		password: 'node_master',
		json: {language:'sql', command: query, params: params},
		headers: {
			'arcadedb-session-id': tid
		}
	}
	let lastError, response = null
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			response = await got.post('http://localhost:2480/api/v1/command/test', gotOptions).json()
			break // Success, exit retry loop
		} catch (error) {
			lastError = error
			console.log(`Write attempt ${attempt} failed:`, error.message)
			console.log(gotOptions.json)
			
			if (attempt < retries) {
				// Wait before retrying (exponential backoff)
				const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
				console.log(`Retrying write in ${delay}ms...`)
				await new Promise(resolve => setTimeout(resolve, delay))
			} else {
				throw new Error(`WriteWithTransaction: Failed to execute query after ${retries} attempts. Last error: ${lastError.message}`)
			}
		}
	}
	return response
}


for(let i = 0; i < 10; i++) {
    await test3()
    
}

