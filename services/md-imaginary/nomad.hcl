job "md-imaginary" {
  type = "service"

  group "MD-image" {
    count = 1
    network {
      port "node" {
        to = 9000
      }
    }

    service {
      name     = "md-imaginary"
      port     = "node"
      provider = "nomad"
    }

    task "md-imaginary" {
      driver = "docker"
        config {
            image = "docker.io/nextcloud/aio-imaginary:20240424_101241-latest"
            ports = ["node"]
        }

    }
  }
}