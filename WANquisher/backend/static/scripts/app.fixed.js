// ===== WAN Emulator — enhanced frontend =====
const $ = (id)=>document.getElementById(id);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ---------- IPv4 helpers ----------
function stripCidr(s){ if(!s) return ''; const i=s.indexOf('/'); return i>0? s.slice(0,i): s; }
function ipv4ToInt(ip){ return ip.split('.').map(n=>+n).reduce((a,b)=> (a<<8) + (b&255), 0)>>>0; }
function intToIpv4(n){ return [24,16,8,0].map(shift=> (n>>>shift)&255).join('.'); }
function netmaskBitsToInt(bits){ return bits<=0?0: bits>=32?0xFFFFFFFF : (0xFFFFFFFF << (32-bits))>>>0; }
function parseCIDR(cidr){
  if(!cidr) return null; const [ip, maskStr] = cidr.split('/'); const mask = maskStr? +maskStr : 32; const ipInt = ipv4ToInt(ip);
  const maskInt = netmaskBitsToInt(mask); const netInt = (ipInt & maskInt)>>>0; return { ip, mask, ipInt, maskInt, netInt, net: intToIpv4(netInt) };
}
function sameSubnet(cidrA, cidrB){
  const a = parseCIDR(cidrA); const b = parseCIDR(cidrB); if(!a || !b) return false; const m = Math.min(a.mask, b.mask); const mInt = netmaskBitsToInt(m);
  return ((a.ipInt & mInt)>>>0) === ((b.ipInt & mInt)>>>0);
}
function _cleanIface(n){ return (n||'').replace(/@.*$|:$/g,''); }
function resolveServerTarget(clientName, clientIface){
  try{
    const cEntry = currentPorts.find(p=> p.name===clientName && _cleanIface(p.iface)===_cleanIface(clientIface));
    const serverPorts = currentPorts.filter(p=> /_server$/i.test(p.name) && p.ipv4);
    if(cEntry && cEntry.ipv4){
      const sp = serverPorts.find(sp=> sameSubnet(cEntry.ipv4, sp.ipv4));
      if(sp) return stripCidr(sp.ipv4);
    }
    if(serverByName?.ipv4) return stripCidr(serverByName.ipv4);
    if(serverPorts.length) return stripCidr(serverPorts[0].ipv4);
    return '';
  }catch{ return ''; }
}

