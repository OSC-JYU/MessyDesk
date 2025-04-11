job "md-paddleocr-fin" {
  type = "service"

  group "MD-paddleocr" {
    count = 1
    network {
      port "node" {
        to = 8800
      }
    }

ephemeral_disk {
  size = 5000
}

    service {
      name     = "md-paddleocr-fin"
      port     = "node"
      provider = "nomad"
    }

    task "md-paddleocr-fin" {
      driver = "docker"
      config {
        image = "osc.repo.kopla.jyu.fi/messydesk/md-paddle-ocr-fin:0.1"
        ports = ["node"]
      }      
      resources {
        memory = 2000  # Memory in MB
        #cpu    = 2000  # CPU shares (500 = 50% of 1 CPU)
        cores = 2
      }
    }
  }
}
