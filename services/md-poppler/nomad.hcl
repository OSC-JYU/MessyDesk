job "md-poppler" {
  type = "service"

  group "MD-image" {
    count = 1
    network {
      port "node" {
        to = 8300
      }
    }

    service {
      name     = "md-poppler"
      port     = "node"
      provider = "nomad"
    }

    task "md-poppler" {
      driver = "docker"
        config {
            image = "osc.repo.kopla.jyu.fi/messydesk/md-poppler:0.1"
            ports = ["node"]
            auth {
              username = ""
              password = ""
            }
        }

    }
  }
}