async function GET(u){ const r=await fetch(u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function POST(u,b){ const r=await fetch(u,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

function setSpinner(id, on){ const s=$(id); if(!s) return; s.classList.toggle('hidden', !on); }
function log(id, obj){ const n=$(id); if(n) n.textContent = (typeof obj==='string'? obj : JSON.stringify(obj,null,2)); }
function downloadText(filename, text){
  try{
    const blob = new Blob([text], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }catch(e){ console.error('Download failed', e); }
}
function ts(){
  const d = new Date(); const pad=(n)=>String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function tab(btnId, viewId){
  ['tabStart','tabPorts','tabStatus','tabHelp'].forEach(b=> { const el=$(b); if(el) el.className='px-3 py-1 rounded bg-gray-700'; });
  const curBtn=$(btnId); if(curBtn) curBtn.className='px-3 py-1 rounded bg-emerald-700';
  ['setupView','portsView','startView','helpView'].forEach(v=> { const el=$(v); if(el) el.classList.add('hidden'); });
  const curView=$(viewId); if(curView) curView.classList.remove('hidden');
}

// ---------- Local storage helpers ----------
const LS_KEY = 'wanemu.portConfig.v2';
function saveConfig(model){ localStorage.setItem(LS_KEY, JSON.stringify(model)); }
function loadConfig(){ try { return JSON.parse(localStorage.getItem(LS_KEY)||'{}'); } catch{ return {}; } }

// ---------- Setup ----------
async function health(){ try { await GET('/health'); } catch(e){ console.error(e); } }
async function labStatus(){
  try{ const s = await GET('/lab/status'); log('labOut', s); }
  catch(e){ log('labOut', 'ERR '+ (e.message||e)); }
}
async function createLab(){
  const ports = parseInt($('portsCount').value||'4',10);
  const recreate = $('recreate').checked;
  setSpinner('createSpinner', true);
  try{
    const out = await POST('/lab/init', {ports, recreate});
    log('setupOut', out);
    await refreshPorts();
    await labStatus();
  // Auto-switch to Port overview after lab is ready
  tab('tabPorts','portsView');
  }catch(e){ log('setupOut', 'ERR ' + (e.message||e)); }
  finally{ setSpinner('createSpinner', false); }
}
async function destroyLab(){
  if(!confirm('Destroy the lab environment? This removes all lab containers & networks.')) return;
  setSpinner('destroySpinner', true);
  try{
    const out = await POST('/lab/destroy', {});
    log('setupOut', out);
    await refreshPorts();
    await labStatus();
  }catch(e){ log('setupOut', 'ERR ' + (e.message||e)); }
  finally{ setSpinner('destroySpinner', false); }
}

// ---------- Ports ----------
let currentPorts = []; // discovered from backend
let serverByName = null; // {name, iface, ipv4}
let rows = {};         // key -> row state
let pollTimer = null;
let sse = null;

function keyOf(p){ return `${p.name}:${p.iface}`; }

// Apply a named preset to a single port card
function applyPresetToCard(card, preset){
  if(!card) return;
  const set = (cls,val)=>{ const el=card.querySelector(cls); if(el) el.value = val; };
  switch(preset){
    case 'none': set('.inp-delay',0); set('.inp-jitter',0); set('.inp-loss',0); set('.inp-ber',0); set('.inp-rate',''); set('.inp-queue',''); break;
    case 'wifi_bad': set('.inp-delay',30); set('.inp-jitter',15); set('.inp-loss',2); set('.inp-ber',0); set('.inp-rate','20mbit'); set('.inp-queue',''); break;
    case 'mobile_3g': set('.inp-delay',120); set('.inp-jitter',80); set('.inp-loss',1); set('.inp-ber',0.2); set('.inp-rate','3mbit'); set('.inp-queue',''); break;
    case 'satellite_geo': set('.inp-delay',600); set('.inp-jitter',50); set('.inp-loss',0.3); set('.inp-ber',0.3); set('.inp-rate','10mbit'); set('.inp-queue','40'); break;
    default: break;
  }
  const sel = card.querySelector('.inp-preset'); if(sel) sel.value = preset || '';
}

function readRow(key){
  const q = (sel)=> document.querySelector(`[data-key="${key}"] ${sel}`);
  return {
    name: q('.inp-name').value.trim(),
    iface: q('.inp-iface').value.trim(),
    delay_ms: parseInt(q('.inp-delay').value||'0',10)||0,
    jitter_ms: parseInt(q('.inp-jitter').value||'0',10)||0,
    loss_pct: parseFloat(q('.inp-loss').value||'0')||0,
    ber_pct: parseFloat(q('.inp-ber').value||'0')||0,
    rate: q('.inp-rate').value.trim()||null,
    queue_limit: parseInt(q('.inp-qlimit').value||'0',10)||null,
    overhead: parseInt(q('.inp-overhead').value||'0',10)||null,
    mpu: 64, // sensible default
  };
}

function writeStatus(key, summary){
  const root = document.querySelector(`[data-key="${key}"]`);
  if(!root) return;
  const tx = summary?.tx || {}; const drops = summary?.drops || {}; const queue = summary?.queue || {};
  root.querySelector('.stat-tx').textContent     = `${tx.bytes??0} / ${tx.frames??0}`;
  root.querySelector('.stat-drops').textContent  = `${drops.total??0} / ${(drops.pct??0)}%`;
  root.querySelector('.stat-queue').textContent  = `${queue.bytes??0} / ${queue.frames??0}`;
}

function addPortRow(p, saved){
  const key = keyOf(p);
  const cfg = saved?.[key] || {};
  const tr = document.createElement('tr');
  tr.dataset.key = key;
  tr.className = 'hover:bg-gray-800/30';
  tr.innerHTML = `
    <td class="px-2 py-2"><input class="inp-name w-40 bg-gray-800 border border-gray-700 rounded px-2 py-1" value="${p.name}"/></td>
    <td class="px-2 py-2"><input class="inp-iface w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1" value="${p.iface}"/></td>
    <td class="px-2 py-2"><input class="inp-delay w-20 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" min="0" value="${cfg.delay_ms??0}"/></td>
    <td class="px-2 py-2"><input class="inp-jitter w-20 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" min="0" value="${cfg.jitter_ms??0}"/></td>
    <td class="px-2 py-2"><input class="inp-loss w-20 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" step="0.01" min="0" max="100" value="${cfg.loss_pct??0}"/></td>
    <td class="px-2 py-2"><input class="inp-ber  w-20 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" step="0.01" min="0" max="100" value="${cfg.ber_pct??0}"/></td>
    <td class="px-2 py-2"><input class="inp-rate w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1" placeholder="10mbit" value="${cfg.rate??''}"/></td>
    <td class="px-2 py-2"><input class="inp-qlimit w-20 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" min="0" placeholder="pkts" value="${cfg.queue_limit??''}"/></td>
    <td class="px-2 py-2"><input class="inp-overhead w-24 text-right bg-gray-800 border border-gray-700 rounded px-2 py-1" type="number" min="0" placeholder="bytes" value="${cfg.overhead??''}"/></td>
    <td class="px-2 py-2"><div class="stat-tx text-gray-300">—</div></td>
    <td class="px-2 py-2"><div class="stat-drops text-gray-300">—</div></td>
    <td class="px-2 py-2"><div class="stat-queue text-gray-300">—</div></td>
    <td class="px-2 py-2"><button class="btn-del px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">×</button></td>
  `;
  tr.querySelector('.btn-del').addEventListener('click', ()=>{
    tr.remove();
    // Save removal
    const model = harvestModel();
    saveConfig(model);
  });
  $('portsBody').appendChild(tr);
}

function harvestModel(){
  const model = {};
  document.querySelectorAll('#portsBody tr').forEach(tr=>{
    const k = tr.dataset.key;
    model[k] = readRow(k);
  });
  return model;
}

async function refreshPorts(){
  // Fetch active ports from backend and render cards
  let ports = [];
  try { ports = await GET('/ports'); } catch(e){ ports = []; }
  currentPorts = ports;
  // Split into server and clients by naming convention
  const serverCards = document.getElementById('serverCards');
  const clientCards = document.getElementById('clientCards');
  if(!serverCards || !clientCards) return;
  serverCards.innerHTML = '';
  clientCards.innerHTML = '';
  const saved = JSON.parse(localStorage.getItem('wanemu_cfg')||'{}');
  // Choose server entry = LAB_NS_server:eth0 (first match), else any with name includes _server
  serverByName = null;
  const serverPorts = ports.filter(p=> /_server$/i.test(p.name));
  if(serverPorts.length){ serverByName = serverPorts[0]; }
  ports.forEach(p=>{
    const cfg = saved[keyOf(p)] || {};
    const html = cardHTML(p, cfg);
    if(/_server$/i.test(p.name)) serverCards.insertAdjacentHTML('beforeend', html);
    else clientCards.insertAdjacentHTML('beforeend', html);
  });
  // Per-card presets
  document.querySelectorAll('.port-card .inp-preset').forEach(sel=>{
    sel.addEventListener('change', (e)=>{
      const card = e.target.closest('.port-card');
      applyPresetToCard(card, e.target.value);
    });
  });
  // No user-settable ping target; ensure buttons present
}

async function updateStatuses(){
  // Build request with all cards
  const reqPorts = [];
  document.querySelectorAll('.port-card').forEach(card=>{
    const [name, iface] = (card.dataset.key||'').split(':');
    if(name && iface) reqPorts.push({name, iface});
  });
  if(reqPorts.length===0) return;
  try{
    const status = await POST('/links/status_ports', {ports: reqPorts});
    const items = [];
    if(Array.isArray(status)){
      items.push(...status);
    }else if(status && typeof status === 'object'){
      for(const [key, obj] of Object.entries(status)){
        const [name, iface] = key.split(':');
        const s = obj?.summary || {};
        items.push({ key, name, iface, tx: s.tx, tx_bytes: s.tx?.bytes, tx_frames: s.tx?.frames, drops_total: s.drops?.total });
      }
    }
    paintStats(items);
  }catch(e){ /* swallow */ }
}

async function applyChanges(){
  // Collect values from all cards and apply in batch
  const items = [];
  document.querySelectorAll('.port-card').forEach(card=>{
    const [name, iface] = (card.dataset.key||'').split(':');
    const v = (sel)=> (card.querySelector(sel)?.value)||'';
    if(!name || !iface) return;
    items.push({
      name, iface,
      delay_ms:+v('.inp-delay')||0,
      jitter_ms:+v('.inp-jitter')||0,
      loss_pct:+v('.inp-loss')||0,
      ber_pct:+v('.inp-ber')||0,
      rate: v('.inp-rate')||null,
      queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
    });
  });
  try{
    const out = await POST('/links/apply_ports_matrix', {items});
    log('portsOut', out);
    // Save to browser store
    const cfg = JSON.parse(localStorage.getItem('wanemu_cfg')||'{}');
    items.forEach(it=>{ cfg[`${it.name}:${it.iface}`] = it; });
    localStorage.setItem('wanemu_cfg', JSON.stringify(cfg));
    await updateStatuses();
  }catch(e){
    log('portsOut', 'ERR '+(e.message||e));
  }
}

async function applyChangesForCards(cardList){
  const items = [];
  Array.from(cardList||[]).forEach(card=>{
    const [name, iface] = (card.dataset.key||'').split(':');
    const v = (sel)=> (card.querySelector(sel)?.value)||'';
    if(!name || !iface) return;
    items.push({
      name, iface,
      delay_ms:+v('.inp-delay')||0,
      jitter_ms:+v('.inp-jitter')||0,
      loss_pct:+v('.inp-loss')||0,
      ber_pct:+v('.inp-ber')||0,
      rate: v('.inp-rate')||null,
      queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
    });
  });
  if(items.length===0) return;
  try{
    const out = await POST('/links/apply_ports_matrix', {items});
    log('portsOut', out);
    const cfg = JSON.parse(localStorage.getItem('wanemu_cfg')||'{}');
    items.forEach(it=>{ cfg[`${it.name}:${it.iface}`] = it; });
    localStorage.setItem('wanemu_cfg', JSON.stringify(cfg));
    await updateStatuses();
  }catch(e){ log('portsOut', 'ERR '+(e.message||e)); }
}

function addCustomPort(){
  const name = prompt('Container name (target):');
  if(!name) return;
  const iface = prompt('Interface (e.g., eth0):', 'eth0') || 'eth0';
  addPortRow({name, iface}, loadConfig());
  saveConfig(harvestModel());
}

// ---------- Auto-refresh & SSE ----------
function setAutoRefresh(on){
  if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
  if(on){ pollTimer = setInterval(updateStatuses, 2000); }
}
function startSSE(){
  if(sse){ try{sse.close();}catch{} sse=null; }
  const badge = $('sseBadge');
  try{
    sse = new EventSource('/ports/stream');
    if(badge) badge.textContent = 'SSE: connected';
    sse.onmessage = (ev)=>{
      try{
        const data = JSON.parse(ev.data);
        // Accept either array or keyed object with summary
        if(Array.isArray(data)){
          paintStats(data);
        }else if(data && typeof data === 'object'){
          const items = [];
          for(const [key, obj] of Object.entries(data)){
            const [name, iface] = key.split(':');
            const s = obj?.summary || {};
            items.push({ key, name, iface, tx: s.tx, tx_bytes: s.tx?.bytes, tx_frames: s.tx?.frames, drops_total: s.drops?.total });
          }
          paintStats(items);
        }
      }catch{}
    };
    sse.onerror = ()=>{ if(badge) badge.textContent = 'SSE: error — retrying'; };
  }catch{
    if(badge) badge.textContent = 'SSE: not supported';
  }
}

// ---------- Wires ----------
$('tabStart')?.addEventListener('click', ()=> tab('tabStart','setupView'));
$('tabPorts')?.addEventListener('click', ()=> { tab('tabPorts','portsView'); });
$('tabStatus')?.addEventListener('click', ()=> { tab('tabStatus','startView'); });
$('tabHelp')?.addEventListener('click', ()=> { tab('tabHelp','helpView'); });

$('createLab')?.addEventListener('click', createLab);
$('destroyLab')?.addEventListener('click', destroyLab);
$('labRefresh')?.addEventListener('click', labStatus);

$('addPort')?.addEventListener('click', addCustomPort);
$('applyChanges')?.addEventListener('click', applyChanges);
// removed live stats checkbox
$('toSetupLink')?.addEventListener('click', (e)=>{ e.preventDefault(); tab('tabStart','setupView'); });

// Global preset apply to all cards
document.getElementById('applyPresetAll')?.addEventListener('click', async ()=>{
  const preset = document.getElementById('globalPreset')?.value || '';
  if(!preset) return;
  document.querySelectorAll('#clientCards .port-card, #serverCards .port-card').forEach(card=> applyPresetToCard(card, preset));
  // Apply to backend in one go
  await applyChanges();
});

// Apply to all clients only
document.getElementById('applyPresetClients')?.addEventListener('click', async ()=>{
  const preset = document.getElementById('globalPreset')?.value || '';
  if(!preset) return;
  const cards = document.querySelectorAll('#clientCards .port-card');
  cards.forEach(card=> applyPresetToCard(card, preset));
  await applyChangesForCards(cards);
});

// Apply to all ports (server-side cards) only
document.getElementById('applyPresetPorts')?.addEventListener('click', async ()=>{
  const preset = document.getElementById('globalPreset')?.value || '';
  if(!preset) return;
  const cards = document.querySelectorAll('#serverCards .port-card');
  cards.forEach(card=> applyPresetToCard(card, preset));
  await applyChangesForCards(cards);
});

// ---------- Boot ----------
(async ()=>{
  await health();
  tab('tabStart','setupView');
  await refreshPorts();
  await labStatus();
  startSSE();
})();

function cardHTML(p, cfg={}){
  const key = keyOf(p);
  const delay  = cfg.delay_ms??0;
  const jitter = cfg.jitter_ms??0;
  const loss   = cfg.loss_pct??0;
  const ber    = cfg.ber_pct??0;
  const rate   = cfg.rate??'';
  const queue  = (cfg.queue_limit??'');
  const ipSub  = p.ipv4 ? `<span class="port-sub"> • ${p.ipv4}</span>` : '';
  const isServer = /_server$/i.test(p.name);
  // Rename servers to PortN visually
  const portLabel = isServer ? (function(){
    // Extract index from iface digits and present as 1-based
    const idxStr = (p.iface.match(/\d+/)||[])[0];
    const idx = idxStr ? (parseInt(idxStr,10)+1) : null;
    return idx ? `Port ${idx}` : 'Port';
  })() : p.name;
  return `
  <div class="port-card" data-key="${key}">
    <div class="port-head">
      <div class="port-title">${portLabel}<span class="port-sub"> • ${p.iface}</span>${ipSub}</div>
      <select class="inp-preset bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs">
        <option value="">Preset…</option>
        <option value="none">No shaping</option>
        <option value="wifi_bad">Wi‑Fi bad</option>
        <option value="mobile_3g">Mobile 3G</option>
        <option value="satellite_geo">Satellite GEO</option>
      </select>
    </div>
    <div class="port-grid">
      <label>Delay ms<input class="inp-delay" type="number" min="0" value="${delay}"/></label>
      <label>Jitter ms<input class="inp-jitter" type="number" min="0" value="${jitter}"/></label>
      <label>Loss %<input class="inp-loss" type="number" step="0.01" min="0" max="100" value="${loss}"/></label>
      <label>Rate<input class="inp-rate" placeholder="10mbit" value="${rate}"/></label>
    </div>
    ${isServer ? `
    <div class="port-grid" style="margin-top:0.25rem">
      <label>Count<select class="inp-ping-count"><option>1</option><option selected>4</option><option>6</option><option>10</option><option value="inf">∞</option></select></label>
    </div>` : `
    <div class="port-grid" style="margin-top:0.25rem">
      <label>Count<select class="inp-ping-count"><option>1</option><option selected>4</option><option>6</option><option>10</option><option value="inf">∞</option></select></label>
    </div>
    `}
    <details class="port-adv">
      <summary>Advanced</summary>
      <div class="port-grid" style="margin-top:0.25rem">
        <label>BER %<input class="inp-ber" type="number" step="0.01" min="0" max="100" value="${ber}"/></label>
        <label>Queue<input class="inp-queue" type="number" min="0" placeholder="auto" value="${queue}"/></label>
      </div>
    </details>
  <div class="flex items-center justify-between mt-1">\n  <div class="port-stats" data-stats="${key}">—</div>\n  <div class="flex gap-2 items-center">\n    ${isServer ? '<button class="btn-ping-server-to-client px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">Ping client</button>' : '<button class="btn-ping-one px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">Ping server</button>'}\n    <button class="btn-stop-ping px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 hidden">Stop</button>\n    <button class="btn-save-log px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">Save log</button>\n    <button class="btn-apply-one px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">Apply</button>\n  </div>\n</div>
    <pre class="ping-out hidden bg-black/50 rounded p-2 text-xs whitespace-pre-wrap" style="margin-top:0.25rem"></pre>
  </div>`;
}

function getLabs(){ try{ return JSON.parse(localStorage.getItem('wanemu_labs')||'{}'); }catch(_){ return {}; } }
function setLabs(obj){ localStorage.setItem('wanemu_labs', JSON.stringify(obj)); }
function loadLabsList(){
  const sel = document.getElementById('loadLabSelect'); if(!sel) return;
  const labs = getLabs();
  sel.innerHTML = '';
  const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='—';
  sel.appendChild(opt0);
  Object.keys(labs).sort().forEach(name=>{
    const o = document.createElement('option'); o.value=name; o.textContent=name;
    sel.appendChild(o);
  });
}
document.getElementById('saveLabBtn')?.addEventListener('click', ()=>{
  const name = (document.getElementById('labName')?.value||'').trim();
  if(!name) { alert('Enter a lab name'); return; }
  // Collect current port settings from cards
  const rows = Array.from(document.querySelectorAll('.port-card'));
  const cfg = {};
  rows.forEach(tr=>{
    const key = tr.dataset.key;
    const v = (sel)=> (tr.querySelector(sel)?.value)||'';
    cfg[key] = {
      name: key.split(':')[0],
      iface: key.split(':')[1],
      delay_ms:+v('.inp-delay')||0,
      jitter_ms:+v('.inp-jitter')||0,
      loss_pct:+v('.inp-loss')||0,
      ber_pct:+v('.inp-ber')||0,
      rate:v('.inp-rate')||null,
      queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
    };
  });
  const labs = getLabs(); labs[name] = { saved_at: Date.now(), cfg };
  setLabs(labs); loadLabsList();
});
document.getElementById('loadLabBtn')?.addEventListener('click', ()=>{
  const name = document.getElementById('loadLabSelect')?.value||'';
  if(!name) return;
  const labs = getLabs(); const lab = labs[name]; if(!lab) return;
  // Paint only for currently active ports
  const rows = Array.from(document.querySelectorAll('.port-card'));
  rows.forEach(tr=>{
    const key = tr.dataset.key; const s = lab.cfg[key]; if(!s) return;
    tr.querySelector('.inp-delay').value  = s.delay_ms || 0;
    tr.querySelector('.inp-jitter').value = s.jitter_ms || 0;
    tr.querySelector('.inp-loss').value   = s.loss_pct || 0;
    tr.querySelector('.inp-ber').value    = s.ber_pct || 0;
    tr.querySelector('.inp-rate').value   = s.rate || '';
    tr.querySelector('.inp-queue').value  = s.queue_limit || '';
  });
});
document.getElementById('deleteLabBtn')?.addEventListener('click', ()=>{
  const name = document.getElementById('loadLabSelect')?.value||'';
  if(!name) return;
  const labs = getLabs(); delete labs[name]; setLabs(labs); loadLabsList();
});
// Keep existing export/import for raw port cfg
document.getElementById('exportConfig')?.addEventListener('click', ()=>{
  const rows = Array.from(document.querySelectorAll('.port-card'));
  const cfg = {};
  rows.forEach(tr=>{
    const key = tr.dataset.key;
    const v = (sel)=> (tr.querySelector(sel)?.value)||'';
    cfg[key] = {
      name: key.split(':')[0],
      iface: key.split(':')[1],
      delay_ms:+v('.inp-delay')||0,
      jitter_ms:+v('.inp-jitter')||0,
      loss_pct:+v('.inp-loss')||0,
      ber_pct:+v('.inp-ber')||0,
      rate:v('.inp-rate')||null,
      queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
    };
  });
  const blob = new Blob([JSON.stringify(cfg,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wanemu-config.json'; a.click(); URL.revokeObjectURL(a.href);
});
document.getElementById('importConfig')?.addEventListener('change', (e)=>{
  const f = e.target.files?.[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const obj = JSON.parse(reader.result);
      localStorage.setItem('wanemu_cfg', JSON.stringify(obj));
      alert('Imported config to browser store. Click Load to paint values onto active ports.');
    }catch(err){ alert('Invalid JSON'); }
  };
  reader.readAsText(f);
});

// Setup page: Save/Load lab JSON to/from disk
document.getElementById('saveLabJson')?.addEventListener('click', ()=>{
  // Build config from visible cards (preferred) or stored cfg fallback
  const cards = Array.from(document.querySelectorAll('.port-card'));
  const cfg = {};
  if(cards.length){
    cards.forEach(card=>{
      const key = card.dataset.key;
      const v = (sel)=> (card.querySelector(sel)?.value)||'';
      cfg[key] = {
        name: key.split(':')[0],
        iface: key.split(':')[1],
        delay_ms:+v('.inp-delay')||0,
        jitter_ms:+v('.inp-jitter')||0,
        loss_pct:+v('.inp-loss')||0,
        ber_pct:+v('.inp-ber')||0,
        rate:v('.inp-rate')||null,
        queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
      };
    });
  } else {
    Object.assign(cfg, JSON.parse(localStorage.getItem('wanemu_cfg')||'{}'));
  }
  const keys = Object.keys(cfg);
  const clientCount = new Set(keys.map(k=> k.split(':')[0]).filter(n=> /^client\d+$/i.test(n))).size;
  const serverCount = new Set(keys.filter(k=> (k.split(':')[0]||'').endsWith('_server')).map(k=> k.split(':')[1])).size;
  const meta = { schema: 'wanemu.lab.v1', saved_at: new Date().toISOString(), ports: Math.max(clientCount, serverCount, 0) };
  const name = (document.getElementById('labName')?.value||'lab');
  downloadText(`${name}.wanemu.json`, JSON.stringify({ meta, cfg }, null, 2));
});

document.getElementById('loadLabTrigger')?.addEventListener('click', ()=>{
  document.getElementById('loadLabFile')?.click();
});
document.getElementById('loadLabFile')?.addEventListener('change', async (e)=>{
  const f = e.target.files?.[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const obj = JSON.parse(reader.result);
      const cfg = obj?.cfg && typeof obj.cfg==='object' ? obj.cfg : (obj && typeof obj==='object' ? obj : {});
      const keys = Object.keys(cfg||{});
      const clientCount = new Set(keys.map(k=> k.split(':')[0]).filter(n=> /^client\d+$/i.test(n))).size;
      const serverCount = new Set(keys.filter(k=> (k.split(':')[0]||'').endsWith('_server')).map(k=> k.split(':')[1])).size;
      const desiredPorts = Math.max(Number(obj?.meta?.ports)||0, clientCount, serverCount, 0);
      if(desiredPorts>0){
        try{ setSpinner('createSpinner', true); await POST('/lab/init', {ports: desiredPorts, recreate: true}); }
        catch(initErr){ console.warn('Init failed during load:', initErr); }
        finally{ setSpinner('createSpinner', false); }
      }
      await refreshPorts();
      const cards = Array.from(document.querySelectorAll('.port-card'));
      cards.forEach(card=>{
        const key = card.dataset.key; const s = cfg[key]; if(!s) return;
        const set = (sel,val)=>{ const el=card.querySelector(sel); if(el) el.value = (val ?? (el.type==='number'? 0 : '')); };
        set('.inp-delay', s.delay_ms);
        set('.inp-jitter', s.jitter_ms);
        set('.inp-loss', s.loss_pct);
        set('.inp-ber', s.ber_pct);
        set('.inp-rate', s.rate);
        set('.inp-queue', s.queue_limit);
      });
  await applyChanges();
  // Refresh setup fields (portsCount) and status, then go to Ports view
  if(Number.isFinite(desiredPorts) && desiredPorts>0){ const pc=$('portsCount'); if(pc) pc.value = String(desiredPorts); }
  log('setupOut', `Loaded lab from JSON (ports=${desiredPorts||'unknown'}). Applied settings.`);
  await labStatus();
  tab('tabPorts','portsView');
    }catch(err){ alert('Invalid lab JSON'); }
  };
  reader.readAsText(f);
});

async function applyOne(card){
  const [name, iface] = (card.dataset.key||'').split(':');
  const v = (sel)=> (card.querySelector(sel)?.value)||'';
  const payloadApply = {
    ports: [{ name, iface }],
    delay_ms: +v('.inp-delay')||0,
    jitter_ms:+v('.inp-jitter')||0,
    loss_pct:+v('.inp-loss')||0,
    ber_pct: +v('.inp-ber')||0,
    rate: v('.inp-rate')||null,
    queue_limit: v('.inp-queue')? +v('.inp-queue')||null : null
  };
  try{
    card.classList.add('ring','ring-emerald-600','ring-offset-1','ring-offset-gray-900');
    await POST('/links/apply_ports', payloadApply);
    await POST('/links/status_ports', { ports: [{ name, iface }] });
    const cfg = JSON.parse(localStorage.getItem('wanemu_cfg')||'{}');
    cfg[`${name}:${iface}`] = {
      name, iface,
      delay_ms: payloadApply.delay_ms,
      jitter_ms: payloadApply.jitter_ms,
      loss_pct: payloadApply.loss_pct,
      ber_pct: payloadApply.ber_pct,
      rate: payloadApply.rate,
      queue_limit: payloadApply.queue_limit
    };
    localStorage.setItem('wanemu_cfg', JSON.stringify(cfg));
  }catch(e){
    console.error(e);
    card.classList.add('ring','ring-red-600','ring-offset-1','ring-offset-gray-900');
    setTimeout(()=>card.classList.remove('ring','ring-red-600','ring-offset-1','ring-offset-gray-900'), 1200);
    return;
  }
  setTimeout(()=>card.classList.remove('ring','ring-emerald-600','ring-offset-1','ring-offset-gray-900'), 800);
}

// Delegate clicks for per-card Apply
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.btn-apply-one');
  if(!btn) return;
  const card = btn.closest('.port-card');
  if(card) applyOne(card);
});

// Delegate clicks for per-card Ping
document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('.btn-ping-one');
  if(!btn) return;
  const card = btn.closest('.port-card');
  if(!card) return;
  const [name, iface] = (card.dataset.key||'').split(':');
  // Resolve server IP to ping
  let target = resolveServerTarget(name, iface) || '';
  // Also try to capture the exact server port (name:iface) on same subnet for logging
  try{
    const cEntry = currentPorts.find(p=> p.name===name && _cleanIface(p.iface)===_cleanIface(iface));
    const serverPorts = currentPorts.filter(p=> /_server$/i.test(p.name) && p.ipv4);
    const sp = cEntry && cEntry.ipv4 ? serverPorts.find(sp=> sameSubnet(cEntry.ipv4, sp.ipv4)) : null;
    if(sp){ card.dataset.pingPortKey = `${sp.name}:${sp.iface}`; }
  }catch{}
  const selVal = (card.querySelector('.inp-ping-count')?.value || '4');
  const endless = selVal === 'inf';
  const count  = endless ? 1 : (parseInt(selVal, 10) || 4);
  const outEl = card.querySelector('.ping-out');
  const btnStop = card.querySelector('.btn-stop-ping');
  // Save ping context for later log export
  card.dataset.pingTarget = target;
  card.dataset.pingDirection = 'client-to-server';
  card.dataset.pingClientName = name || '';
  card.dataset.pingCount = selVal;
  if(outEl){ outEl.classList.remove('hidden'); outEl.textContent = `ping ${target} -c ${count} …`; }
  const doOnce = async()=>{
    try{
      const res = await POST('/tools/ping', { source: name, target, count });
      if(outEl){ outEl.textContent = res?.out || JSON.stringify(res,null,2); }
    }catch(err){ if(outEl){ outEl.textContent = 'Ping failed: ' + (err?.message||String(err)); } }
  };
  if(!endless){
    await doOnce();
  } else {
    outEl.textContent = `ping ${target} (continuous)…\n`;
    card.dataset.pingRun = '1';
    btn.classList.add('hidden'); if(btnStop) btnStop.classList.remove('hidden');
    while(card.dataset.pingRun === '1' && document.body.contains(card)){
      try{
        const res = await POST('/tools/ping', { source: name, target, count: 1 });
        const txt = (res?.out || '').trim();
        // Try to extract RTT
        const lines = txt.split(/\r?\n/);
        let printed = false;
        for(const ln of lines){
          const mTime = ln.match(/time[=<]([0-9.]+)\s*ms/i);
          if(mTime){
            const mSeq = ln.match(/(?:icmp_)?seq[= ](\d+)/i) || ln.match(/seq[= ](\d+)/i);
            const seq = mSeq ? `#${mSeq[1]} ` : '';
            outEl.textContent += `${seq}${mTime[1]} ms\n`;
            printed = true; break;
          }
        }
        if(!printed) outEl.textContent += txt + "\n";
        outEl.scrollTop = outEl.scrollHeight;
      }catch(err){ outEl.textContent += 'Ping error: ' + (err?.message||String(err)) + "\n"; }
      await sleep(1000);
    }
    btn.classList.remove('hidden'); if(btnStop) btnStop.classList.add('hidden');
  }
});

// Stop endless ping
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.btn-stop-ping');
  if(!btn) return;
  const card = btn.closest('.port-card'); if(!card) return;
  card.dataset.pingRun = '0';
});

// Server -> Client ping (per-port card)
document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('.btn-ping-server-to-client');
  if(!btn) return;
  const card = btn.closest('.port-card'); if(!card) return;
  const [serverName, serverIface] = (card.dataset.key||'').split(':');
  // Find matching client on same subnet
  const srvEntry = currentPorts.find(p=> p.name===serverName && _cleanIface(p.iface)===_cleanIface(serverIface));
  const candidates = currentPorts.filter(p=> !/_server$/i.test(p.name) && p.ipv4);
  let target = '';
  let matchedClientName = '';
  if(srvEntry && srvEntry.ipv4){
    const match = candidates.find(cl=> sameSubnet(srvEntry.ipv4, cl.ipv4));
    if(match){ target = stripCidr(match.ipv4); matchedClientName = match.name; card.dataset.pingPortKey = `${match.name}:${match.iface}`; }
  }
  if(!target && candidates.length){ target = stripCidr(candidates[0].ipv4); matchedClientName = candidates[0].name; card.dataset.pingPortKey = `${candidates[0].name}:${candidates[0].iface}`; }
  const selVal = (card.querySelector('.inp-ping-count')?.value || '4');
  const endless = selVal === 'inf';
  const count  = endless ? 1 : (parseInt(selVal, 10) || 4);
  const outEl = card.querySelector('.ping-out');
  const btnStop = card.querySelector('.btn-stop-ping');
  // Save ping context for later log export
  card.dataset.pingTarget = target;
  card.dataset.pingDirection = 'server-to-client';
  card.dataset.pingClientName = matchedClientName || '';
  card.dataset.pingCount = selVal;
  if(outEl){ outEl.classList.remove('hidden'); outEl.textContent = `ping ${target} -c ${count} …`; }
  const doOnce = async()=>{
    try{
      const res = await POST('/tools/ping', { source: serverName, target, count });
      if(outEl){ outEl.textContent = res?.out || JSON.stringify(res,null,2); }
    }catch(err){ if(outEl){ outEl.textContent = 'Ping failed: ' + (err?.message||String(err)); } }
  };
  if(!endless){
    await doOnce();
  } else {
    outEl.textContent = `ping ${target} (continuous)…\n`;
    card.dataset.pingRun = '1';
    btn.classList.add('hidden'); if(btnStop) btnStop.classList.remove('hidden');
    while(card.dataset.pingRun === '1' && document.body.contains(card)){
      try{
        const res = await POST('/tools/ping', { source: serverName, target, count: 1 });
        const txt = (res?.out || '').trim();
        const lines = txt.split(/\r?\n/);
        let printed = false;
        for(const ln of lines){
          const mTime = ln.match(/time[=<]([0-9.]+)\s*ms/i);
          if(mTime){
            const mSeq = ln.match(/(?:icmp_)?seq[= ](\d+)/i) || ln.match(/seq[= ](\d+)/i);
            const seq = mSeq ? `#${mSeq[1]} ` : '';
            outEl.textContent += `${seq}${mTime[1]} ms\n`;
            printed = true; break;
          }
        }
        if(!printed) outEl.textContent += txt + "\n";
        outEl.scrollTop = outEl.scrollHeight;
      }catch(err){ outEl.textContent += 'Ping error: ' + (err?.message||String(err)) + "\n"; }
      await sleep(1000);
    }
    btn.classList.remove('hidden'); if(btnStop) btnStop.classList.add('hidden');
  }
});

