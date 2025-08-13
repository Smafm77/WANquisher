# backend/main.py
# Hannah's WAN-Emu Controller | 2025-08
# ---------------------------------------------------------------------------
# Single FastAPI app instance
# /lab/*    -> dynamic networks and lab containers
# /links/*  -> tc netem/tbf control per container / port
# list_targets() also includes lab containers
# ---------------------------------------------------------------------------

from fastapi import FastAPI, HTTPException
from starlette.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from typing import List, Optional, Dict, Any
import docker, shlex, os, re
from docker import errors

# ----------------------------------------------------------------------------
#  App scaffold + Docker client
# ----------------------------------------------------------------------------
app = FastAPI(title="WAN Emulator – multi + ports + overview")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse("static/index.html")

dc = docker.from_env()

# ----------------------------------------------------------------------------
#  Lab constants
# ----------------------------------------------------------------------------
LAB_NS      = os.environ.get("LAB_NS", "wanemu_lab")
ALPINE_IMG  = "alpine:3.20"
LAB_LABELS  = {"app": "wanemu", "lab": LAB_NS}

def _lab_label(extra: Optional[dict] = None) -> dict:
    d = dict(LAB_LABELS)
    if extra: d.update(extra)
    return d

# ----------------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------------
def _ensure_network(name: str):
    for n in dc.networks.list(names=[name]):          # existiert?
        return n
    return dc.networks.create(name=name, driver="bridge",
                            labels=_lab_label({"kind": "portnet"}))

def _run_container(name: str, cmd: str, network: str, labels: dict,
                extra_networks: Optional[list[str]] = None):
    try:                                              # schon da?
        return dc.containers.get(name)
    except errors.NotFound:
        pass

    c = dc.containers.run(
        ALPINE_IMG,
        name=name,
        command=f"sh -lc {shlex.quote(cmd)}",
        detach=True,
        cap_add=["NET_ADMIN"],
        labels=labels,
        network=network,
    )
    if extra_networks:
        for netname in extra_networks:
            try: dc.networks.get(netname).connect(c)
            except: pass
    return c

def _lab_names(n_ports: int):
    nets    = [f"{LAB_NS}_port{i}"   for i in range(1, n_ports+1)]
    server  = f"{LAB_NS}_server"
    # Use simple names for clients without lab prefix
    clients = [f"client{i}" for i in range(1, n_ports+1)]
    return nets, server, clients

def _get_container(name: str):
    try: return dc.containers.get(name)
    except errors.NotFound:
        raise HTTPException(status_code=404, detail=f"container {name} not found")

def _exec(c, cmd: str):
    rc, out = c.exec_run(f"sh -lc {shlex.quote(cmd)}", privileged=True)
    s = out.decode(errors="ignore")
    if rc != 0:
        raise HTTPException(status_code=500, detail=s.strip() or "exec failed")
    return s

def _project_label():
    try:
        me = dc.containers.get(os.environ.get("HOSTNAME", ""))
        return (me.labels or {}).get("com.docker.compose.project")
    except Exception:
        return None

def _clean_iface(n: str) -> str:          # "eth0@if23:" -> "eth0"
    return re.sub(r"@.*$|:$", "", n)

