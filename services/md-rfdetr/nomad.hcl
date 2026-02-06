job "md-rfdetr" {
  type = "service"

  group "MD-rfdetr" {
    count = 1
    network {
      port "node" {
        to = 9011
      }
    }

    service {
      name     = "md-rfdetr"
      port     = "node"
      provider = "nomad"
    }

    task "md-rfdetr" {
      driver = "docker"
      config {
          image = "osc.repo.kopla.jyu.fi/messydesk/md-rfdetr:0.1"
          ports = ["node"]
          auth {
            username = ""
            password = ""
          }
      }
      resources {
        memory = 2000  # Memory in MB
        cpu    = 500  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}