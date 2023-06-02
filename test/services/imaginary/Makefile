IMAGES := $(shell docker images -f "dangling=true" -q)
CONTAINERS := $(shell docker ps -a -q -f status=exited)
VOLUME := imaginary-data
VERSION := 0.1e


clean:
	docker rm -f $(CONTAINERS)
	docker rmi -f $(IMAGES)

create_volume:
	docker volume create $(VOLUME)

pull:
	docker pull nextcloud/aio-imaginary:latest

start:
	docker run -d --name md-imaginary \
		-v $(VOLUME):/logs \
		-p 9000:9000 \
		--restart unless-stopped \
		nextcloud/aio-imaginary:latest
restart:
	docker stop md-imaginary
	docker rm md-imaginary
	$(MAKE) start

bash:
	docker exec -it md-imaginary bash