def _parse_tc(txt: str) -> Dict[str, Any]:
    if "qdisc" not in txt: return {"active": False}
    m_delay = re.search(r"delay\s+(\d+)ms(?:\s+(\d+)ms)?", txt)
    m_loss  = re.search(r"loss\s+([\d.]+)%", txt)
    m_corrupt = re.search(r"corrupt\s+([\d.]+)%", txt)
    m_rate  = re.search(r"tbf[^\n]*rate\s+(\S+)", txt)
    m_limit = re.search(r"limit\s+(\d+)", txt)
    m_sent  = re.search(r"Sent\s+(\d+)\s+bytes\s+(\d+)\s+pkt", txt)
    m_drop  = re.search(r"dropped\s+(\d+)", txt)
    m_over  = re.search(r"overlimits\s+(\d+)", txt)
    m_reqs  = re.search(r"requeues\s+(\d+)", txt)
    m_back  = re.search(r"backlog\s+(\d+)(?:[KkMm]?[Bb])?\s+(\d+)\s*p", txt)
    m_qlen  = re.search(r"qlen\s+(\d+)", txt)

    sent_bytes = int(m_sent.group(1)) if m_sent else 0
    sent_pkts  = int(m_sent.group(2)) if m_sent else 0
    dropped    = int(m_drop.group(1)) if m_drop else 0
    total_pkts = sent_pkts + dropped
    drop_pct   = (dropped / total_pkts * 100.0) if total_pkts > 0 else 0.0

    queue_bytes = int(m_back.group(1)) if m_back else 0
    queue_pkts  = int(m_back.group(2)) if m_back else 0
    qlen        = int(m_qlen.group(1)) if m_qlen else None

    return {
        "active":   True,
        "delay_ms": int(m_delay.group(1))  if m_delay else None,
        "jitter_ms":int(m_delay.group(2))  if m_delay and m_delay.group(2) else None,
        "loss_pct": float(m_loss.group(1)) if m_loss  else None,
        "ber_pct":  float(m_corrupt.group(1)) if m_corrupt else None,
        "rate":     m_rate.group(1)        if m_rate  else None,
        "queue_limit": int(m_limit.group(1)) if m_limit else None,
        "tx": {"bytes": sent_bytes, "frames": sent_pkts},
        "drops": {
            "total": dropped,
            "pct": round(drop_pct, 3),
            "overlimits": int(m_over.group(1)) if m_over else 0,
            "requeues": int(m_reqs.group(1)) if m_reqs else 0,
        },
        "queue": {
            "bytes": queue_bytes,
            "frames": queue_pkts,
            "qlen": qlen,
        },
    }
def _list_ifaces(c) -> List[Dict[str, Any]]:
    raw = _exec(c, "ip -o link show || true")
    names = []
    for line in raw.splitlines():
        m = re.match(r"\s*\d+:\s+([^:]+):", line)
        if not m: continue
        dev = _clean_iface(m.group(1))
        if dev != "lo": names.append(dev)
    out = []
    for dev in sorted(set(names)):
        ip4 = _exec(c, f"ip -o -4 addr show dev {shlex.quote(dev)} | awk '{{print $4}}' || true").strip()
        mac = _exec(c, f"cat /sys/class/net/{shlex.quote(dev)}/address || true").strip()
        out.append({"iface": dev, "ipv4": ip4 or None, "mac": mac or None})
    return out

# ----------------------------------------------------------------------------
#  Data models
# ----------------------------------------------------------------------------
class Netem(BaseModel):
    delay_ms: int = 0
    jitter_ms: int = 0
    loss_pct: float = 0
    ber_pct: float = 0
    rate: Optional[str] = None
    queue_limit: Optional[int] = None  # packets
    overhead: Optional[int] = None    # bytes per frame (framing overhead)
    mpu: Optional[int] = None         # minimum packet unit for tbf
class ApplyMany(BaseModel):
    sources: List[str] = []
    targets: List[str] = []
    delay_ms: int = 0
    jitter_ms: int = 0
    loss_pct: float = 0
    ber_pct: float = 0
    rate: Optional[str] = None
    queue_limit: Optional[int] = None
    overhead: Optional[int] = None
    mpu: Optional[int] = None
    both: bool = False

class StatusMany(BaseModel):
    names: List[str]

class PortRef(BaseModel):
    name: str
    iface: str

class ApplyPorts(BaseModel):
    ports: List[PortRef]
    delay_ms: int = 0
    jitter_ms: int = 0
    loss_pct: float = 0
    ber_pct: float = 0
    rate: Optional[str] = None
    queue_limit: Optional[int] = None
    overhead: Optional[int] = None
    mpu: Optional[int] = None

class StatusPorts(BaseModel):
    ports: List[PortRef]

class PortSetting(Netem):
    name: str
    iface: str

class ApplyPortsMatrix(BaseModel):
    items: List[PortSetting]

class LabInitBody(BaseModel):
    ports: int  = Field(gt=0, le=32)
    recreate: bool = False

# ----------------------------------------------------------------------------
#  Health & inventory
# ----------------------------------------------------------------------------
@app.get("/health")
def health(): return {"ok": True}

@app.get("/containers")
def list_targets():
    proj = _project_label()
    out  = []
    for c in dc.containers.list():
        labels = c.labels or {}

        # 1) alle Lab-Container immer mitnehmen
        if labels.get("lab") == LAB_NS:
            out.append(c.name); continue

        # 2) sonst nur eigenes Compose-Projekt zeigen
        if proj and labels.get("com.docker.compose.project") != proj:
            continue
        if labels.get("com.docker.compose.service") == "controller":
            continue
        out.append(c.name)
    return sorted(out)

