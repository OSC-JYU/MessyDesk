
const util			  = require('util');
const path 			  = require('path');
const {pipeline} 	= require('stream');
const fs 			    = require('fs-extra');
const { Kafka }   = require('kafkajs');
var FormData      = require('form-data');

const Graph 		= require('./graph.js');
const media 		= require('./media.js');


process.env.KAFKAJS_NO_PARTITIONER_WARNING=1

const KAFKA_URL = "localhost:9094"


let queue = {}
queue.services = {}

const kafka = new Kafka({
    clientId: "messydesk",
    brokers: [KAFKA_URL], // Replace with your Kafka broker address
});




queue.init = async function() {

    const { default: got } = await import('got');
    this.got = got
    this.graph = new Graph()

    try {
        console.log('connecting kafka: ' + KAFKA_URL)

    
        queue.producer = kafka.producer();

        await queue.producer.connect();
        console.log(`connected to Kafka at ${KAFKA_URL}!`)

      } catch (error) {
        console.error("\nERROR: Kafka connection failed!\n")
        console.log(error.message);
        process.exit(1)
      }
    
}



queue.add = async function(ctx) {

    console.log('adding to queue...')


}

queue.registerService = async function(data) {

    if(data.id && data.url && data.api && data.supported_formats && data.supported_types && data.name && data.api_type) {
        queue.services[data.id] = data
        queue.services[data.id].consumer = await kafka.consumer({ groupId: data.id})

        await queue.services[data.id].consumer.connect()
        await queue.services[data.id].consumer.subscribe({ topic: data.id, fromBeginning: false })

        // listen to heartbeat 
        queue.services[data.id].consumer.on('consumer.heartbeat', () => {
            console.log('heartbeat ' + queue.services[data.id].id)
        })

        await queue.services[data.id].consumer.run({
          eachMessage: async ({ topic, partition, message,  heartbeat, pause }) => {
            // do actual processing
            await this.callFileService(message, queue.services[data.id])
          },
        })

    }

}

queue.callFileService = async function(message, service) {
    try {
        var message_json = JSON.parse(message.value.toString())

        if(service.api_type.toLowerCase() == 'elg') {
          if(service.type == 'text') {
            await this.ELG_api_text(message_json, service)
          } else {
           await this.ELG_api_binary(message_json, service)
          }
        } else if(service.api_type.toLowerCase() == 'imaginary') {
          await this.imaginary_api(message_json, service)
        }

      } catch (error) {
        console.log('PAM')
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.log(error.response.data);
            console.log(error.response.status);
            console.log(error.response.headers);
          } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js
            console.log(error.request);
          } else {
            // Something happened in setting up the request that triggered an Error
            console.log('Error', error.message);
          }
      }
    


}

queue.ELG_api_text = async function(message, service) {

  console.log('**************** ELG api binary ***************')
  console.log(message)

    // read text to JSON object (content)
    const filePath = message.file.path
    const outputStream = fs.createReadStream(filePath, 'utf8');
    
    let content = '';
    
    outputStream.on('data', (chunk) => {
      console.log(chunk)
      content += chunk;
    });
    
    outputStream.on('end', async() => {

      console.log('stream ended.')
      message.content = content
      process_rid = message.process['@rid']
      delete(message.process)
      delete(message.file)
      message.params.nbest = 1
      message.params.languages = ['fin','eng']
      message.type = "text"
      console.log(message)

      try {
        const {response} = await this.got.post(service.url + service.api, {
          json: message
        }).json();
        console.log(response)
        // first, create file object to graph
        // process_rid, file_type, extension, label
        const fileNode = await this.graph.createProcessFileNode(process_rid, 'data', 'json', 'response.json')
        try {
          filepath = fileNode.result[0].path
          await fs.ensureDir(path.dirname(filepath))
          await media.writeJSON(response, path.basename(filepath), path.dirname(filepath))
        } catch(e) {
          throw('Could not create file directory!' + e.message)
        }

      } catch(e) {
        console.log(e.message)
      }

    });
    
    outputStream.on('error', (error) => {
      console.error(`Error reading file: ${error}`);
    });

}




queue.ELG_api_binary = async function(message, service) {
  try {
    console.log('**************** ELG api binary ***************')
    console.log(message)
    const formData = new FormData();


    // Append JSON file
    const jsonContent = { type: service.type, params: {task: 'pdf2text'} };

    formData.append('request', JSON.stringify(jsonContent), {contentType: 'application/json',
    filename: 'request.json'});

    // append content file
    const filepath = message.file.path
    const binaryReadStream = fs.createReadStream(filepath);
    formData.append('content', binaryReadStream, { filename: 'content.pdf', contentType: 'application/pdf'  });

    console.log('Sending files via POST request...');

    const response = await this.got.post(service.url + service.api, {
      body: formData,
      headers: formData.getHeaders(),
    }).json();

    console.log(response.response);
    await this.getFilesFromStore(response.response, message, service)

  } catch (error) {
    console.error('Error sending the files:', error.message);
  }
}



