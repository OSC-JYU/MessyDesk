IMAGES := $(shell docker images -f "dangling=true" -q)
CONTAINERS := $(shell docker ps -a -q -f status=exited)
VOLUME := md-main
VERSION := 25.05.21
REPOSITORY := osc.repo.kopla.jyu.fi
IMAGE := messydesk


clean:
	docker rm -f $(CONTAINERS)
	docker rmi -f $(IMAGES)

build:
	docker build -t $(REPOSITORY)/messydesk/$(IMAGE):$(VERSION) .

start:
	docker run -d --name $(IMAGE) \
		-p 8200:8200 \
		-e DATA_DIR=/data \
		--net=host \
		-e DB_NAME=messydesk \
		-e DB_PORT=2480 \
		-e DB_USER=root \
		-e DB_PASSWORD=node_master \
		-e MODE=development \
		-e PODMAN=true \
		-v $(VOLUME):/data:Z \
		$(REPOSITORY)/messydesk/$(IMAGE):$(VERSION)

restart:
	docker stop $(IMAGE)
	docker rm $(IMAGE)
	$(MAKE) start

bash:
	docker exec -it $(IMAGE) bash
