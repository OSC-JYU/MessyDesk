
const util			  = require('util');
const path 			  = require('path');
const {pipeline} 	= require('stream/promises');
const fs 			    = require('fs-extra');
const { Kafka }   = require('kafkajs');
var FormData      = require('form-data');
const { uuid }    = require('uuidv4');

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

    try {
        console.log('connecting kafka: ' + KAFKA_URL)

    
        queue.producer = kafka.producer()
        queue.admin = kafka.admin()

        await queue.producer.connect()
        
        console.log(`connected to Kafka at ${KAFKA_URL}!`)

      } catch (error) {
        console.error("\nERROR: Kafka connection failed!\n")
        console.log(error.message);
        process.exit(1)
      }
    
}



queue.checkService = async function(data) {
  // test that service is alive before creating the topic
  console.log(data)

  // test if topic exists and if not, then create it
  await queue.admin.connect()
  var topics = await queue.admin.listTopics()
  if(!topics.includes(data.id)) {
    await queue.admin.createTopics({topics:[
      {topic: data.id}
    ]})
  }
}

queue.registerService = async function(data) {

    if(data.id && data.url && data.api && data.supported_formats && data.supported_types && data.name && data.api_type) {

        await this.checkService(data)

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
        } else if(service.api_type.toLowerCase() == 'thumbnail') {
          await this.thumbnailer_api(message_json, service)
        } else if(service.api_type.toLowerCase() == 'imaginary') {
          const fileNode = await this.imaginary_api(message_json, service)
          await this.thumbnailer_api(message_json, service, fileNode)
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



queue.thumbnailer_api = async function(message, service, filenode) {

  //create preview and thumbnails images

  try {
    console.log('**************** THUMBNAILER api ***************')
    console.log(message)

    var filepath = message.file.path
    if(filenode) {
      filepath = filenode.result[0].path
    } 

    const got = await import('got');

    const readStream = fs.createReadStream(filepath);
    const formData = new FormData();
    formData.append('file', readStream);
    
    console.log('Sending image via POST request...');

    var thumb_path = ''
    var preview_path = ''
    try {
      await fs.ensureDir(path.dirname(filepath))
      thumb_path = path.join(path.dirname(filepath), "thumbnail.jpg")
      preview_path = path.join(path.dirname(filepath), "preview.jpg")
    } catch(e) {
      throw('Could not create file directory!' + e.message)
    }

    // preview
    var url = service.url + service.api +  'thumbnail?width=800&type=jpeg' 
    const postStream = queue.got.stream.post(url, {
      body: formData,
      headers: formData.getHeaders(),
    });
    
    const previewStream = fs.createWriteStream(preview_path);
    await pipeline(postStream, previewStream)

    // thumbnail
    const readStream2 = fs.createReadStream(filepath);
    const formData2 = new FormData();
    formData2.append('file', readStream2);
    
    url = service.url + service.api +  'thumbnail?width=200&type=jpeg' 
    const postStream2 = queue.got.stream.post(url, {
      body: formData2,
      headers: formData2.getHeaders(),
    });

    const thumbStream = fs.createWriteStream(thumb_path);
    await pipeline(postStream2, thumbStream)

  } catch (error) {
    console.error('Error reading, sending, or saving the image:', error.message);
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
    const fileNode = await Graph.createProcessFileNode(message.process['@rid'], 'image', path.extname(filepath).replace('.',''), path.basename(filepath))
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
      const postStream = queue.got.stream.post(url, {
        body: formData,
        headers: formData.getHeaders(),
      });
      
      console.log(writepath)
      const writeStream = fs.createWriteStream(writepath);
 
      await pipeline(postStream, writeStream)
      return fileNode
      
    } catch (error) {
      console.error('Error reading, sending, or saving the image:', error.message);
    }
}




queue.ELG_api_text = async function(message, service) {

  console.log('**************** ELG api text ***************')
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
        const fileNode = await Graph.createProcessFileNode(process_rid, 'data', 'json', 'response.json')
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
    message.type = service.type
    //const jsonContent = { type: service.type, params: message.params };

    // provide parameters as json format
    formData.append('request', JSON.stringify(message), {contentType: 'application/json',
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



queue.getFilesFromStore = async function(response, message, service) {

  if(response.uri) {
 
    // download array of files
    if(Array.isArray(response.uri)) {
      for(var uri of response.uri) {
        await this.downLoadFile(message, uri, service)
      }
    // download single file
    } else {
      // first, create file object to graph
      // process_rid, file_type, extension, label
      await this.downLoadFile(message, response.uri, service)
    }
  } else {
    console.log('File download not found!')
  }
}



queue.downLoadFile = async function(message, uri, service) {
  // get file type from extension
  var ext = path.extname(uri).replace('.', '')
  var filename = uri.split('/').pop()
  var type = 'text'
  if(['png','jpg'].includes(ext)) type = 'image'


  const fileNode = await Graph.createProcessFileNode(message.process['@rid'], type, ext, filename)
  console.log(fileNode)
  var filepath = ''

  try {
    filepath = fileNode.result[0].path
    await fs.ensureDir(path.dirname(filepath))
  } catch(e) {
    throw('Could not create file directory!' + e.message)
  }

  const url = service.url + uri
  console.log(url)
  const downloadStream = this.got.stream(url);
  const fileWriterStream = fs.createWriteStream(filepath);

  try {
    await pipeline(downloadStream, fileWriterStream)

    const topic = 'thumbnailer' 
    const k_message = {
      key: "md",
      value: JSON.stringify({file: fileNode.result[0]})
    };
  
    await this.producer.send({
      topic,
      messages: [k_message],
    });
  } catch(e) {
    console.log(e)
    console.log('File download failed!')
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
