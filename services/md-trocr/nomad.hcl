job "md-trocr" {
  type = "service"

  group "MD-trocr" {
    count = 1
    network {
      port "node" {
        to = 9012
      }
    }

    service {
      name     = "md-trocr"
      port     = "node"
      provider = "nomad"
    }

    task "md-trocr" {
      driver = "docker"
      config {
          image = "osc.repo.kopla.jyu.fi/messydesk/md-trocr:0.1"
          ports = ["node"]
          auth {
            username = ""
            password = ""
          }
      }
      env {
        HTTP_PROXY  = "http://itsp.cc.jyu.fi:8080"
        HTTPS_PROXY = "http://itsp.cc.jyu.fi:8080"
        http_proxy  = "http://itsp.cc.jyu.fi:8080"
        https_proxy = "http://itsp.cc.jyu.fi:8080"
      }
      resources {
        memory = 4000  # Memory in MB
        cpu    = 500  # CPU shares (500 = 50% of 1 CPU)
      }
    }
  }
}