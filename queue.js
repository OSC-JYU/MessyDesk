
const util			= require('util');
const path 			= require('path');
const {pipeline} 	= require('stream');
const fs 			= require('fs');
const fsPromises 	= require('fs').promises;
const { Kafka }     = require('kafkajs');
var FormData        = require('form-data');

const Graph 		= require('./graph.js');


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
            // console.log({
            //   value: message.value.toString(),
            // })
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

queue.ELG_api_text = async function(data, service) {

    // read text to JSON object (content)
    const filePath = data.file.path
    const outputStream = fs.createReadStream(filePath, 'utf8');
    
    let content = '';
    
    outputStream.on('data', (chunk) => {
      console.log(chunk)
      content += chunk;
    });
    
    outputStream.on('end', async() => {
      console.log('stream ended.')
      data.content = content
      delete(data.process)
      delete(data.file)
      console.log(data)
      try {
        const {response} = await this.got.post(service.url + service.api, {
          json: data
        }).json();
        console.log(response)

      } catch(e) {
        console.log(e)
      }

    });
    
    outputStream.on('error', (error) => {
      console.error(`Error reading file: ${error}`);
    });

}




queue.ELG_api_binary = async function(data, service) {
  try {
    const formData = new FormData();


    // Append JSON file
    const jsonContent = { type: 'pdf', params: {task: 'pdf2text'} };

    formData.append('request', JSON.stringify(jsonContent), {contentType: 'application/json',
    filename: 'request.json'});

    // append content file
    const filepath = data.file.path
    const binaryReadStream = fs.createReadStream(filepath);
    formData.append('content', binaryReadStream, { filename: 'content.pdf', contentType: 'application/pdf'  });

    console.log('Sending files via POST request...');

    const response = await this.got.post(service.url + service.api, {
      body: formData,
      headers: formData.getHeaders(),
    }).json();

    console.log(response.response);
    await this.getFilesFromStore(response.response, data, service)

  } catch (error) {
    console.error('Error sending the files:', error);
  }
}



queue.getFilesFromStore = async function(response, data, service) {

  if(response.uri) {
    const filename = path.basename(response.uri)
    const filepath = path.join(data.process.path, filename)
    // download array of files
    if(Array.isArray(response.uri)) {
      
    // download single file
    } else {
      // first, create file object to graph
      // process_rid, file_type, extension, label
      const fileNode = await this.graph.createProcessFileNode(data.process['@rid'], 'text', 'txt', 'text.txt')

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



async function imaginary() {

    const imageFilePath = './test/files/sorsa.jpg'; // Replace with the actual image file path
    const imageDestinationUrl = 'http://localhost:9000/blur?sigma=20'; // Replace with the actual image destination URL
    const savedImageFilePath = './saved-image.jpg'; // Replace with the desired file path to save the returned image
    

    try {
        const got = await import('got');
        
        const readStream = fs.createReadStream(imageFilePath);
        const formData = new FormData();
        formData.append('file', readStream);
        
        console.log('Sending image via POST request...');
        
        const postStream = queue.got.default.stream.post(imageDestinationUrl, {
          body: formData,
          headers: formData.getHeaders(),
        });
        
        const writeStream = fs.createWriteStream(savedImageFilePath);
        
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



module.exports = queue
