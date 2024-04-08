

import path from 'path';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';

import Graph from './graph.js';

import nomad from './nomad.js';
import services from './services.js';
import {got} from 'got';

import { connect, RetentionPolicy, AckPolicy } from "nats";

const servers =  "nats://localhost:4222";





export let queue = {}


queue.init = async function(services) {
  this.nc = await connect({
    servers: [servers],
  });
  this.js = this.nc.jetstream();
  const jsm = await this.js.jetstreamManager();
  await jsm.streams.add({
    name: "PROCESS",
    retention: RetentionPolicy.Workqueue,
    subjects: ["process.>"],
  });
  console.log("NATS: created the 'PROCESS' stream");

  // create consumers for all services
  console.log("NATS: creating consumers...")
  for(var key in services) {
    console.log(key)
    try {
      await jsm.consumers.add("PROCESS", {
        durable_name: key,
        ack_policy: AckPolicy.Explicit,
        filter_subject: `process.${key}`,
    
      });
    } catch(e) {
      console.log('NATS ERROR: could not create consumer', key)
      console.log(e)
    }
  }
}



queue.checkService = async function(data) {
  // get service url from nomad
  const service = await nomad.getServiceURL(data)
  return service
}


queue.publish = async function(topic, data, filenode) {
  console.log(topic)
  var service = await services.getServiceAdapterByName(topic)
  try {
    //var s = await this.checkService(topic)
    //if(!s) {
      //await nomad.createService(service)
    //}
    //const service_url = await nomad.getServiceURL(topic)
    //service.url = service_url
    //service.queue.add(service, data, filenode)
    await this.js.publish("process.md-imaginary", JSON.stringify(data))
  } catch(e) {
    console.log('Could not add to queue!', e)
  }
}








// queue.getFileCallback = function(service) {

//   if(service.api_type.toLowerCase() == 'elg') {
//     if(service.type == 'text') {
//       return this.ELG_api_text
//     } else {
//       return this.ELG_api_binary
//     }
//   } else if(service.api_type.toLowerCase() == 'thumbnail') {
//     return this.thumbnailer_api
//   } else if(service.api_type.toLowerCase() == 'imaginary') {
//     return this.imaginary_api
//   } 

// }

// queue.callFileService = async function(message, service) {
//     try {
//         var message_json = JSON.parse(message.value.toString())

//         if(service.api_type.toLowerCase() == 'elg') {
//           if(service.type == 'text') {
//             await this.ELG_api_text(message_json, service)
//           } else {
//             await this.ELG_api_binary(message_json, service)
//           }
//         } else if(service.api_type.toLowerCase() == 'thumbnail') {
//           await this.thumbnailer_api(message_json, service)
//         } else if(service.api_type.toLowerCase() == 'imaginary') {
//           const fileNode = await this.imaginary_api(message_json, service)
//           await this.thumbnailer_api(message_json, service, fileNode)
//         } 

//       } catch (error) {
//         console.log('PAM')
//         if (error.response) {
//             // The request was made and the server responded with a status code
//             // that falls out of the range of 2xx
//             console.log(error.response.data);
//             console.log(error.response.status);
//             console.log(error.response.headers);
//           } else if (error.request) {
//             // The request was made but no response was received
//             // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
//             // http.ClientRequest in node.js
//             console.log(error.request);
//           } else {
//             // Something happened in setting up the request that triggered an Error
//             console.log('Error', error.message);
//           }
//       }
    


// }



// queue.thumbnailer_api = async function(item) {

//   //create preview texts and thumbnail images

//   try {
//     console.log('**************** THUMBNAILER api ***************')
//     console.log(item.data)

//     var filepath = item.data.file.path
//     if(item.filenode) {
//       filepath = item.filenode.result[0].path
//     } 
//     const base_path = path.join(path.dirname(filepath))
//     var wsdata = {target: item.data.file['@rid']}

//     if(!item.data.file.description) item.data.file.description = ''

//     // previews and thumbnails for images
//     if(item.data.file.type == 'image' || item.data.file.type == 'pdf') {
//       const got = await import('got');

