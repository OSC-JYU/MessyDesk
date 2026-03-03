job "md-base" {
  type = "service"

  group "MD-base" {
    count = 1
    network {
      port "node" {
        to = 9008
      }
    }

    service {
      name     = "md-base"
      port     = "node"
      provider = "nomad"
    }

    task "md-base" {
      driver = "docker"
      config {
          image = "osc.repo.kopla.jyu.fi/messydesk/md-base:0.1"
          ports = ["node"]
      }
      resources {
        memory = 1000  # Memory in MB
        cpu    = 500  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}