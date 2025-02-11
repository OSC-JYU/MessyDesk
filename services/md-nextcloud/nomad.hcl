job "md-nextcloud" {
  type = "service"

  group "MD-nextcloud" {
    count = 1
    network {
      port "node" {
        to = 8900
      }
    }

ephemeral_disk {
  size = 4000
}

    service {
      name     = "md-nextcloud"
      port     = "node"
      provider = "nomad"
    }

    task "md-nextcloud" {
      driver = "docker"
      config {
        image = "osc.repo.kopla.jyu.fi/messydesk/md-nextcloud:0.1"
        ports = ["node"]
      }      
      resources {
        memory = 4000  # Memory in MB
        cpu    = 1000  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}
