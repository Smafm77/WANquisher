// ===== WAN Emulator — enhanced frontend =====
const $ = (id)=>document.getElementById(id);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function GET(u){ const r=await fetch(u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function POST(u,b){ const r=await fetch(u,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

function setSpinner(id, on){ const s=$(id); if(!s) return; s.classList.toggle('hidden', !on); }
function log(id, obj){ const n=$(id); if(n) n.textContent = (typeof obj==='string'? obj : JSON.stringify(obj,null,2)); }
function tab(btnId, viewId){
  ['tabStart','tabPorts','tabStatus'].forEach(b=> { const el=$(b); if(el) el.className='px-3 py-1 rounded bg-gray-700'; });
  const curBtn=$(btnId); if(curBtn) curBtn.className='px-3 py-1 rounded bg-emerald-700';
  ['setupView','portsView','startView'].forEach(v=> { const el=$(v); if(el) el.classList.add('hidden'); });
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
let rows = {};         // key -> row state
let pollTimer = null;
let sse = null;

function keyOf(p){ return `${p.name}:${p.iface}`; }

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
  try{
    currentPorts = await GET('/ports');
    const saved = loadConfig();
    $('portsBody').innerHTML = '';
    if(currentPorts.length === 0){
      $('portsBody').innerHTML = '<tr><td colspan="13" class="px-2 py-4 text-center text-xs text-gray-400">No ports found. Create lab first.</td></tr>';
    } else {
      currentPorts.forEach(p => addPortRow(p, saved));
    }
    // Re-attach any custom rows saved earlier
    for(const key of Object.keys(saved)){
      if(!currentPorts.some(p=> keyOf(p)===key)){
        const [name, iface] = key.split(':');
        addPortRow({name, iface}, saved);
      }
    }
    saveConfig(harvestModel());
    await updateStatuses();
  }catch(e){ log('portsOut', 'ERR '+(e.message||e)); }
}

async function updateStatuses(){
  // Build request with all rows
  const ports = [];
  document.querySelectorAll('#portsBody tr').forEach(tr=>{
    const [name, iface] = tr.dataset.key.split(':');
    ports.push({name, iface});
  });
  if(ports.length===0) return;
  try{
    const status = await POST('/links/status_ports', {ports});
    for(const [key, obj] of Object.entries(status)){
      if(obj?.summary) writeStatus(key, obj.summary);
    }
  }catch(e){ /* swallow */ }
}

async function applyChanges(){
  const model = harvestModel();
  saveConfig(model);
  // Convert to matrix items
  const items = Object.values(model).map(m => ({
    name: m.name, iface: m.iface,
    delay_ms: m.delay_ms, jitter_ms: m.jitter_ms, loss_pct: m.loss_pct, rate: m.rate,
    ber_pct: m.ber_pct, queue_limit: m.queue_limit, overhead: m.overhead, mpu: m.mpu
  }));
  try{
    const out = await POST('/links/apply_ports_matrix', {items});
    log('portsOut', out);
    await updateStatuses();
  }catch(e){
    log('portsOut', 'ERR '+(e.message||e));
  }
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
  try{
    sse = new EventSource('/ports/stream');
    $('sseBadge').textContent = 'SSE: connected';
    sse.onmessage = (ev)=>{
      try{
        const data = JSON.parse(ev.data);
        for(const [key, obj] of Object.entries(data)){
          if(obj?.summary) writeStatus(key, obj.summary);
        }
      }catch{}
    };
    sse.onerror = ()=>{ $('sseBadge').textContent = 'SSE: error — retrying'; };
  }catch{
    $('sseBadge').textContent = 'SSE: not supported';
  }
}

// ---------- Wires ----------
$('tabStart')?.addEventListener('click', ()=> tab('tabStart','setupView'));
$('tabPorts')?.addEventListener('click', ()=> { tab('tabPorts','portsView'); });
$('tabStatus')?.addEventListener('click', ()=> { tab('tabStatus','startView'); });

$('createLab')?.addEventListener('click', createLab);
$('destroyLab')?.addEventListener('click', destroyLab);
$('labRefresh')?.addEventListener('click', labStatus);

$('addPort')?.addEventListener('click', addCustomPort);
$('applyChanges')?.addEventListener('click', applyChanges);
$('autoRefresh')?.addEventListener('change', (e)=> setAutoRefresh(e.target.checked));
$('toSetupLink')?.addEventListener('click', (e)=>{ e.preventDefault(); tab('tabStart','setupView'); });

// ---------- Boot ----------
(async ()=>{
  await health();
  tab('tabStart','setupView');
  await refreshPorts();
  await labStatus();
  startSSE();
})();
