
const util			= require('util');
const path 			= require('path');
const {pipeline} 	= require('stream');
const fs 			= require('fs');
const fsPromises 	= require('fs').promises;
const { Kafka }     = require('kafkajs');
var FormData        = require('form-data');
;

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
    //got.default();

    try {
        console.log('connecting kafka: ' + KAFKA_URL)

    
        queue.producer = kafka.producer();

        await queue.producer.connect();
        console.log(`connected to Kafka at ${KAFKA_URL}!`)

      } catch (error) {
        console.error("Error running producer:", error);
      }
    
}



queue.add = async function(ctx) {

    console.log('adding to queue...')


}

queue.registerService = async function(data) {

    if(data.id && data.url && data.api && data.supported_formats && data.supported_types && data.name && data.api_type) {

        const consumer = kafka.consumer({ groupId: data.id})

        await consumer.connect()
        await consumer.subscribe({ topic: data.id, fromBeginning: false })

        // listen to heartbeat 
        consumer.on('consumer.heartbeat', () => {
            console.log('heartbeat')
        })

        await consumer.run({
          eachMessage: async ({ topic, partition, message,  heartbeat, pause }) => {
            // do actual processing
            await this.callService()
            console.log({
              value: message.value.toString(),
            })
          },
        })

    }

}

queue.callService = async function() {
    try {
        await imaginary();
        //const response = await axios.get('http://localhost:8200/api/stall');
        //console.log(response);
      } catch (error) {
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