import got from 'got';
import { SOLR_URL, SOLR_CORE } from './env.mjs';

const solr = {}

solr.search = async function(data, user_rid) {
	console.log(user_rid)
	const query = data.query;

	//const filters = []; 
	const params = {
		params:{
			q: query,
			defType: "edismax",
			qf: "fulltext^5",
			pf: "fulltext^5",
			hl: true,
			"hl.fl": "fulltext",
			"hl.simple.pre": "<em>",
			"hl.simple.post": "</em>",
			"hl.snippets": 3,
			"hl.fragsize": 100,
			wt: "json",
			fl: "description,label,id,owner",
			fq: `owner:${user_rid}`
			

		}
		
	};

  	const finalUrl = `${SOLR_URL}/${SOLR_CORE}/query?fq=type:text`;

	console.log(JSON.stringify(params, null, 2))

	if(!data.query) {		
		return []
	} 
	
	try {
		var response = await got.post(finalUrl, {json: params}).json()
		console.log(response)
		return response
		
		
	} catch(e) {
		console.log(e.message)
		throw({msg: 'error in query', query: data, error: e})
	}
}

solr.dropSetIndex = async function(set_rid) {
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`;
	try {
	  const response = await got.post(url, {
		json: {
		  delete: { query: `set_process:"${set_rid}"` }
		},
		responseType: 'json'
	  });
	  return response.body;
	} catch (e) {
	  console.error('Solr delete error:', e.response?.body || e.message);
	}
  };

solr.dropUserIndex = async function(userRID) {
	
	var url = `${SOLR_URL}/${SOLR_CORE}/delete?q=owner:" + userRID + "&wt=json`
	try {
		var response = await got.get(url).json()
		return response
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}
}

solr.indexDocuments = async function(data) {
	if(!options) var options = {}
	const url = `${SOLR_URL}/${SOLR_CORE}/update?commit=true`

	try {
		var response = await got.post(url, {json: data}).json()
		return response
	} catch(e) {
		console.log(e.message)
		//throw({msg: 'error in query', query: data, error: e})
	}

}




export default solr