// Save-only ping log per card
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.btn-save-log'); if(!btn) return;
  const card = btn.closest('.port-card'); if(!card) return;
  const outEl = card.querySelector('.ping-out');
  const key = card.dataset.key || '';
  const [name, iface] = key.split(':');
  const clientName = card.dataset.pingClientName || (name && /^client\d+$/i.test(name) ? name : (name||'client'));
  const target = card.dataset.pingTarget || '';
  const direction = card.dataset.pingDirection || 'unknown';
  const countSel = card.dataset.pingCount || '';
  const v = (sel)=> (card.querySelector(sel)?.value)||'';
  const settings = `delay=${v('.inp-delay')}ms, jitter=${v('.inp-jitter')}ms, loss=${v('.inp-loss')}%, ber=${v('.inp-ber')}%, rate=${v('.inp-rate')||'—'}, queue=${v('.inp-queue')||'auto'}`;
  const pingedPort = card.dataset.pingPortKey || '';
  let pingedPortSettings = '';
  if(pingedPort){
    const portCard = document.querySelector(`.port-card[data-key="${pingedPort}"]`);
    if(portCard){
      const vp = (sel)=> (portCard.querySelector(sel)?.value)||'';
      pingedPortSettings = `delay=${vp('.inp-delay')}ms, jitter=${vp('.inp-jitter')}ms, loss=${vp('.inp-loss')}%, ber=${vp('.inp-ber')}%, rate=${vp('.inp-rate')||'—'}, queue=${vp('.inp-queue')||'auto'}`;
    }
  }
  const header = [
    'WAN Emulator Ping Log',
    `Saved: ${new Date().toISOString()}`,
    `Client: ${clientName}`,
    `Card: ${key}`,
    pingedPort ? `Pinged port: ${pingedPort}` : null,
    pingedPort && pingedPortSettings ? `Pinged port settings: ${pingedPortSettings}` : null,
    `Direction: ${direction}`,
    `Target: ${target}`,
    countSel ? `Count: ${countSel}` : null,
    `Settings: ${settings}`,
    '---',
  ].filter(Boolean).join('\n');
  const content = (outEl?.textContent||'').trim();
  const safeClient = (clientName||'client').replace(/[^A-Za-z0-9_.-]/g,'_');
  downloadText(`ping-${safeClient}-${ts()}.txt`, `${header}\n${content}`);
});

function formatNum(n){
  if(n==null || isNaN(n)) return '0';
  n = Number(n);
  if(n>=1e9) return (n/1e9).toFixed(2)+'G';
  if(n>=1e6) return (n/1e6).toFixed(2)+'M';
  if(n>=1e3) return (n/1e3).toFixed(1)+'k';
  return String(n|0);
}
function paintStats(items){
  if(!Array.isArray(items)) return;
  items.forEach(s=>{
    const key = (s.key) ? s.key : `${s.name||s.target||''}:${s.iface||s.if||s.interface||''}`;
    if(!key || !key.includes(':')) return;
    const el = document.querySelector(`.port-card[data-key="${key}"] .port-stats`);
    if(!el) return;
    const tx_b = s.tx_bytes ?? s.bytes_tx ?? s.tx?.bytes ?? s.txBytes ?? 0;
    const tx_f = s.tx_frames ?? s.frames_tx ?? s.tx?.frames ?? s.txFrames ?? s.pkts_tx ?? s.packets_tx ?? 0;
    const dr_t = s.drops_total ?? s.drops ?? s.drop ?? 0;
    el.textContent = `${formatNum(tx_b)}B / ${formatNum(tx_f)}f · drops ${formatNum(dr_t)}`;
  });
}
