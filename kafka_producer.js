const { Kafka } = require('kafkajs');

async function runProducer() {
  try {
    const kafka = new Kafka({
      clientId: "my-producer",
      brokers: ["localhost:9094"], // Replace with your Kafka broker address
    });

    const producer = kafka.producer();

    await producer.connect();

    const topic = "requests";
    const message = {
      key: "my-key",
      value: "Hello, Kafka!",
    };

    await producer.send({
      topic,
      messages: [message],
    });

    console.log("Message sent successfully");

    await producer.disconnect();
  } catch (error) {
    console.error("Error running producer:", error);
  }
}

runProducer();