const { Kafka } = require('kafkajs');


async function runConsumer() {

    const kafka = new Kafka({
        clientId: "my-producer",
        brokers: ["localhost:9094"], // Replace with your Kafka broker address
      });
  

    const consumer = kafka.consumer({ groupId: 'tes9-group' })

    await consumer.connect()
    await consumer.subscribe({ topic: 'my-topic', fromBeginning: true })
    
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        for(var i=0; i < 1000000000; i++) {
            if(i % 10000000 == 0) console.info(i)
        }
        console.log({
          value: message.value.toString(),
        })
      },
    })
}

runConsumer()
