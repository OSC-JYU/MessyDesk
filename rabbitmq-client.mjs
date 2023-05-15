import {Connection} from 'rabbitmq-client'

// See API docs for all options
const rabbit = new Connection({
  url: 'amqp://guest:guest@localhost:5672',
  // wait 1 to 30 seconds between connection retries
  retryLow: 1000,
  retryHigh: 30000,
})



// See API docs for all options
const pro = rabbit.createPublisher({
  // enable acknowledgements (resolve with error if publish is unsuccessful)
  confirm: true,
  // enable retries
  maxAttempts: 2,
  // ensure the existence of an exchange before we use it otherwise we could
  // get a NOT_FOUND error
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}]
})

// just like Channel.basicPublish()
await pro.publish(
  {exchange: 'my-events', routingKey: 'org.users.create'},
  {id: 1, name: 'Alan Turing'})

// close the underlying channel when we're done,
// e.g. the application is closing
await pro.close()

// See API docs for all options
const consumer = rabbit.createConsumer({
  queue: 'user-events',
  queueOptions: {exclusive: true},
  // handle 2 messages at a time
  qos: {prefetchCount: 2},
  exchanges: [{exchange: 'my-events', type: 'topic', autoDelete: true}],
  queueBindings: [
    // queue should get messages for org.users.create, org.users.update, ...
    {exchange: 'my-events', routingKey: 'org.users.*'}
  ]
}, async (msg) => {
  console.log(msg)
  await doSomething(msg)
  // msg is automatically acknowledged when this function resolves or msg is
  // rejected (and maybe requeued, or sent to a dead-letter-exchange) if this
  // function throws an error
})

// maybe the consumer was cancelled, or a message wasn't acknowledged
consumer.on('error', (err) => {
  console.log('consumer error', err)
})

// if we want to stop our application gracefully then we can stop consuming
// messages and wait for any pending handlers to settle like this:
await consumer.close()
