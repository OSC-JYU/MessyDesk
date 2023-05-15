const aqmp = require('amqplib');
const queueName = 'myQueueName';

async function sendMessage(body) {
    const conn = await aqmp.connect('amqp://localhost');
    const ch = await conn.createConfirmChannel(conn);
    ch.assertQueue(queueName, {durable: true});
    ch.sendToQueue(queueName, Buffer.from(body), {persistent: true});
    // Required because sendToQueue queues the message to be sent, but it hasn't been sent yet
    await ch.waitForConfirms();
    process.exit(0);
}

var message = {hello: 'World'};
sendMessage(message.toString());