//       const readStream = fs.createReadStream(filepath);
//       const formData = new FormData();
//       formData.append('file', readStream);
      
//       console.log('Sending image via POST request...');
//       var thumb_path = ''
//       var preview_path = ''
//       try {
//         await fs.ensureDir(path.dirname(filepath))
//         thumb_path = path.join(base_path, "thumbnail.jpg")
//         preview_path = path.join(base_path, "preview.jpg")
//       } catch(e) {
//         throw('Could not create file directory!' + e.message)
//       }
  
//       // preview
//       var url = 'http://' + item.service.url + item.service.api +  'thumbnail?width=800&type=jpeg' 
//       console.log(url)
//       const postStream = queue.got.stream.post(url, {
//         body: formData,
//         headers: formData.getHeaders(),
//       });
      
//       const previewStream = fs.createWriteStream(preview_path);
//       await pipeline(postStream, previewStream)
  
//       // thumbnail
//       const readStream2 = fs.createReadStream(filepath);
//       const formData2 = new FormData();
//       formData2.append('file', readStream2);
      
//       url = 'http://' + item.service.url + item.service.api +  'thumbnail?width=200&type=jpeg' 
//       const postStream2 = queue.got.stream.post(url, {
//         body: formData2,
//         headers: formData2.getHeaders(),
//       });
  
//       const thumbStream = fs.createWriteStream(thumb_path);
//       await pipeline(postStream2, thumbStream)

//       wsdata.image = base_path.replace('data/', 'api/thumbnails/')

//     // text preview as description for texts
//     } else if(item.data.file.type == 'text') {
//       //var description = "tässä on vähänt ekstiä"
//       console.log('reading text file...')
//       var description = await media.getTextDescription(filepath)
//       await graph.setNodeAttribute(item.data.file['@rid'], {key: 'description', value: description})
//       wsdata.description =  description
//     }



//     // update node image in UI via websocket
//     if(item.data.userId) {
//       console.log('sending thumbnailer WS to user:' , item.data.userId)
//       console.log(typeof  queue.connections)
//       console.log(item.filenode.result[0]['@rid'])
//       const ws = queue.connections.get(item.data.userId)
//       if(ws) {
//         if(item.filenode) wsdata.target = item.filenode.result[0]['@rid']
//         console.log(wsdata)
//         ws.send(JSON.stringify(wsdata))
//       }
//     }
//   } catch (error) {
//     console.error('thumbnailer_api: Error reading, sending, or saving the image:', error.message);
//   }
// }



// queue.imaginary_api = async function(item) {

//   //const imageDestinationUrl = 'http://localhost:9000/blur?sigma=20';

//   try {
//     console.log('**************** IMAGINARY api ***************')
//     console.log(item.data)
//       const got = await import('got');
//       const filepath = item.data.file.path
//       const readStream = fs.createReadStream(filepath);
//       const formData = new FormData();
//       formData.append('file', readStream);
      
//       console.log('Sending image via POST request...');
//       // first, create file object to graph
//     // process_rid, file_type, extension, label
//     const fileNode = await Graph.createProcessFileNode(item.data.process['@rid'], 'image', path.extname(filepath).replace('.',''), path.basename(filepath))
//     console.log(fileNode)
//     var writepath = ''
//     try {
//       writepath = fileNode.result[0].path
//       await fs.ensureDir(path.dirname(writepath))
//     } catch(e) {
//       throw('Could not create file directory!' + e.message)
//     }
//       const url_params = objectToURLParams(item.data.params)
//       var url = 'http://' + item.service.url + item.service.api +  item.data.task + '?' + url_params
//       console.log(url)
//       const postStream = queue.got.stream.post(url, {
//         body: formData,
//         headers: formData.getHeaders(),
//       });
      
//       console.log(writepath)
//       const writeStream = fs.createWriteStream(writepath);
 
//       await pipeline(postStream, writeStream)
//       console.log('********************** CALLING THUBNAILER ************')
//       var service = await services.getServiceAdapterByName('thumbnailer')
//       const service_url = await nomad.getServiceURL('thumbnailer')
//       service.url = service_url
//       service.queue.add(service, item.data, fileNode)
//       //this.add("thumbnailer", item.data, fileNode)
//       return fileNode
      