@app.get("/containers/{name}/ifaces")
def container_ifaces(name: str):
    return _list_ifaces(_get_container(name))

@app.get("/ports")
def list_all_ports():
    ports = []
    for n in list_targets():
        try:
            c = _get_container(n)
            for p in _list_ifaces(c):
                ports.append({"name": n, **p})
        except: pass
    return ports

# ----------------------------------------------------------------------------
#  Lab endpoints
# ----------------------------------------------------------------------------
@app.post("/lab/init")
def lab_init(body: LabInitBody):
    n_ports = body.ports
    nets, server_name, client_names = _lab_names(n_ports)

    if body.recreate:
        lab_destroy()

    for net in nets: _ensure_network(net)

    _run_container(
        server_name,
        "apk add --no-cache iproute2 iperf3 >/dev/null && iperf3 -s",
        network=nets[0],
        labels=_lab_label({"role": "server"}),
        extra_networks=nets[1:],
    )

    for net, cname in zip(nets, client_names):
        _run_container(
            cname,
            "apk add --no-cache iproute2 iperf3 >/dev/null && sleep infinity",
            network=net,
            labels=_lab_label({"role": "client"}),
        )

    return {"ok": True, "server": server_name, "clients": client_names, "networks": nets}

@app.post("/lab/destroy")
def lab_destroy():
    # Container wegräumen
    for c in dc.containers.list(all=True, filters={"label": f"lab={LAB_NS}"}):
        try: c.remove(force=True)
        except: pass
    # Netze wegräumen
    for n in dc.networks.list(filters={"label": f"lab={LAB_NS}"}):
        try: n.remove()
        except: pass
    return {"ok": True}

@app.get("/lab/status")
def lab_status():
    info = {"containers": [], "networks": []}
    for c in dc.containers.list(all=True, filters={"label": f"lab={LAB_NS}"}):
        info["containers"].append({
            "name": c.name,
            "state": getattr(c, "status", "unknown"),
            "ifaces": _list_ifaces(c)
        })
    for n in dc.networks.list(filters={"label": f"lab={LAB_NS}"}):
        info["networks"].append({"name": n.name, "id": n.id[:12] if n.id else None})
    return info
# ---------------------------  tc helper --------------------------------------
def _apply_one(container: str, dev: str,
            delay_ms: int, jitter_ms: int, loss_pct: float, rate: Optional[str],
            ber_pct: float = 0, queue_limit: Optional[int] = None,
            overhead: Optional[int] = None, mpu: Optional[int] = None):
    dev  = _clean_iface(dev)
    cont = _get_container(container)
    _exec(cont, f"tc qdisc del dev {dev} root 2>/dev/null || true")
    if rate:
        tbf = f"tc qdisc add dev {dev} root handle 1: tbf rate {rate} burst 32kbit latency 400ms"
        if overhead:
            tbf += f" overhead {int(overhead)}"
        if mpu:
            tbf += f" mpu {int(mpu)}"
        _exec(cont, tbf)
        cmd = f"tc qdisc add dev {dev} parent 1:1 handle 10: netem"
    else:
        cmd = f"tc qdisc add dev {dev} root handle 10: netem"
    parts = [cmd]
    if delay_ms:
        parts.append(f"delay {delay_ms}ms")
        if jitter_ms:
            parts.append(f"{jitter_ms}ms distribution normal")
    if loss_pct:
        parts.append(f"loss {loss_pct}%")
    if ber_pct:
        parts.append(f"corrupt {ber_pct}%")
    if queue_limit:
        parts.append(f"limit {int(queue_limit)}")
    _exec(cont, " ".join(parts))
@app.get("/links/{target}/status")
def status(target: str):
    c = _get_container(target)
    raw = _exec(c, "tc -s qdisc show dev eth0 || true")
    return {"target": target, "qdisc": raw, "summary": _parse_tc(raw)}

@app.post("/links/{target}/clear")
def clear(target: str):
    _exec(_get_container(target), "tc qdisc del dev eth0 root 2>/dev/null || true")
    return {"ok": True}

