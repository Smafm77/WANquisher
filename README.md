# WANquisher – Multi-Target WAN Emulator

WANquisher is a container-based WAN emulation lab that lets you spin up multiple network endpoints and apply controlled impairments such as latency, packet loss, and bandwidth limits.  
It provides both a web-based UI and a REST API for managing lab topology and link parameters in real-time.

---

## Features

- **Multi-container lab** – create multiple Docker containers to act as network endpoints.
- **Fine-grained control** – configure latency, jitter, bandwidth, and packet loss per link and port.
- **Persistent settings** – save and load configurations from browser local storage.
- **Live status updates** – view current link statistics via auto-refreshing port overview.
- **API + UI** – FastAPI backend with REST endpoints and a static web interface.

---

## Architecture

frontend/ # HTML/CSS/JS for the UI (port overview, setup, start view)
backend/ # FastAPI app, Docker control, link management
docker-compose.yml


- **Backend**: Python 3 + FastAPI, Docker SDK for Python.  
  Endpoints:
  - `GET /health` – API health check
  - `GET /containers` – List active containers
  - `POST /links/apply` – Apply link settings
  - `GET /links/status_many` – Get current link stats
  - `POST /links/{name}/clear` – Reset a link

- **Frontend**: Vanilla JS, Tailwind-style CSS.  
  Tabs for lab setup, port overview, and starting/stopping containers.

---

## Requirements

- Docker & Docker Compose installed
- Python 3.9+ (only for backend local dev; containerized in prod)
- Modern web browser for the UI

---

## Installation

Clone the repository:
```bash
git clone https://github.com/Smafm77/wanquisher.git
cd wanquisher

Start the lab environment:

docker compose up -d --build

Usage

    Open the UI in your browser:

    http://localhost:8000/

    Create your lab containers via the Setup tab.

    Switch to Port Overview to adjust latency, loss, and bandwidth per port.
    Changes are applied instantly via the Apply Changes button.

    Save your configuration for later use – settings are stored in your browser’s local storage.

Rebuild & Reset

docker compose down
docker compose up -d --build