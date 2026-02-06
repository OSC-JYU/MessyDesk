job "md-text-base" {
  type = "service"

  group "MD-text-base" {
    count = 1
    network {
      port "node" {
        to = 9008
      }
    }

    service {
      name     = "md-text-base"
      port     = "node"
      provider = "nomad"
    }

    task "md-text-base" {
      driver = "docker"
      config {
          image = "osc.repo.kopla.jyu.fi/messydesk/md-text-base:0.1"
          ports = ["node"]
      }
      resources {
        memory = 1000  # Memory in MB
        cpu    = 500  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}