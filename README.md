# MessyDesk

## Digital Humanities Desktop

This is a VERY early version of MessyDesk, a digital humanities desktop (for humanists).

The idea is that you can collect, organise and process your materials easily by experimenting with different kind of options.

Things you can do:
- extract images and text from PDF
- process images
- do optical character recognition
- do different kind of text and images analysis
- and so on... 

### status

Hardly anything works yet :)




## API

project creation:
curl  http://localhost:8200/api/projects -d @files/project.json --header "Content-Type: application/json"


upload:
curl http://localhost:8200/api/projects/234:0/upload -F "file=@files/test.pdf" 


## SERVICES

image processin service
https://hub.docker.com/r/nextcloud/aio-imaginary

    cd test/services/test-service
    make start


registering service:
curl http://localhost:8200/api/services -d "@service.json" --header "Content-Type: application/json"

esimerkki:
curl -X POST -o "filu.png" "http://localhost:9000/crop?width=500&height=400&file=uusi.png" -F "file=@test.png"



