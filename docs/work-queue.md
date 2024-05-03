# Work queues

When many people need to do lengthy tasks on a server, it's important to have a way to organize and manage those tasks.

MessyDesk uses [NATS Jetstream](https://docs.nats.io/nats-concepts/jetstream) for work queues and [nomad](https://www.nomadproject.io/) for managing services.



## Flow

When user clicks "run" in processing node in MessyDesk, following sequence happens:

1. MessyDesk API receives request in endpoint 

    /api/queue/:topic/files/:file_rid
    index.js: 291

2. Backend publishes message to NATS stream

    for example to 'md-imaginary' 

3. One of the consumer applications fetch the message from stream

4. Consumer application fetches file or data from MessyDesk endpoint

    /api/nomad/files/:file_rid
    index.js: 335

4. Consumer application sends request to actual service endpoint

5. When service endpoint responses, consumer application sends original message and processed files back to MessyDesk

    /api/nomad/process/files
    index.js: 354