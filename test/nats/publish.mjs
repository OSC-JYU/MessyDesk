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

  for (var i=0; i<30; i++) {
    await js.publish("process.thumbnailer", jc.encode({id:i}))
  }
  
  await js.publish("process.md-imaginary")

  
  await nc.close()