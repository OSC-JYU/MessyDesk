

import path from 'path';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';

import Graph from './graph.mjs';
import nomad from './nomad.mjs';
import media from './media.mjs';

import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, RetentionPolicy, AckPolicy } from "@nats-io/jetstream";


const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_URL_STATUS = process.env.NATS_URL_STATUS || "http://localhost:8222";

const nats = {}


nats.init = async function(services) {
  console.log('NATS: connecting...', NATS_URL)
  this.nc = await connect({
    servers: NATS_URL,
  });
  this.js = jetstream(this.nc);
  this.jsm = await jetstreamManager(this.nc);
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
        ack_wait: 120_000, // 2 minutes
        redeliver_policy: {
          max_deliveries: 1,
          interval: 100000,
        },
        filter_subject: `process.${key}`,
    
      });
     // console.log('NATS: created consumer', key, services[key].nomad_hcl)
      if(services[key].nomad_hcl) {
        console.log('NATS: created consumer', key, ' NOMAD=true')
      } else {
        console.log('NATS: created consumer', key, ' NOMAD=false')
      }

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
      if(e.message.includes('already exists')) {
        console.log('NATS: consumer already exists', key)
      } else {
        console.log('NATS ERROR: could not create consumer', key)
        console.log(e.message)
        console.log('HINT: remove all consumers from NATS and try again.')
        process.exit(1)
      }
    }
  }

  // SYSTEM QUEUES
  await this.jsm.streams.add({
    name: "SYSTEM",
    retention: RetentionPolicy.Workqueue,
    subjects: ["system.>"],
  });
  console.log("NATS: created the 'SYSTEM' stream");

  await this.jsm.consumers.add("SYSTEM", {
    durable_name: 'arcadedb',
    ack_policy: AckPolicy.Explicit,
    redeliver_policy: {
      max_deliveries: 2,
      interval: 1000,
    },
    filter_subject: `system.arcadedb`,

  });
  console.log('NATS: created system.arcadedb consumer')
}

nats.connect = async function() {
  this.nc = await connect({
    servers: NATS_URL,
  });
  this.js = jetstream(this.nc);
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
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    await this.js.publish(`process.${topic}`, payload)
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



nats.drainQueue = async function (topic, process_rid) {
  console.log('draining topic: ', topic)
  console.log('  process_rid: ', process_rid)
  let count = 0;
  try {
    // Find the stream for this topic
    const streamName = await this.jsm.streams.find(`process.${topic}`);
    const info = await this.jsm.streams.info(streamName);
    const { first_seq, last_seq } = info.state;


    for (let seq = last_seq; seq >= first_seq; seq--) {
      let msg;
      try {
        msg = await this.jsm.streams.getMessage(streamName, { seq });
        //await this.jsm.streams.deleteMessage(streamName, seq);
      } catch (err) {
        // if (!/message not found/i.test(err.message)) {
        //   console.warn(`Skipping seq=${seq}: ${err.message}`);
        // }
        // stop after first already deleted
        console.log('message not found!')
         continue;
      }

      // Parse JSON payload
      let message;
      try {
        message = msg.json();
        console.log(message)
        // Match and delete
        if (message?.set_process === process_rid || message?.process?.['@rid'] === process_rid) {
          await this.jsm.streams.deleteMessage(streamName, seq);
          count++;
        }
      } catch {
        console.warn(`Invalid JSON seq=${seq}`);
        continue;
      }


    }
    console.log('deleted messages: ', count)
    return count;
  } catch (err) {
    console.error("drainQueue error:", err);
    return 0;
  }
};


// Queue draining
nats.drainQueue_old = async function(topic, process_rid) {

  // find a stream that stores a specific subject:
  const name = await this.jsm.streams.find("process." + topic);
  console.log(name)
  // retrieve info about the stream by its name
  const si = await this.jsm.streams.info(name);
  console.log(si)
  const seq = si.state.first_seq
  var last_seq = si.state.last_seq

  try {
    for(var i = last_seq; i >= seq; i--) {
      let payload, data
      const message = await this.jsm.streams.getMessage(name, { seq: i });

      try {
        data = message.json()
        console.log(data)
      } catch (e) {
        console.log('invalid message payload!', e.message)
      }

      await this.jsm.streams.deleteMessage(name, i);
      //console.log(sm);
    }

  } catch(e) {
    console.log(e.message)
  }

  //  await this.jsm.streams.purge("SYSTEM");
  return true
 


  // const co = await js.consumers.get("SYSTEM", "arcadedb");
  // if (co) {
  //   let messages = await co.fetch({ max_messages: 4, expires: 2000 });
  //   for await (const m of messages) {
  //     m.ack();
  //   }
  //   //co.stop();
  //   await nc.close();
  //   console.log(`batch completed: ${messages.getProcessed()} msgs processed`);
  //   return true
    
  // }
}



// Database writing queue


nats.writeToDB = async function(query, params) {
  try {
    const json = JSON.stringify({query: query, params: params})
    await this.js.publish("system.arcadedb", json)
  } catch(e) {
    console.log('ERROR:', e.message)
  }
}

nats.createSetProcessNodesAndPublish = async function(msg) {
  console.log('creating set process nodes and publishing...')

  try {
    const json = JSON.stringify({topic: 'create_and_publish', value: msg})
    await this.js.publish("system.arcadedb", json)
  } catch(e) {
    console.log('ERROR:', e.message)
  }
}

nats.listenDBQueue = async function(topic) {
  console.log('connecting to DB queue...')
  const nc = await connect({servers: NATS_URL});
  const js = jetstream(nc);  
  console.log('connected to DB queue!')
 


  const co = await js.consumers.get("SYSTEM", "arcadedb");
  if (co) {
      const messages = await co.consume({ max_messages: 1 });
      for await (const m of messages) {
          try {
            var msg_data = m.json()
            var msg = msg_data.value
            //console.log(data)

            // CREATE AND PUBLISH
            if(msg_data.topic == 'create_and_publish') {
              console.log('creating and publishing received...', msg.current_file)
              // Add 500ms delay
             // await new Promise(resolve => setTimeout(resolve, 500));
             //var msg_copy = structuredClone(msg)
             //if(msg_copy.system_params) delete msg_copy.system_params.json_schema
             //if(msg_copy?.params?.json_schema) delete msg_copy.params.json_schema
              var processNode = await Graph.createProcessNode_queue(msg);
              await media.createProcessDir(processNode.path);
              //delete data.service.tasks
              await media.writeJSON(msg, 'message.json', path.join(path.dirname(processNode.path)));
              //console.log(data)
              msg.process = processNode
              
              console.log('message', msg)
              nats.publish(msg.service.id + '_batch', JSON.stringify(msg))
              // we call database writes here and then we publish the message to actual processing queue
            } else {
              console.log('no topic defined!')
            }
            m.ack();
          } catch(e) {
              console.log('ERROR:', e.message)
              // we do not retry, so we ack
              m.ack();
          }
      } 
  }
}

export default nats