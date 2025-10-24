job "md-pdf2json" {
  type = "service"

  group "MD-pdf" {
    count = 1
    network {
      port "node" {
        to = 9003
      }
    }

    service {
      name     = "md-pdf2json"
      port     = "node"
      provider = "nomad"
    }

    task "md-pdf2json" {
      driver = "docker"
        config {
            image = "osc.repo.kopla.jyu.fi/messydesk/md-pdf2json:0.1"
            ports = ["node"]
            auth {
              username = ""
              password = ""
            }
        }

    }
  }
}