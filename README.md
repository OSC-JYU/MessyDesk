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
See you in DARIAH Annual Event 2023 in Budapest!



## API

project creation:
curl  http://localhost:8200/api/projects -d @files/project.json --header "Content-Type: application/json"

http POST :8200/api/projects @test/files/project.json

http POST :8200/api/projects label="really messy"



upload:
curl http://localhost:8200/api/projects/234:0/upload -F "file=@test/files/test.pdf" 




## SERVICES


### processing queue




    docker run -it --rm --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3.11-management



### test image processig service

https://hub.docker.com/r/nextcloud/aio-imaginary

    docker pull nextcloud/aio-imaginary
    docker run --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 

    cd test/services/test-image-service
    make start


### registering service:
curl http://localhost:8200/api/services -d "@test/services/test-image-service/service.json" --header "Content-Type: application/json"



esimerkki:
curl -X POST -o "filu.png" "http://localhost:9000/crop?width=500&height=400&file=uusi.png" -F "file=@test.png"



