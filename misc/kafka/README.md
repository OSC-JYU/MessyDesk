

## Download and start Kafka

    docker-compose up -d


BACKUP if above method fails:

https://kafka.apache.org/quickstart

 bin/zookeeper-server-start.sh config/zookeeper.properties
 bin/kafka-server-start.sh config/server.properties

## Kafka docker

https://stackoverflow.com/questions/51630260/connect-to-kafka-running-in-docker


DOES NOT WORK
docker ubuntu:

    docker run -d -p 2181:2181 ubuntu/zookeeper:edge
    docker run -d --name kafka-container -e TZ=UTC -p 9092:9092 -e ZOOKEEPER_HOST=localhost -e ZOOKEEPER_PORT=2181 ubuntu/kafka:3.1-22.04_beta


bitnami docker

https://github.com/bitnami/containers/tree/main/bitnami/kafka#accessing-apache-kafka-with-internal-and-external-clients