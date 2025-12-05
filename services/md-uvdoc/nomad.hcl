job "md-uvdoc" {
  type = "service"

  group "MD-uvdoc" {
    count = 1
    network {
      port "node" {
        to = 9006
      }
    }

ephemeral_disk {
  size = 5000
}

    service {
      name     = "md-uvdoc"
      port     = "node"
      provider = "nomad"
    }

    task "md-uvdoc" {
      driver = "docker"
      config {
        image = "osc.repo.kopla.jyu.fi/messydesk/md-uvdoc:0.1"
        ports = ["node"]
      }      
      resources {
        memory = 4000  # Memory in MB
        cpu    = 1000  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}