queue.imaginary_api = async function(message, service) {

    //const imageDestinationUrl = 'http://localhost:9000/blur?sigma=20';

    try {
      console.log('**************** IMAGINARY api ***************')
      console.log(message)
        const got = await import('got');
        const filepath = message.file.path
        const readStream = fs.createReadStream(filepath);
        const formData = new FormData();
        formData.append('file', readStream);
        
        console.log('Sending image via POST request...');
        // first, create file object to graph
      // process_rid, file_type, extension, label
      const fileNode = await this.graph.createProcessFileNode(message.process['@rid'], 'image', path.extname(filepath).replace('.',''), path.basename(filepath))
      console.log(fileNode)
      var writepath = ''
      try {
        writepath = fileNode.result[0].path
        await fs.ensureDir(path.dirname(writepath))
      } catch(e) {
        throw('Could not create file directory!' + e.message)
      }
        const url_params = objectToURLParams(message.params)
        var url = service.url + service.api +  message.task + '?' + url_params
        console.log('**********************************')
        console.log(url)
        const postStream = queue.got.stream.post(url, {
          body: formData,
          headers: formData.getHeaders(),
        });
        
        console.log(writepath)
        const writeStream = fs.createWriteStream(writepath);
        
        pipeline(postStream, writeStream, (error) => {
          if (error) {
            console.error('Error sending or saving the image:', error);
          } else {
            console.log('Image sent and saved successfully.');
          }
        });
      } catch (error) {
        console.error('Error reading, sending, or saving the image:', error.message);
      }
}


queue.pdfsense_api = async function(message, service) {

  const imageDestinationUrl = 'http://localhost:9000/blur?sigma=20';

  try {
    console.log('**************** PDFSENSE api ***************')
    console.log(message)
    const got = await import('got');
    const filepath = message.file.path
    const readStream = fs.createReadStream(filepath);
    const formData = new FormData();
    formData.append('file', readStream);
    
    console.log('Sending image via POST request...');
    // first, create file object to graph
    // process_rid, file_type, extension, label
    const fileNode = await this.graph.createProcessFileNode(message.process['@rid'], 'image', path.extname(filepath).replace('.',''), path.basename(filepath))
    console.log(fileNode)
    var writepath = ''
    try {
      writepath = fileNode.result[0].path
      await fs.ensureDir(path.dirname(writepath))
    } catch(e) {
      throw('Could not create file directory!' + e.message)
    }
      const url_params = objectToURLParams(message.params)
      var url = service.url + service.api +  message.task + '?' + url_params
      console.log('**********************************')
      console.log(url)
      const postStream = queue.got.stream.post(url, {
        body: formData,
        headers: formData.getHeaders(),
      });
      
      console.log(writepath)
      const writeStream = fs.createWriteStream(writepath);
      
      pipeline(postStream, writeStream, (error) => {
        if (error) {
          console.error('Error sending or saving the image:', error);
        } else {
          console.log('Image sent and saved successfully.');
        }
      });
    } catch (error) {
      console.error('Error reading, sending, or saving the image:', error.message);
    }
}




queue.getFilesFromStore = async function(response, message, service) {

  if(response.uri) {
    const filename = path.basename(response.uri)
 
    // download array of files
    if(Array.isArray(response.uri)) {
      
    // download single file
    } else {
      // first, create file object to graph
      // process_rid, file_type, extension, label
      const fileNode = await this.graph.createProcessFileNode(message.process['@rid'], 'text', 'txt', 'text.txt')
      console.log(fileNode)
      var filepath = ''

      try {
        filepath = fileNode.result[0].path
        await fs.ensureDir(path.dirname(filepath))
      } catch(e) {
        throw('Could not create file directory!' + e.message)
      }

      const url = service.url + response.uri
      console.log(url)
      const downloadStream = this.got.stream(url);
      const fileWriterStream = fs.createWriteStream(filepath);

      downloadStream
      .on("downloadProgress", ({ transferred, total, percent }) => {
        const percentage = Math.round(percent * 100);
        console.error(`progress: ${transferred}/${total} (${percentage}%)`);
      })
      .on("error", (error) => {
        console.error(`Download failed: ${error.message}`);
      });

      fileWriterStream
      .on("error", (error) => {
        console.error(`Could not write file to system: ${error.message}`);
      })
      .on("finish", () => {
        console.log(`File downloaded to ${filepath}`);
      });
    
    downloadStream.pipe(fileWriterStream);

    }
  } else {
    console.log('File download not found!')
  }
}

function objectToURLParams(obj) {
  const params = [];

  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      let value = obj[key];
      if (Array.isArray(value)) {
        value.forEach((item) => {
          params.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(item)}`);
        });
      } else {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
  }

  return params.join('&');
}

module.exports = queue
