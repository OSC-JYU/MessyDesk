job "md-thumbnailer" {
  type = "service"

  group "MD-image" {
    count = 1
    network {
      port "node" {
        to = 9000
      }
    }

    service {
      name     = "md-thumbnailer"
      port     = "node"
      provider = "nomad"
    }

    task "md-imaginary" {
      driver = "docker"
        config {
            image = "nextcloud/aio-imaginary:20240424_101241-latest"
            ports = ["node"]
        }

    }
  }
}