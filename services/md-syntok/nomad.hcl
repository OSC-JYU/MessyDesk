job "md-nomad" {
  type = "service"

  group "MD-nomad" {
    count = 1
    network {
      port "node" {
        to = 8400
      }
    }


    service {
      name     = "md-syntok
      port     = "node"
      provider = "nomad"
    }

    task "md-syntok" {
      driver = "docker"
        config {
            image = "osc.repo.kopla.jyu.fi/messydesk/md-syntok:0.1"
            ports = ["node"]
        }

    }
  }
}
