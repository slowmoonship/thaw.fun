# Server ports

- `22/tcp`: SSH; restrict by source IP where practical.
- `80/tcp`, `443/tcp`: Caddy HTTP/HTTPS.
- `9651/tcp`: Avalanche P2P; public reachability is required.
- `9650/tcp`: bind to `127.0.0.1`; never expose directly. Publish selected read-only routes only through HTTPS and access controls.

Target: one Ubuntu LTS VPS, 4 vCPU, 8 GiB RAM, 200–250 GB SSD/NVMe, public IPv4. Use Docker `restart: unless-stopped`; run AvalancheGo under a dedicated systemd service or pinned official container.