//     } catch (error) {
//       console.error('imaginary_api: Error reading, sending, or saving the image:', error.message);
//       throw('imaginary api failed', error.message)
//     }
// }




// queue.ELG_api_text = async function(message, service) {

//   console.log('**************** ELG api text ***************')
//   console.log(message)

//     // read text to JSON object (content)
//     const filePath = message.file.path
//     const outputStream = fs.createReadStream(filePath, 'utf8');
    
//     let content = '';
    
//     outputStream.on('data', (chunk) => {
//       console.log(chunk)
//       content += chunk;
//     });
    
//     outputStream.on('end', async() => {

//       console.log('stream ended.')
//       message.content = content
//       process_rid = message.process['@rid']
//       delete(message.process)
//       delete(message.file)
//       message.params.nbest = 1
//       message.params.languages = ['fin','eng']
//       message.type = "text"
//       console.log(message)

//       try {
//         const {response} = await this.got.post(service.url + service.api, {
//           json: message
//         }).json();
//         console.log(response)
//         // first, create file object to graph
//         // process_rid, file_type, extension, label
//         const fileNode = await Graph.createProcessFileNode(process_rid, 'data', 'json', 'response.json')
//         try {
//           filepath = fileNode.result[0].path
//           await fs.ensureDir(path.dirname(filepath))
//           await media.writeJSON(response, path.basename(filepath), path.dirname(filepath))

//           // update UI via websocket
//           if(message.userId) {
//             console.log('sending text WS')
//             const ws = this.connections.get(message.userId)
//             var wsdata = {target: process_rid, node:{rid: fileNode.result[0]['@rid']}}
//             ws.send(JSON.stringify(wsdata))
//           }
//         } catch(e) {
//           throw('Could not create file directory!' + e.message)
//         }

//       } catch(e) {
//         console.log(e.message)
//       }

//     });
    
//     outputStream.on('error', (error) => {
//       console.error(`Error reading file: ${error}`);
//     });

// }




// queue.ELG_api_binary = async function(message, service) {
//   try {
//     console.log('**************** ELG api binary ***************')
//     console.log(message)
//     const formData = new FormData();


//     // Append JSON file
//     message.type = service.type
//     //const jsonContent = { type: service.type, params: message.params };

//     // provide parameters as json format
//     formData.append('request', JSON.stringify(message), {contentType: 'application/json',
//     filename: 'request.json'});

//     // append content file
//     const filepath = message.file.path
//     const binaryReadStream = fs.createReadStream(filepath);
//     formData.append('content', binaryReadStream, { filename: 'content.pdf', contentType: 'application/pdf'  });

//     console.log('Sending files via POST request...');

//     const response = await this.got.post(service.url + service.api, {
//       body: formData,
//       headers: formData.getHeaders(),
//     }).json();

//     console.log(response.response);
//     await this.getFilesFromStore(response.response, message, service)

//   } catch (error) {
//     console.error('Error sending the files:', error.message);
//   }
// }



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
  if(['png','jpg','jpeg'].includes(ext)) type = 'image'
  if(['pdf'].includes(ext)) type = 'pdf'


  const fileNode = await Graph.createProcessFileNode(message.process['@rid'], type, ext, filename)
  console.log(fileNode)
  var filepath = ''

  try {
    filepath = fileNode.result[0].path
    await fs.ensureDir(path.dirname(filepath))
  } catch(e) {
    throw('Could not create file directory!' + e.message)
  }

  // Add node to UI via websocket
  if(message.userId) {
    console.log('sending "add node" WS')
    const ws = this.connections.get(message.userId)
    if(ws) {
      var wsdata = {target: message.process['@rid'], node:{rid: fileNode.result[0]['@rid'], label: filename, type: type}}
      ws.send(JSON.stringify(wsdata))
    }
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
      value: JSON.stringify({
        file: fileNode.result[0],
        userId: message.userId
      })
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

