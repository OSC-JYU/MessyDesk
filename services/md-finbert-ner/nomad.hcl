job "md-finbert-ner" {
  type = "service"

  group "MD-finbert" {
    count = 1
    network {
      port "node" {
        to = 8600
      }
    }

ephemeral_disk {
  size = 4000
}

    service {
      name     = "md-finbert-ner"
      port     = "node"
      provider = "nomad"
    }

    task "md-finbert-ner" {
      driver = "docker"
      config {
        image = "osc.repo.kopla.jyu.fi/messydesk/md-finbert:0.1"
        ports = ["node"]
      }      
      resources {
        memory = 4000  # Memory in MB
        cpu    = 1000  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}
