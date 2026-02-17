// src/routes/admin.js
import { Router } from "express";

import {
  setUserStatus,
  setUserPlan,
  setUserQuotaUsed,
  setUserTrialUsed,
  getUserSnapshot,
  listUsers,
  clearLastPrompt, // ✅ V16.4.6: limpar via DEL (não SET "")
  setLastPrompt, // ✅ TESTE CONTROLADO: forçar setLastPrompt("")
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
} from "../services/window24h.js";

import {
  getGlobalDescriptionMetrics,
  getUserDescriptionMetrics,
  getGlobalLastNDays,
  getGlobalLastNMonths,
  getGlobalDaysRange,
  getUserLastNDays,
  getUserLastNMonths,
  getUserDaysRange,
} from "../services/metrics.js";

import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import {
  listPlans,
  upsertPlan,
  setPlanActive,
  getPlansHealth,
  listSystemAlerts,
  getSystemAlertsCount,
} from "../services/plans.js";

import { createCampaignAndDispatch, listCampaigns, getCampaign } from "../services/broadcast.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requireWaId(req) {
  const waId = String(req.query?.waId || "").trim();
  if (!waId) {
    const err = new Error("waId required (ex: ?waId=5511...)");
    err.statusCode = 400;
    throw err;
  }
  return waId;
}

