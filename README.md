# MessyDesk

## Digital Humanities Desktop

This is a VERY early version of MessyDesk, a digital humanities desktop (for humanists).

The idea is that you can collect, organise and process your materials easily by experimenting with different kind of options.


![UI](https://github.com/OSC-JYU/MessyDesk/blob/main/test/files/messydesk-ui.png)

Things you can do:
- extract images and text from PDF
- process images
- do optical character recognition
- do different kind of text and images analysis
- and so on... 

### status

Hardly anything works yet :)

## Getting started

Clone this repo:

   git clone https://github.com/OSC-JYU/MessyDesk.git
   cd MessyDesk

Start services:

    docker-compose up

This will start NATS and Arcadedb 

Start Nomad locally:

    sudo nomad agent -dev   -bind 0.0.0.0   -network-interface='{{ GetDefaultInterfaces | attr "name" }}'

Start back end:

    MODE=development DB_PASSWORD=node_master node index.js

Then we must create queues for thumbnailer and imaginary (both using the same Imaginary service). 

    curl http://localhost:8200/api/services -d "@test/services/thumbnailer/service.json" --header "Content-Type: application/json"

    curl http://localhost:8200/api/services -d "@test/services/imaginary/service.json" --header "Content-Type: application/json"


Now we should have backend running!

Let's launch frontend:

    cd ..
    git clone https://github.com/OSC-JYU/MessyDesk-UI.git
    cd MessyDesk-UI
    npm run dev

Aim your browser to [http://localhost:3000](http://localhost:3000)

There is not much MessyDesk can do yet, but you should be able to see the idea. Create a project, add few images and blur them :) 

## API

### Projects

project creation:

    curl  http://localhost:8200/api/projects -d @test/files/project.json --header "Content-Type: application/json"

http POST :8200/api/projects @test/files/project.json

http POST :8200/api/projects label="really messy"

### Uploads

upload:

    curl http://localhost:8200/api/projects/1:0/upload -F "file=@test/files/test.pdf" 


### processing queue



## SERVICES

### start Kafka, Arcadedb and thumbnailer

    cd test/kafka
    docker-compose up


### register thumbnnailer service:

    curl http://localhost:8200/api/services -d "@test/services/thumbnailer/service.json" --header "Content-Type: application/json"

This creates a consumer for topic "thumbnailer". 



### start image processig service

https://hub.docker.com/r/nextcloud/aio-imaginary

    docker pull nextcloud/aio-imaginary
    docker run --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 

    cd test/services/test-image-service
    make start



### ELG service examples

Language detection

First, start elg-container:

    docker pull lingsoft/heli-ots:1.4.0-elg

    docker run -d -p 8080:8080 lingsoft/heli-ots:1.4.0-elg


Register ELG service:

    curl http://localhost:8200/api/services -d "@test/services/heli-ots/service.json" --header "Content-Type: application/json"


Add file to an existing project (create project if necessary):

    curl http://localhost:8200/api/projects/1:0/upload -F "file=@test/files/test.txt" 

Call service:

    curl -X POST http://localhost:8200/api/queue/md-heli-ots/files/108:3 -d "@test/services/heli-ots/heli-ots_sample.json" --header "Content-Type: application/json"

## Tech stuff

MessyDesk is a web application. UI is written with Vue.js and backend is Nodejs. Apache Kafka is used for event queue handling and database is ArcadeDB.


### ELG API

https://european-language-grid.readthedocs.io/en/stable/all/A3_API/LTInternalAPI.html#

https://www.lingsoft.fi/en/microservices-at-your-service-bridging-gap-between-nlp-research-and-industry