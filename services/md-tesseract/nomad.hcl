job "MD-tesseract" {
  type = "service"

  group "MD-tesseract" {
    count = 1
    network {
      port "node" {
        to = 8400
      }
    }

    service {
      name     = "md-tesseract"
      port     = "node"
      provider = "nomad"
    }

    task "md-tesseract" {
      driver = "docker"
        config {
            image = "osc.jyu.fi/md-tesseract:0.1"
            ports = ["node"]
        }

    }
  }
}