export function adminRouter() {
  const router = Router();

  // ===================== Dashboard (Métricas consolidadas) =====================
  // ✅ V16.4.9 — Dashboard consolidado (global + por usuário)
  function toInt(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  async function mapLimit(items, limit, fn) {
    const arr = Array.isArray(items) ? items : [];
    const lim = Math.max(1, toInt(limit, 10));
    const out = new Array(arr.length);
    let i = 0;

    async function worker() {
      while (i < arr.length) {
        const idx = i++;
        try {
          out[idx] = await fn(arr[idx], idx);
        } catch (e) {
          out[idx] = { __error: true, message: String(e?.message || e) };
        }
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(lim, arr.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  router.get("/dashboard/data", async (req, res) => {
    const waId = String(req.query?.waId || "").trim();

    const global = await getGlobalDescriptionMetrics();
    const window24hCount = await countWindow24hActive();

    // ✅ V16.5.0 — Catálogo de planos do sistema (para exibir nomes/valores no dashboard)
    let systemPlans = [];
    let systemPlansError = "";
    try {
      systemPlans = await listPlans();
    } catch (e) {
      systemPlansError = String(e?.message || e);
      systemPlans = [];
    }

    let users = [];
    let usersError = "";
    try {
      users = await listUsers();
    } catch (e) {
      usersError = String(e?.message || e);
      users = [];
    }

    const totalUsers = users.length;

    // Status breakdown (best-effort)
    const statuses = {
      TRIAL: 0,
      ACTIVE: 0,
      WAIT_PLAN: 0,
      PAYMENT_PENDING: 0,
      BLOCKED: 0,
      UNKNOWN: 0,
    };

    // Plano breakdown (best-effort)
    const plans = {}; // { CODE: count }

    const snapshots = await mapLimit(users, 25, async (id) => {
      const snap = await getUserSnapshot(id);
      return snap || {};
    });

    for (const s of snapshots) {
      const st = String(s?.status || "").toUpperCase() || "UNKNOWN";
      if (statuses[st] === undefined) statuses.UNKNOWN++;
      else statuses[st]++;

      const p = String(s?.plan || "").toUpperCase().trim();
      if (p) plans[p] = (plans[p] || 0) + 1;
    }

    // User section (optional)
    let user = null;
    if (waId) {
      const snap = await getUserSnapshot(waId);
      const metrics = await getUserDescriptionMetrics(waId);
      user = { snapshot: snap || {}, metrics };
    }

    res.json({
      ok: true,
      ts: Date.now(),
      global,
      window24hCount,
      systemPlans,
      systemPlansError: systemPlansError || undefined,
      users: {
        total: totalUsers,
        statuses,
        plans,
        error: usersError || undefined,
      },
      user,
    });
  });

  
  // ✅ Histórico do Dashboard (global + opcional por usuário)
  // GET /admin/dashboard/history?days=30&months=12&start=YYYY-MM-DD&end=YYYY-MM-DD&waId=...
  router.get("/dashboard/history", async (req, res) => {
    try {
      const waId = String(req.query?.waId || "").trim();
      const days = Number(req.query?.days || 30);
      const months = Number(req.query?.months || 12);
      const start = String(req.query?.start || "").trim();
      const end = String(req.query?.end || "").trim();

      // Global daily
      let globalDays;
      if (start && end) globalDays = await getGlobalDaysRange({ start, end });
      else globalDays = await getGlobalLastNDays(days);

      // Global monthly (sempre últimos N meses)
      const globalMonths = await getGlobalLastNMonths(months);

      // User series (optional)
      let user = null;
      if (waId) {
        let userDays;
        if (start && end) userDays = await getUserDaysRange({ waId, start, end });
        else userDays = await getUserLastNDays(waId, days);
        const userMonths = await getUserLastNMonths(waId, months);
        user = { waId, days: userDays, months: userMonths };
      }

      return res.json({
        ok: true,
        params: { waId: waId || undefined, days, months, start: start || undefined, end: end || undefined },
        global: { days: globalDays, months: globalMonths },
        user,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

router.get("/dashboard", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 1100px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    .muted { color: #666; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    input, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid #ddd; }
    button { cursor: pointer; background: white; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); }
    @media (max-width: 950px) { .grid { grid-template-columns: 1fr; } }
    .kpi { border: 1px solid #eee; border-radius: 12px; padding: 12px; }
    .kpi h3 { margin: 0 0 6px 0; font-size: 14px; color:#555; font-weight: 600; }
    .kpi .v { font-size: 28px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid #eee; padding: 8px 6px; text-align: left; }
    code { background:#f6f6f6; padding:2px 6px; border-radius: 6px; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    .pill { display:inline-block; padding: 4px 10px; border: 1px solid #eee; border-radius: 999px; margin: 4px 6px 0 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📊 Dashboard</h2>
    <p><a href="/admin">⬅ Voltar</a></p>

    <div class="row" style="margin: 10px 0 14px 0;">
      <input id="waId" placeholder="waId (opcional) para métricas individuais" style="min-width: 360px;" />
      <button onclick="load()">Atualizar</button>
    </div>
    <div class="row" style="margin: 0 0 14px 0;">
      <input id="days" type="number" min="1" max="365" value="30" style="width:120px;" />
      <span class="muted">dias</span>
      <input id="months" type="number" min="1" max="36" value="12" style="width:120px;" />
      <span class="muted">meses</span>
      <span class="muted" style="margin-left:8px;">ou intervalo:</span>
      <input id="start" type="date" />
      <input id="end" type="date" />
      <button onclick="applyRange()">Aplicar intervalo</button>
      <button onclick="resetRange()">Reset 30d/12m</button>
      <span class="muted">Histórico global + opcional por usuário (se informar waId).</span>
    </div>


    <div class="grid">
      <div class="kpi">
        <h3>Descrições hoje (global)</h3>
        <div class="v" id="kpiDay">—</div>
        <div class="muted" id="kpiDayLabel"></div>
      </div>
      <div class="kpi">
        <h3>Descrições no mês (global)</h3>
        <div class="v" id="kpiMonth">—</div>
        <div class="muted" id="kpiMonthLabel"></div>
      </div>
      <div class="kpi">
        <h3>Usuários na janela 24h</h3>
        <div class="v" id="kpi24h">—</div>
        <div class="muted">últimas 24 horas (inbound)</div>
      </div>
    </div>

    <h3 style="margin-top:18px;">Usuários</h3>
    <p class="muted">Totais e distribuição por status / plano (best-effort).</p>

    <div class="row">
      <div class="pill">Total: <b id="uTotal">—</b></div>
      <div class="pill">TRIAL: <b id="uTrial">—</b></div>
      <div class="pill">ACTIVE: <b id="uActive">—</b></div>
      <div class="pill">WAIT_PLAN: <b id="uWait">—</b></div>
      <div class="pill">PAYMENT_PENDING: <b id="uPayPend">—</b></div>
      <div class="pill">BLOCKED: <b id="uBlocked">—</b></div>
      <div class="pill">UNKNOWN: <b id="uUnknown">—</b></div>
    </div>

    <div id="usersError" class="muted" style="margin-top:8px;"></div>

    <h3 style="margin-top:18px;">Planos (contagem)</h3>
    <div id="plans"></div>

    <h3 style="margin-top:18px;">Métricas por usuário (opcional)</h3>
    <div id="userBox" class="muted">Informe um waId acima para ver métricas individuais.</div>

    <h3 style="margin-top:18px;">Histórico (Global)</h3>
    <p class="muted">Série diária (dias / intervalo) e série mensal (últimos meses). Use o seletor acima para ajustar.</p>

    <div class="grid" style="grid-template-columns: 1fr 1fr;">
      <div class="kpi">
        <h3>Série diária (Global)</h3>
        <canvas id="chartDays" width="520" height="220" style="width:100%; border:1px solid #eee; border-radius:12px;"></canvas>
        <div class="muted" id="daysLabel" style="margin-top:6px;"></div>
        <div id="daysTable"></div>
      </div>
      <div class="kpi">
        <h3>Série mensal (Global)</h3>
        <canvas id="chartMonths" width="520" height="220" style="width:100%; border:1px solid #eee; border-radius:12px;"></canvas>
        <div class="muted" id="monthsLabel" style="margin-top:6px;"></div>
        <div id="monthsTable"></div>
      </div>
    </div>

    <h3 style="margin-top:18px;">Histórico (Usuário — opcional)</h3>
    <p class="muted">Informe um <code>waId</code> no topo para ver a série diária/mensal daquele usuário.</p>
    <div class="grid" style="grid-template-columns: 1fr 1fr;">
      <div class="kpi">
        <h3>Série diária (Usuário)</h3>
        <canvas id="chartUserDays" width="520" height="220" style="width:100%; border:1px solid #eee; border-radius:12px;"></canvas>
        <div class="muted" id="userDaysLabel" style="margin-top:6px;"></div>
        <div id="userDaysTable"></div>
      </div>
      <div class="kpi">
        <h3>Série mensal (Usuário)</h3>
        <canvas id="chartUserMonths" width="520" height="220" style="width:100%; border:1px solid #eee; border-radius:12px;"></canvas>
        <div class="muted" id="userMonthsLabel" style="margin-top:6px;"></div>
        <div id="userMonthsTable"></div>
      </div>
    </div>

    <hr style="margin-top:18px;"/>
    <details>
      <summary class="muted">Ver JSON bruto</summary>
      <pre id="raw"></pre>
    </details>
  </div>

<script>
function esc(s){
  return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}


function qs(){
  const waId = (document.getElementById('waId').value || '').trim();
  const days = (document.getElementById('days').value || '30').trim();
  const months = (document.getElementById('months').value || '12').trim();
  const start = (document.getElementById('start').value || '').trim();
  const end = (document.getElementById('end').value || '').trim();
  const p = new URLSearchParams();
  if(waId) p.set('waId', waId);
  if(start && end){ p.set('start', start); p.set('end', end); }
  else { p.set('days', days); }
  p.set('months', months);
  return p.toString();
}

function resetRange(){
  document.getElementById('days').value = 30;
  document.getElementById('months').value = 12;
  document.getElementById('start').value = '';
  document.getElementById('end').value = '';
  load();
}

function applyRange(){
  // se start/end preenchidos, o backend usa intervalo; se não, usa days
  load();
}

function drawLine(canvasId, points, labelKey){
  const c = document.getElementById(canvasId);
  if(!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h);

  if(!points || !points.length){
    ctx.fillText('Sem dados', 10, 20);
    return;
  }

  const vals = points.map(p => Number(p.count||0));
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);

  // padding
  const padL = 36, padR = 10, padT = 10, padB = 24;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  // axes
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + ih);
  ctx.lineTo(padL + iw, padT + ih);
  ctx.stroke();

  // line
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = padL + (iw * (i / Math.max(1, points.length - 1)));
    const v = Number(p.count||0);
    const y = padT + ih - (ih * ((v - min) / (max - min || 1)));
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // labels (first/last)
  ctx.fillText(String(points[0][labelKey] || ''), padL, h - 8);
  const last = points[points.length-1];
  const lastLabel = String(last[labelKey] || '');
  const tw = ctx.measureText(lastLabel).width;
  ctx.fillText(lastLabel, w - padR - tw, h - 8);

  // max value
  ctx.fillText(String(max), 6, 16);
}

function renderMiniTable(containerId, points, labelKey){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!points || !points.length){ el.innerHTML = '<span class="muted">Sem dados.</span>'; return; }
  const last = points.slice(-10);
  const rows = last.map(p => '<tr><td><code>'+esc(p[labelKey])+'</code></td><td><b>'+esc(p.count)+'</b></td></tr>').join('');
  el.innerHTML = '<table><thead><tr><th>Período</th><th>Qtd</th></tr></thead><tbody>'+rows+'</tbody></table><div class="muted">Mostrando últimos 10 pontos.</div>';
}

async function loadHistory(){
  const query = qs();
  const url = '/admin/dashboard/history?' + query;
  const r = await fetch(url);
  const j = await r.json().catch(()=>({}));

  const gd = j?.global?.days;
  const gm = j?.global?.months;

  const gdPts = gd?.points || [];
  const gmPts = gm?.points || [];

  document.getElementById('daysLabel').textContent = gd?.ok ? ('Período: ' + gd.start + ' → ' + gd.end) : ('⚠️ ' + (gd?.error||''));
  document.getElementById('monthsLabel').textContent = gm?.ok ? ('Período: ' + gm.start + ' → ' + gm.end) : ('⚠️ ' + (gm?.error||''));

  drawLine('chartDays', gdPts, 'day');
  drawLine('chartMonths', gmPts, 'month');
  renderMiniTable('daysTable', gdPts, 'day');
  renderMiniTable('monthsTable', gmPts, 'month');

  const u = j?.user;
  const ud = u?.days;
  const um = u?.months;
  const udPts = ud?.points || [];
  const umPts = um?.points || [];
  document.getElementById('userDaysLabel').textContent = ud?.ok ? ('Período: ' + ud.start + ' → ' + ud.end) : '—';
  document.getElementById('userMonthsLabel').textContent = um?.ok ? ('Período: ' + um.start + ' → ' + um.end) : '—';

  drawLine('chartUserDays', udPts, 'day');
  drawLine('chartUserMonths', umPts, 'month');
  renderMiniTable('userDaysTable', udPts, 'day');
  renderMiniTable('userMonthsTable', umPts, 'month');
}


async function load(){ const waId = (document.getElementById('waId').value || '').trim();
  const url = waId ? '/admin/dashboard/data?waId=' + encodeURIComponent(waId) : '/admin/dashboard/data';
  const r = await fetch(url);
  const j = await r.json();
  document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

  const g = j.global || {};
  document.getElementById('kpiDay').textContent = g.dayCount ?? '0';
  document.getElementById('kpiDayLabel').textContent = g.day ? ('Dia: ' + g.day) : '';
  document.getElementById('kpiMonth').textContent = g.monthCount ?? '0';
  document.getElementById('kpiMonthLabel').textContent = g.month ? ('Mês: ' + g.month) : '';
  document.getElementById('kpi24h').textContent = j.window24hCount ?? '0';

  const u = (j.users || {});
  document.getElementById('uTotal').textContent = u.total ?? '0';
  const st = u.statuses || {};
  document.getElementById('uTrial').textContent = st.TRIAL ?? '0';
  document.getElementById('uActive').textContent = st.ACTIVE ?? '0';
  document.getElementById('uWait').textContent = st.WAIT_PLAN ?? '0';
  document.getElementById('uPayPend').textContent = st.PAYMENT_PENDING ?? '0';
  document.getElementById('uBlocked').textContent = st.BLOCKED ?? '0';
  document.getElementById('uUnknown').textContent = st.UNKNOWN ?? '0';

  const err = u.error ? ('⚠️ users:index: ' + u.error) : '';
  document.getElementById('usersError').textContent = err;

  const plans = u.plans || {};
  const sysPlans = Array.isArray(j.systemPlans) ? j.systemPlans : [];
  const byCode = {};
  for (const p of sysPlans) {
    const code = String(p?.code || '').toUpperCase().trim();
    if (code) byCode[code] = p;
  }

  function fmtBRL(cents){
    const v = (Number(cents)||0)/100;
    try { return v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); } catch { return 'R$ ' + v.toFixed(2); }
  }

  const planHtml = Object.keys(plans).sort().map(k => {
    const meta = byCode[String(k||'').toUpperCase().trim()];
    const label = meta ? (esc(meta.name || '') + ' · ' + fmtBRL(meta.priceCents) + ' · ' + esc(meta.description || (meta.monthlyQuota ? (meta.monthlyQuota + ' descrições/mês') : ''))) : '';
    const extra = label ? ('<div class="muted" style="font-size:12px;margin-top:2px;">' + label + '</div>') : '';
    return '<span class="pill"><code>'+esc(k)+'</code>: <b>'+plans[k]+'</b>' + extra + '</span>';
  }).join(' ');
  document.getElementById('plans').innerHTML = planHtml || '<span class="muted">Sem dados.</span>';

  const user = j.user;
  if (!user) {
    document.getElementById('userBox').innerHTML = '<span class="muted">Informe um waId acima para ver métricas individuais.</span>';
  } else {
    const sm = user.snapshot || {};
    const um = user.metrics || {};
    const box = \`
      <div class="kpi" style="margin-top:10px;">
        <h3>Usuário <code>\${esc(sm.waId || waId)}</code></h3>
        <div class="muted">status: <b>\${esc(sm.status || '—')}</b> · plano atual: <b>\${esc(sm.plan || '—')}</b></div>
        \${(() => {
          const sysPlans = Array.isArray(j.systemPlans) ? j.systemPlans : [];
          const code = String(sm.plan || '').toUpperCase().trim();
          const meta = sysPlans.find(p => String(p?.code || '').toUpperCase().trim() === code);
          if (!meta) return '';
          const price = (() => { const v=(Number(meta.priceCents)||0)/100; try { return v.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); } catch { return 'R$ '+v.toFixed(2);} })();
          const desc = meta.description || (meta.monthlyQuota ? (meta.monthlyQuota + ' descrições/mês') : '');
          return '<div class="muted" style="margin-top:6px;">Plano: <b>' + esc(meta.name || meta.code || '') + '</b> · ' + esc(price) + (desc ? (' · ' + esc(desc)) : '') + '</div>';
        })()}
        <div style="margin-top:10px;" class="row">
          <div class="pill">Descrições hoje: <b>\${um.dayCount ?? 0}</b></div>
          <div class="pill">Descrições mês: <b>\${um.monthCount ?? 0}</b></div>
          <div class="pill">quotaUsed: <b>\${esc(sm.quotaUsed ?? '—')}</b></div>
          <div class="pill">trialUsed: <b>\${esc(sm.trialUsed ?? '—')}</b></div>
        </div>
      </div>\`;
    document.getElementById('userBox').innerHTML = box;
  }
  await loadHistory();
}

load();
</script>
</body>
</html>`;
    res.type("html").send(html);
  });


  router.get("/", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    a { display: inline-block; margin: 6px 0; }
    .muted { color: #666; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    input, button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; }
    button { cursor: pointer; background: white; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Admin</h2>
    <p class="muted">Menu</p>

    <div class="grid">
      <div>
        <h3>Produto</h3>
        <a href="/admin/dashboard">📊 Dashboard</a><br/>
        <a href="/admin/plans">💳 Planos</a><br/>
        <a href="/admin/broadcast-ui">📣 Broadcast</a><br/>
        <a href="/admin/campaigns-ui">📦 Campanhas</a><br/>
        <a href="/admin/window24h-ui">🕒 Janela 24h</a><br/>
      </div>
      <div>
        <h3>Atalhos técnicos</h3>
        <a href="/health">✅ Health</a><br/>
        <a href="/health-redis">🧠 Health Redis</a><br/>
        <a href="/admin/health-plans">🧾 Health Planos</a><br/>
        <a href="/admin/alerts-ui">🚨 Alertas do Sistema <span id="alertsCount"></span></a><br/>
      </div>
    </div>

    <hr/>
    <h3>Usuário (teste rápido)</h3>
    <div class="row">
      <input id="waId" placeholder="waId (somente números) ex: 5511..." style="min-width:320px" />
      <button onclick="go('/admin/state-test/get')">Ver state</button>
      <button onclick="go('/admin/state-test/reset-trial')">Reset TRIAL</button>
      <button onclick="go('/admin/window24h/touch')">Touch 24h</button>
      <button onclick="go('/admin/send-test')">Enviar 'oi'</button>
    </div>
    <p class="muted">Dica: cole seu número sem + e sem espaços (ex.: 5511960765975).</p>

    <pre id="out"></pre>

    <hr/>
    <p class="muted">Observação: o Admin usa Basic Auth (senha = ADMIN_SECRET).</p>
  </div>

<script>
function getWaId(){
  return (document.getElementById('waId').value || '').trim();
}
async function go(path){
  const waId = getWaId();
  if(!waId){ alert('Informe o waId'); return; }
  const url = path + '?waId=' + encodeURIComponent(waId);
  const r = await fetch(url);
  const j = await r.json().catch(()=>({}));
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}

(async function loadAlertsCount(){
  try{
    const r = await fetch('/admin/alerts-count');
    const j = await r.json().catch(()=>({}));
    const n = Number(j.count||0);
    if(n>0){
      document.getElementById('alertsCount').textContent = ' ('+n+')';
    }
  }catch(e){}
})();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // Planos
  // -----------------------------
  router.get("/plans", async (req, res) => {
    const plans = await listPlans({ includeInactive: true });

    const rows = plans
      .map((p) => {
        const code = escapeHtml(p.code);
        const name = escapeHtml(p.name);
        const price = escapeHtml(String(p.priceCents / 100).replace(".", ","));
        const quota = escapeHtml(String(p.monthlyQuota));
        const active = p.active ? "✅" : "❌";
        return `<tr>
          <td><code>${code}</code></td>
          <td>${name}</td>
          <td>R$ ${price}</td>
          <td>${quota}</td>
          <td>${active}</td>
          <td>
            <button onclick="toggle('${code}', ${p.active ? "false" : "true"})">
              ${p.active ? "Desativar" : "Ativar"}
            </button>
          </td>
        </tr>`;
      })
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Planos</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    table { width:100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #eee; text-align:left; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    button, input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
    .muted { color:#666; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
  </style>
</head>
<body>
  <div class="card">
    <h2>💳 Planos</h2>
    <p><a href="/admin">⬅ Voltar</a></p>

    <div class="row">
      <input id="code" placeholder="code (ex: DE_VEZ_EM_QUANDO)" style="min-width:280px" />
      <input id="name" placeholder="name (ex: De Vez em Quando)" style="min-width:280px" />
      <input id="priceCents" placeholder="priceCents (ex: 2490)" />
      <input id="monthlyQuota" placeholder="monthlyQuota (ex: 20)" />
      <input id="description" placeholder="description (ex: 20 descrições/mês)" style="min-width:320px" />
      <button onclick="create()">Criar/Atualizar</button>
    </div>
    <p class="muted">Dica: priceCents em centavos (R$ 24,90 = 2490).</p>

    <hr/>
    <table>
      <thead>
        <tr>
          <th>Code</th><th>Nome</th><th>Preço</th><th>Cota</th><th>Ativo</th><th>Ação</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <pre id="msg"></pre>
  </div>

<script>
async function create(){
  const body = {
    code: (document.getElementById('code').value||'').trim(),
    name: (document.getElementById('name').value||'').trim(),
    priceCents: Number(document.getElementById('priceCents').value||0),
    monthlyQuota: Number(document.getElementById('monthlyQuota').value||0),
    description: (document.getElementById('description').value||'').trim(),
    active: true,
  };
  const r = await fetch('/admin/plans', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>({}));
  document.getElementById('msg').textContent = JSON.stringify(j, null, 2);
  if(j.ok) setTimeout(()=>location.reload(), 300);
}
async function toggle(code, active){
  const r = await fetch('/admin/plans/'+encodeURIComponent(code)+'/active', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active}) });
  const j = await r.json().catch(()=>({}));
  document.getElementById('msg').textContent = JSON.stringify(j, null, 2);
  if(j.ok) setTimeout(()=>location.reload(), 300);
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.post("/plans", async (req, res) => {
    try {
      const plan = await upsertPlan(req.body || {});
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post("/plans/:code/active", async (req, res) => {
    try {
      const active = Boolean(req.body?.active);
      const plan = await setPlanActive(req.params.code, active);
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // -----------------------------
  // ✅ Health Planos
  // -----------------------------
  router.get("/health-plans", async (req, res) => {
    const h = await getPlansHealth({ includeInactive: true });
    return res.json({ ok: true, health: h });
  });

  // -----------------------------
  // ✅ Alertas do Sistema (UI + APIs)
  // -----------------------------
  router.get("/alerts-count", async (req, res) => {
    const count = await getSystemAlertsCount();
    return res.json({ ok: true, count });
  });

  router.get("/alerts", async (req, res) => {
    const limit = Number(req.query?.limit || 50);
    const items = await listSystemAlerts(limit);
    return res.json({ ok: true, count: items.length, items });
  });

  router.get("/alerts-ui", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alertas</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    button, input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚨 Alertas do Sistema</h2>
    <p><a href="/admin">⬅ Voltar</a></p>
    <div class="row">
      <input id="limit" placeholder="limit (ex: 50)" value="50" />
      <button onclick="load()">Carregar</button>
    </div>
    <pre id="out"></pre>
  </div>
<script>
async function load(){
  const limit = (document.getElementById('limit').value||'50').trim();
  const r = await fetch('/admin/alerts?limit='+encodeURIComponent(limit));
  const j = await r.json().catch(()=>({}));
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}
load();
</script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // Janela 24h (UI já existente)
  // -----------------------------
  router.get("/window24h-ui", async (req, res) => {
    const count = await countWindow24hActive();
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Janela 24h</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    .muted { color:#666; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🕒 Janela 24h</h2>
    <div class="muted">Usuários dentro da janela de 24 horas.</div>
    <p><a href="/admin">⬅ Voltar</a></p>
    <p><b>Ativos agora:</b> ${escapeHtml(String(count))}</p>
    <button onclick="load()">Carregar lista (JSON)</button>
    <pre id="out"></pre>
  </div>
<script>
async function load(){
  const r = await fetch("/admin/window24h");
  const j = await r.json();
  document.getElementById("out").textContent = JSON.stringify(j, null, 2);
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // ✅ Broadcast UI
  // -----------------------------
  router.get("/broadcast-ui", async (req, res) => {
    const plans = await listPlans({ includeInactive: false });

    const options =
      `<option value="">(Todos os planos)</option>` +
      plans
        .map((p) => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)} (${escapeHtml(p.code)})</option>`)
        .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Broadcast</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    input, textarea, select, button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; }
    textarea { width: 100%; min-height: 140px; }
    button { cursor:pointer; background:white; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    .muted { color:#666; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📣 Broadcast</h2>
    <p><a href="/admin">⬅ Voltar</a> | <a href="/admin/campaigns-ui">📦 Ver campanhas</a></p>

    <div class="row">
      <label>Plano alvo:</label>
      <select id="plan">${options}</select>
      <span class="muted">Envio imediato só para quem está na janela 24h. Fora da janela fica pendente e envia automaticamente quando entrar.</span>
    </div>

    <p>
      <input id="subject" placeholder="Assunto (interno)" style="width:100%" />
    </p>
    <p>
      <textarea id="text" placeholder="Texto do broadcast (WhatsApp)"></textarea>
    </p>

    <div class="row">
      <button onclick="send()">Enviar campanha</button>
    </div>

    <pre id="out"></pre>
  </div>

<script>
async function send(){
  const plan = (document.getElementById('plan').value||'').trim();
  const subject = (document.getElementById('subject').value||'').trim();
  const text = (document.getElementById('text').value||'').trim();

  const body = { subject, text };
  if(plan) body.planTargets = [plan];

  const r = await fetch('/admin/campaigns', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(()=>({}));
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // ✅ Campanhas (UI + APIs)
  // -----------------------------
  router.get("/campaigns-ui", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Campanhas</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    button, input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📦 Campanhas</h2>
    <p><a href="/admin">⬅ Voltar</a> | <a href="/admin/broadcast-ui">📣 Nova campanha</a></p>

    <div class="row">
      <input id="limit" placeholder="limit (ex: 30)" value="30" />
      <button onclick="load()">Carregar</button>
    </div>

    <pre id="out"></pre>
  </div>

<script>
async function load(){
  const limit = (document.getElementById('limit').value||'30').trim();
  const r = await fetch('/admin/campaigns?limit='+encodeURIComponent(limit));
  const j = await r.json().catch(()=>({}));
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}
load();
</script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/campaigns", async (req, res) => {
    const limit = Number(req.query?.limit || 30);
    const data = await listCampaigns(limit);
    return res.json(data);
  });

  router.get("/campaigns/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const data = await getCampaign(id);
    return res.json(data);
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const subject = String(req.body?.subject || "").trim();
      const text = String(req.body?.text || "").trim();
      const planTargets = req.body?.planTargets || null;

      const r = await createCampaignAndDispatch({
        subject,
        text,
        planTargets,
        mode: "TEXT",
      });

      return res.json(r);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // -----------------------------
  // Testes / State (mantidos)
  // -----------------------------
  router.get("/state-test/reset-trial", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await setUserStatus(waId, "TRIAL");
      await setUserPlan(waId, "");
      await setUserQuotaUsed(waId, 0);
      await setUserTrialUsed(waId, 0);

      // ✅ V16.4.6: Upstash REST não aceita SET com valor vazio de forma confiável
      await clearLastPrompt(waId);

      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, action: "reset-trial", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/state-test/set-lastprompt-empty", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await setLastPrompt(waId, "");
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, action: "set-lastprompt-empty", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/state-test/get", async (req, res) => {
    try {
      const waId = requireWaId(req);
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/window24h/touch", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await touch24hWindow(waId, nowMs());
      const ts = await getLastInboundTs(waId);
      return res.json({
        ok: true,
        action: "touch24hWindow",
        user: {
          waId,
          lastInboundAtMs: ts,
          windowEndsAtMs: ts ? ts + 24 * 60 * 60 * 1000 : null,
        },
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/window24h", async (req, res) => {
    const items = await listWindow24hActive({ limit: 500 });
    return res.json({ ok: true, nowMs: nowMs(), count: items.length, returned: items.length, items });
  });

  router.get("/send-test", async (req, res) => {
    try {
      const waId = requireWaId(req);
      const text = String(req.query.text || "oi");
      const meta = await sendWhatsAppText({ to: waId, text });
      return res.json({ ok: true, sentTo: waId, text, meta });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
