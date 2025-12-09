# Running MessyDesk locally without NOMAD

In order to run very *minimal* MessyDesk locally we need these:

- ArcadeDB (graph database)
- NATS Jetstream (message queue)
- source code of Messydesk (backend)
- source code of MessyDesk-UI (user interface)
- source code of MD-consumers (service adapters)
- Imaginary (image processing)

Make sure that you have git, docker (or podman on RHEL linux) and NodeJS working (https://nodejs.org). 

	git --version
	docker --version
	node --version



## Arcadedb (graph database)

Let's start ArcadeDB:

	docker run --rm -p 2480:2480 -v arcadedb-data:/opt/arcadedb/databases -e JAVA_OPTS="-Darcadedb.server.rootPassword=node_master" arcadedata/arcadedb:23.7.1

You should be able to access database UI here: http://localhost:2480
user: root
password: node_master
Note that there is no actual database yet. MessyDesk will create it on first startup.



## NATS Jetstream (messaging)

MessyDesk sends messages to services when something needs to be done. Let's start message queue next.

	docker run -d --name nats-main -p 4222:4222 -p 6222:6222 -p 8222:8222 nats -js

You should see simple user interface here: http://localhost:8222/

## MessyDesk (backend)

	git clone https://github.com/OSC-JYU/MessyDesk.git
	cd MessyDesk
	npm install
	MODE=development DB_PASSWORD=node_master nodemon index.js

You should see something like this:

	MessyDesk running at: http://0.0.0.0:8200
	connected to DB queue!



## MessyDesk UI 

Let's fetch user interface next.

	git clone https://github.com/OSC-JYU/MessyDesk-UI.git
	cd MessyDesk-UI
	npm install
	npm run dev

Aim your browser to http://localhost:3000

You should have an user interface but you can't do much. You can upload files but you don't get even thumbnails for images.

We can now start some basic services.



## Image thumbnailer

Let's start our first service for image processing. 
Open yet another terminal and start imaginary container

	docker run -d --name md-thumbnailer -p 9000:9000 nextcloud/aio-imaginary

Now we should have imaginary (that is used for image thumbnails) running in port 9000.
Now we must start adapter, that connects service to MessyDesk.



## MD-consumers

Open again another terminal:

	git clone https://github.com/OSC-JYU/MD-consumers.git
	cd MD-consumers
	npm install

Now we should have our adapters ready. Let's start adapter for thumnbnailer:

	TOPIC=md-thumbnailer node src/index.mjs 

Now, when you upload an image to MessyDesk, you should have thumbnail.


Let's use same imaginary container for image processing (rotate, flip, resize, blur):

	TOPIC=md-imaginary node src/index.mjs 

If all went well, you can now flip and rotate images in MessyDesk in address: http://localhost:3000

