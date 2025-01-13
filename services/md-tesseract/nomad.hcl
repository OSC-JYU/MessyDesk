job "MD-tesseract" {
  type = "service"

  group "MD-tesseract" {
    count = 1
    network {
      port "node" {
        to = 8400
      }
    }

ephemeral_disk {
  size = 2000
}

    service {
      name     = "md-tesseract"
      port     = "node"
      provider = "nomad"
    }

    task "md-tesseract" {
      driver = "docker"
        config {
            image = "osc.repo.kopla.jyu.fi/messydesk/md-tesseract:0.1"
            ports = ["node"]
        }

    }
  }
}
