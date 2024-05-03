# MessyDesk

## Digital Humanities Desktop

This is a VERY early version of MessyDesk, a digital humanities desktop (for humanists).

The idea is that you can collect, organise and process your materials easily by experimenting with different kind of options.


![UI](https://github.com/OSC-JYU/MessyDesk/blob/main/docs/messydesk-ui.png)

Things you can do:
- extract images and text from PDF
- process images
- do optical character recognition
- do different kind of text and images analysis
- and so on... 

### status

Hardly anything works yet :)

## Local development

This guide helps you to set up local development setup. You need Docker and docker-compose installed (or podman), Node version => 20.

Check Docker:

    docker ps

Check node

    node -v
    -> v20.12.2

### Backend

Clone this repo:

   git clone https://github.com/OSC-JYU/MessyDesk.git
   cd MessyDesk

Start NATS and Arcadedb 

    docker-compose up


Start Nomad locally:

    sudo nomad agent -dev 

Start back end:

    MODE=development DB_PASSWORD=node_master node index.js


Now we should have backend running. We need also some services and UI.


### Consumer apps (service adapters)

Consumer apps are links between MessyDesk backend and services..

One more repository is needed:

    cd ..
    git clone https://github.com/OSC-JYU/MD-consumers.git
    cd MD-consumers/MDc-imaginary

We need to start two instances:

    NAME=md-imaginary node index.mjs

And then in another terminal:

    NAME=thumbnailer node index.mjs

Now we have also two consumer application and two nomad jobs, thumbnailer and imaginary library for image manipulation.


### Frontend:

UI is it its own repository:

    cd ..
    git clone https://github.com/OSC-JYU/MessyDesk-UI.git
    cd MessyDesk-UI
    npm run dev

Aim your browser to [http://localhost:3000](http://localhost:3000)

There is not much MessyDesk can do yet, but you should be able to see the idea. Create a project, add few images and rotate them back and forth :) 

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




### ELG API

https://european-language-grid.readthedocs.io/en/stable/all/A3_API/LTInternalAPI.html#

https://www.lingsoft.fi/en/microservices-at-your-service-bridging-gap-between-nlp-research-and-industry