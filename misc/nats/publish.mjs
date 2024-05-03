import {
    AckPolicy,
    connect,
    millis,
    nuid,
    RetentionPolicy,
    JSONCodec
  } from "nats";
  
  const jc = JSONCodec();

  const nc = await connect({
    servers: "nats://localhost:4222",
  });
  
  const js = nc.jetstream();  

  var data = {
    '@rid': '#270:202',
    '@type': 'File',
    type: 'image',
    extension: 'jpg',
    label: 'ari_h.jpg',
    _active: true,
    path: 'data/projects/217_6/files/270_202/270_202.jpg'
  }


  await js.publish("process.thumbnailer", jc.encode(data))
 
  
  await js.publish("process.md-imaginary")

  
  await nc.close()