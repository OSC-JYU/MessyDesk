#! /bin/bash


#docker run -d -p 8080:8080 lingsoft/heli-ots:1.4.0-elg


#curl "http://localhost:8200/api/services" -d "@heli-ots/service.json" --header "Content-Type: application/json"



curl "http://localhost:8200/api/services" -d "@md-poppler/service.json" --header "Content-Type: application/json" 

curl "http://localhost:8200/api/services" -d "@md-imaginary/service.json" --header "Content-Type: application/json" 

curl "http://localhost:8200/api/services" -d "@thumbnailer/service.json" --header "Content-Type: application/json" 

curl "http://localhost:8200/api/services" -d "@md-tesseract/service.json" --header "Content-Type: application/json" 

#curl "http://localhost:8200/api/services" -d "@pdfsense/service.json" --header "Content-Type: application/json" 
