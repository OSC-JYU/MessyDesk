job "MD-imaginary" {
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
            image = "nextcloud/aio-imaginary"
            ports = ["node"]
        }

    }
  }
}