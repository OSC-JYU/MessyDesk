
const util			= require('util');
const path 			= require('path');
const {pipeline} 	= require('stream');
const fs 			= require('fs');
const fsPromises 	= require('fs').promises;
const { Kafka }     = require('kafkajs');
var FormData        = require('form-data');



process.env.KAFKAJS_NO_PARTITIONER_WARNING=1

const KAFKA_URL = "localhost:9094"


let queue = {}
queue.services = {}

const kafka = new Kafka({
    clientId: "messydesk",
    brokers: [KAFKA_URL], // Replace with your Kafka broker address
});




queue.init = async function() {

    queue.got = await import('got')

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

queue.callFileService = async function(message, service, me_email) {
    try {
//        console.log(service.url)
        var data = JSON.parse(message.value.toString())
        console.log('callservice...')
        // console.log(message.value.toString())
        // console.log(data.content)


        if(service.api_type.toLowerCase() == 'elg') {
          if(service.type == 'text') {
            await ELG_api_text(data, service)
          } else {
            await ELG_api_binary(data, service)
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

async function ELG_api_text(data, service) {

    const got = await import('got');
    
    // read text to JSON object (content)
    const filePath = data.file.path
    const outputStream = fs.createReadStream(filePath, 'utf8');
    
    let content = '';
    
    outputStream.on('data', (data) => {
      console.log(data)
      content += data;
    });
    
    outputStream.on('end', async() => {
      console.log('stream ended.')
      data.content = content
  

      try {
        const {response} = await got.default.post(service.url + service.api, {
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




async function ELG_api_binary(data, service) {
  try {
    const { default: got } = await import('got');
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

    const response = await got.post(service.url + service.api, {
      body: formData,
      headers: formData.getHeaders(),
    });

    console.log(response.body);
  } catch (error) {
    console.error('Error sending the files:', error);
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