@app.post("/links/apply")
def apply_many(req: ApplyMany):
    if not (req.sources or req.targets):
        raise HTTPException(status_code=400, detail="nothing selected")

    touched = []
    for n in req.sources:
        _apply_one(n, "eth0", req.delay_ms, req.jitter_ms, req.loss_pct, req.rate)
        touched.append(n)
    if req.both:
        for n in req.targets:
            if n in touched: continue
            _apply_one(n, "eth0", req.delay_ms, req.jitter_ms, req.loss_pct, req.rate)
            touched.append(n)

    return {"ok": True, "touched": touched}

@app.post("/links/status_many")
def status_many(body: StatusMany):
    out = {}
    for n in body.names:
        try:
            c   = _get_container(n)
            raw = _exec(c, "tc -s qdisc show dev eth0 || true")
            out[n] = {"qdisc": raw, "summary": _parse_tc(raw)}
        except HTTPException as e:
            out[n] = {"error": e.detail}
    return out

# ---------------------------  Port API ---------------------------------------
@app.get("/links/{target}/{iface}/status")
def status_port(target: str, iface: str):
    iface = _clean_iface(iface)
    raw   = _exec(_get_container(target), f"tc qdisc show dev {iface} || true")
    return {"target": target, "iface": iface, "qdisc": raw, "summary": _parse_tc(raw)}

@app.post("/links/{target}/{iface}/clear")
def clear_port(target: str, iface: str):
    _exec(_get_container(target), f"tc qdisc del dev {_clean_iface(iface)} root 2>/dev/null || true")
    return {"ok": True}

@app.post("/links/apply_ports")
def apply_ports(req: ApplyPorts):
    if not req.ports:
        raise HTTPException(status_code=400, detail="nothing selected")
    touched = []
    for p in req.ports:
        _apply_one(p.name, p.iface, req.delay_ms, req.jitter_ms, req.loss_pct, req.rate, req.ber_pct, req.queue_limit, req.overhead, req.mpu)
        touched.append(f"{p.name}:{_clean_iface(p.iface)}")
    return {"ok": True, "touched": touched}

@app.post("/links/status_ports")
def status_ports(body: StatusPorts):
    out = {}
    for p in body.ports:
        key = f"{p.name}:{_clean_iface(p.iface)}"
        try:
            raw = _exec(_get_container(p.name), f"tc -s qdisc show dev {_clean_iface(p.iface)} || true")
            out[key] = {"qdisc": raw, "summary": _parse_tc(raw)}
        except HTTPException as e:
            out[key] = {"error": e.detail}
    return out

@app.post("/links/apply_ports_matrix")
def apply_ports_matrix(req: ApplyPortsMatrix):
    if not req.items:
        raise HTTPException(status_code=400, detail="nothing selected")
    for it in req.items:
        _apply_one(it.name, it.iface, it.delay_ms, it.jitter_ms, it.loss_pct, it.rate, it.ber_pct, it.queue_limit, it.overhead, it.mpu)
    return {"ok": True, "count": len(req.items)}
from starlette.responses import StreamingResponse
import asyncio, json as _json

@app.get("/ports/stream")
async def ports_stream():
    async def gen():
        while True:
            ports = list_all_ports()
            out = {}
            for p in ports:
                try:
                    raw = _exec(_get_container(p["name"]), f"tc -s qdisc show dev {_clean_iface(p['iface'])} || true")
                    key = f"{p['name']}:{_clean_iface(p['iface'])}"
                    out[key] = {"qdisc": raw, "summary": _parse_tc(raw)}
                except Exception:
                    pass
            yield "data: " + _json.dumps(out) + "\n\n"
            await asyncio.sleep(1.0)
    return StreamingResponse(gen(), media_type="text/event-stream")

# ---------------------------  Tools -----------------------------------------
class PingBody(BaseModel):
    source: str
    target: str
    count: int = 4
    size: Optional[int] = None

@app.post("/tools/ping")
def tools_ping(body: PingBody):
    c = _get_container(body.source)
    cnt = max(1, min(10, int(body.count or 1)))
    sz  = int(body.size) if body.size is not None else None
    size_arg = f" -s {sz}" if sz and sz > 0 else ""
    # -c count, -W 1s per-packet timeout for quicker responses
    cmd = f"ping -c {cnt} -W 1{size_arg} {shlex.quote(body.target)}"
    rc, out = c.exec_run(f"sh -lc {shlex.quote(cmd)}", privileged=True)
    txt = out.decode(errors="ignore")
    return {"ok": rc == 0, "rc": int(rc or 0), "out": txt}
