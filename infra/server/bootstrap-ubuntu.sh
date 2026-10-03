#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { printf 'Run as root on Ubuntu LTS.\n' >&2; exit 1; }
apt-get update
apt-get install -y ca-certificates curl jq ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
ufw default deny incoming; ufw default allow outgoing; ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 9651/tcp
printf 'Review docs/SERVER_PORTS.md before enabling UFW. Port 9650 stays private.\n'
