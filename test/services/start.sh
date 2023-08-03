#! /bin/bash


#docker run -d -p 8080:8080 lingsoft/heli-ots:1.4.0-elg


#curl "http://localhost:8200/api/services" -d "@heli-ots/service.json" --header "Content-Type: application/json"


#curl "http://localhost:8200/api/services" -d "@md-poppler/service.json" --header "Content-Type: application/json" 

docker run --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary

curl "http://localhost:8200/api/services" -d "@imaginary/service.json" --header "Content-Type: application/json" 

curl "http://localhost:8200/api/services" -d "@thumbnailer/service.json" --header "Content-Type: application/json" 

#curl "http://localhost:8200/api/services" -d "@pdfsense/service.json" --header "Content-Type: application/json" 
