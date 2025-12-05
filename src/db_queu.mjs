
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'

export async function process_msg_old(service_url, message) {
    console.log('Processing message in process_a:', message.data);
}

export async function process_msg(service_url, message) {
    console.log('Processing message in process_a:', message.data);

    let payload, data
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        payload = message.json()
        data = JSON.parse(payload)
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        console.log(typeof data)
        console.log(data)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** ELG api ***************')
        console.log(data)
        console.log(data.target)
        console.log(payload)
        
        // get file from MessyDesk and put it in formdata
        const formData = new FormData();
        if(data.target) {
            var readpath = await getFile(MD_URL, data.target, data.userId)
            const readStream = fs.createReadStream(readpath);
            formData.append('content', readStream);
        }

        // provide message data as json file
        formData.append('message', Buffer.from(payload), {contentType: 'application/json', filename: 'message.json'});


        // send payload to service endpoint 
        var url = `${service_url}/process`
        console.log(url)
        const response = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        });
        
        //console.log(response)
        const file_list = JSON.parse(response.body)
        console.log(file_list)
        await getFilesFromStore(file_list.response, service_url, data, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.code)
        //console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, MD_URL)
        throw error
    }

}




//transaction trash



db.__startTransaction = async function() {
	var url = DB_URL.replace(`/command/`, '/begin/')
	var gotOptions = {
		username: username,
		password: password,
		timeout: {
			request: 10000 // 10 second timeout for transaction start
		}
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

db.__writeWithTransaction = async function(query, params, retries = 3, timeout = 5000, tid) {

	var gotOptions = {
		username: username,
		password: password,
		json: {language:'sql', command: query, params: params},
		headers: {
			'arcadedb-session-id': tid
		}
	}
	let lastError, response = null
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			response = await got.post(DB_URL, gotOptions).json()
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

db.__rollback = async function(transactionId) {
	console.log('DB: ', 'rolling back transaction', transactionId)
	var url = DB_URL.replace(`/command/`, '/rollback/')
	var gotOptions = {
		username: username,
		password: password,
		headers: {
			'arcadedb-session-id': transactionId
		}
	}
	await got.post(url, gotOptions)
}

db.__commit = async function(transactionId, retries = 3, timeout = 5000, lastquery) {
	if (!transactionId) {
		throw new Error('Cannot commit: No transaction ID provided')
	}
	
	var url = DB_URL.replace(`/command/`, '/commit/')
	var gotOptions = {
		username: username,
		password: password,
		headers: {
			'arcadedb-session-id': transactionId
		},
		timeout: {
			request: timeout
		}
	}
	
	let lastError
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await got.post(url, gotOptions)
			//console.log('Transaction committed successfully:', transactionId)
			return // Success, exit the function
		} catch (error) {
			lastError = error
			console.log(`Commit attempt ${attempt} failed:`, error.message)
			
			// Check if it's a "Transaction not begun" error
			if (error.message && error.message.includes('Transaction not begun')) {
				console.log('Transaction was not properly started, skipping rollback')
				throw new Error(`Transaction not begun - cannot commit. Query: ${lastquery}`)
			}
			
			if (attempt < retries) {
				// Wait before retrying (exponential backoff)
				const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
				console.log(`Retrying commit in ${delay}ms...`)
				await new Promise(resolve => setTimeout(resolve, delay))
			}
		}
	}
	
	// All retries failed
	// rollback transaction
	try {
		await this.rollback(transactionId)
	} catch (rollbackError) {
		console.log('Failed to rollback after commit failure:', rollbackError.message)
	}
	throw new Error(`Failed to commit transaction after ${retries} attempts. query: ${lastquery} Last error: ${lastError.message}`)
}


db.__writeAndCommit = async function(query, params, retries = 3, timeout = 5000) {
	let transactionId = null
	let response = null
	
	try {
		// Start transaction with retry logic
		let transactionStarted = false
		let lastTransactionError
		
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				transactionId = await this.startTransaction()
				if (transactionId) {
					transactionStarted = true
					break // Success, exit retry loop
				}
			} catch (error) {
				lastTransactionError = error
				console.log(`Transaction start attempt ${attempt} failed:`, error.message)
				
				if (attempt < retries) {
					// Wait before retrying (exponential backoff)
					const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
					console.log(`Retrying transaction start in ${delay}ms...`)
					await new Promise(resolve => setTimeout(resolve, delay))
				}
			}
		}
		
		if (!transactionStarted || !transactionId) {
			throw new Error(`Failed to start transaction after ${retries} attempts. Last error: ${lastTransactionError?.message || 'Unknown error'}`)
		}

		//console.log('DB: ', 'transaction started', transactionId)

		var gotOptions = {
			username: username,
			password: password,
			headers: {
				'arcadedb-session-id': transactionId
			},
			json: {language:'sql', command: query, params: params},
			timeout: {
				request: timeout
			}
		}
		
		let lastError
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				response = await got.post(DB_URL, gotOptions).json()
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
					throw new Error(`Failed to execute query after ${retries} attempts. Last error: ${lastError.message}`)
				}
			}
		}
	
		// Only commit if we have a valid transaction ID
		if (transactionId) {
			await this.commit(transactionId, retries, timeout, query)
		}
		return response

	} catch (error) {
		// If we have a transaction ID, try to rollback
		if (transactionId) {
			try {
				await this.rollback(transactionId)
			} catch (rollbackError) {
				console.log('Failed to rollback transaction:', rollbackError.message)
			}
		}
		throw error
	}
}

