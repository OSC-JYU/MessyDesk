job "MD-thumbnailer" {
  type = "service"

  group "MD-image" {
    count = 1
    network {
      port "node" {
        to = 9000
      }
    }

    service {
      name     = "thumbnailer"
      port     = "node"
      provider = "nomad"
    }

    task "md-imaginary" {
      driver = "docker"
        config {
            image = "nextcloud/aio-imaginary"
            ports = ["node"]
        }

    }
  }
}