job "MD-finbert" {
  type = "service"

  group "MD-finbert" {
    count = 1
    network {
      port "node" {
        to = 8400
      }
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

    }
  }
}
