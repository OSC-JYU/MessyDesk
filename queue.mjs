

import path from 'path';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';

import Graph from './graph.mjs';
import nomad from './nomad.mjs';

import { connect, RetentionPolicy, AckPolicy } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_URL_STATUS = process.env.NATS_URL_STATUS || "http://localhost:8222";





const nats = {}


nats.init = async function(services) {
  console.log('NATS: connecting...', NATS_URL)
  this.nc = await connect({
    servers: [NATS_URL],
  });
  this.js = this.nc.jetstream();
  this.jsm = await this.js.jetstreamManager();
  await this.jsm.streams.add({
    name: "PROCESS",
    retention: RetentionPolicy.Workqueue,
    subjects: ["process.>"],
  });
  console.log("NATS: created the 'PROCESS' stream");



  // create consumers for all services
  console.log("NATS: creating consumers...")
  for(var key in services) {
    try {
      await this.jsm.consumers.add("PROCESS", {
        durable_name: key,
        ack_policy: AckPolicy.Explicit,
        redeliver_policy: {
          max_deliveries: 3,
          interval: 1000,
        },
        filter_subject: `process.${key}`,
    
      });
      console.log('NATS: created consumer', key)

      var batch = key + '_batch'
      await this.jsm.consumers.add("PROCESS", {
        durable_name: batch,
        ack_policy: AckPolicy.Explicit,
        redeliver_policy: {
          max_deliveries: 2,
          interval: 1000,
        },
        filter_subject: `process.${batch}`,
    
      });
      console.log('NATS: created batch consumer', batch)


    } catch(e) {
      console.log('NATS ERROR: could not create consumer', key)
      console.log(e.message)
      console.log('HINT: remove all consumers from NATS and try again.')
      process.exit(1)
    }
  }
}

nats.connect = async function() {
  this.nc = await connect({
    servers: [servers],
  });
  this.js = this.nc.jetstream();
}

nats.close = async function() {
  await this.nc.close()
}

nats.checkService = async function(data) {
  // get service url from nomad
  const service = await nomad.getServiceURL(data)
  return service
}


nats.publish = async function(topic, data) {
  console.log(topic)
  //var service = await services.getServiceAdapterByName(topic)
  try {
    //var s = await this.checkService(topic)
    //if(!s) {
      //await nomad.createService(service)
    //}
    //const service_url = await nomad.getServiceURL(topic)
    //service.url = service_url
    //service.queue.add(service, data, filenode)
    await this.js.publish(`process.${topic}`, JSON.stringify(data))
  } catch(e) {
    console.log(`ERROR: Could not add topic ${topic} to queue!\n`, e)
  }
}


nats.listConsumers = async function() {
  var consumers = []
  var lister = await this.jsm.consumers.list("PROCESS")
  for await (const item of lister) {
      consumers.push(item);
  }
  return consumers
}


nats.getFilesFromStore = async function(response, message, service) {

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



nats.downLoadFile = async function(message, uri, service) {
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

    const topic = 'md-thumbnailer' 
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

nats.getQueueStatus = async function(topic) {
  try {
    const url = NATS_URL_STATUS + '/jsz?consumers=true'
    const queues = {}
  
    const response = await fetch(url)
    const data = await response.json()
    for(var stream of data.account_details[0].stream_detail[0].consumer_detail) {
      if(stream.name == topic || stream.name == topic + '_batch') {
        queues[stream.name] = stream
      }
    }

    return queues
    
  } catch(e) {
    console.log(e)
    console.log('Queue status failed!')
  }
}


export default nats