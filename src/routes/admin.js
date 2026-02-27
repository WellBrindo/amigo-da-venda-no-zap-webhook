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
  resetUserAsNew, // 🧹 reset total (número de teste)
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
  clear24hWindowForUser,
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
  resetUserDescriptionMetrics,
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

import {
  listCopyKeys,
  groupCatalog,
  getCopyResolved,
  getCopyRawGlobal,
  getCopyRawUser,
  setCopyGlobal,
  delCopyGlobal,
  setCopyUser,
  delCopyUser,
} from "../services/copy.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


// -----------------------------
// Concurrency-safe helper (evita tempestade de requests no Upstash em rotas do Admin)
// -----------------------------
async function mapLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  const n = arr.length;
  if (n === 0) return [];
  const lim = Math.max(1, Math.min(Number(limit) || 1, n));
  const out = new Array(n);
  let cursor = 0;

  const runners = Array.from({ length: lim }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= n) break;
      out[i] = await worker(arr[i], i);
    }
  });

  await Promise.all(runners);
  return out;
}

function layoutBase({ title, activePath = "/admin", content = "", headExtra = "", scriptExtra = "" }) {
  const menu = renderSidebar(activePath);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title || "Admin")}</title>
  <style>
    :root{
      --bg:#f5f7fb;
      --card:#fff;
      --text:#111827;
      --muted:#6b7280;
      --border:#e5e7eb;
      --shadow: 0 6px 18px rgba(17,24,39,.06);
      --radius: 14px;
      --sidebar:#0f172a;
      --sidebar2:#111c35;
      --accent:#2563eb;
    }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:var(--bg); color:var(--text); }
    a{ color:var(--accent); text-decoration:none; }
    a:hover{ text-decoration:underline; }
    .app{ display:flex; min-height:100vh; }
    .side{
      width: 280px; flex: 0 0 280px;
      background: linear-gradient(180deg, var(--sidebar), var(--sidebar2));
      color:#e5e7eb; padding:18px 14px; position:sticky; top:0; height:100vh; overflow:auto;
      border-right: 1px solid rgba(255,255,255,.06);
    }
    .brand{ display:flex; gap:10px; align-items:center; padding:10px 10px 14px 10px; }
    .logo{
      width:36px; height:36px; border-radius: 10px;
      background: rgba(37,99,235,.18);
      display:flex; align-items:center; justify-content:center; font-weight:800;
    }
    .brand h1{ font-size:14px; margin:0; letter-spacing:.2px; }
    .brand .sub{ font-size:12px; color: rgba(229,231,235,.72); margin-top:2px; }
    .nav{ margin-top: 6px; }
    details{ border-radius: 12px; }
    details + details{ margin-top: 10px; }
    summary{
      cursor:pointer; list-style:none;
      padding:10px 10px; border-radius: 12px;
      display:flex; align-items:center; justify-content:space-between;
      color:#e5e7eb; font-weight:700; font-size:13px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.08);
    }
    summary::-webkit-details-marker{ display:none; }
    .nav a.item{
      display:flex; gap:10px; align-items:center;
      padding:9px 10px; margin:6px 2px 0 2px;
      border-radius: 12px;
      color: rgba(229,231,235,.86);
      border: 1px solid transparent;
      text-decoration:none;
    }
    .nav a.item:hover{ background: rgba(255,255,255,.08); }
    .nav a.item.active{
      background: rgba(37,99,235,.18);
      border-color: rgba(37,99,235,.35);
      color:#fff;
    }
    .nav .hint{ font-size:12px; color: rgba(229,231,235,.65); padding: 8px 10px 0 10px; }
    .main{ flex:1; padding: 22px 22px 40px 22px; }
    .topbar{
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      max-width: 1180px; margin: 0 auto 16px auto;
    }
    .topbar h2{ margin:0; font-size:20px; letter-spacing:.2px; }
    .topbar .meta{ color:var(--muted); font-size:12px; }
    .wrap{ max-width: 1180px; margin: 0 auto; }
    .card{ background:var(--card); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .card.pad{ padding:16px; }
    .grid{ display:grid; gap:12px; }
    .grid.cols2{ grid-template-columns: 1fr 1fr; }
    .grid.cols3{ grid-template-columns: repeat(3, 1fr); }
    @media (max-width: 980px){ .side{ display:none; } .grid.cols2,.grid.cols3{ grid-template-columns:1fr; } .main{ padding:16px; } }
    .kpi{ padding:14px; border-radius: 14px; border: 1px solid var(--border); background: #fff; }
    .kpi .t{ font-size:12px; color:var(--muted); font-weight:700; }
    .kpi .v{ font-size:26px; font-weight:800; margin-top:6px; }
    .muted{ color:var(--muted); }
    input, select, textarea, button{
      font: inherit; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border);
      background:#fff;
    }
    textarea{ width:100%; min-height: 140px; }
    button{ cursor:pointer; background:#fff; }
    button.primary{ background: rgba(37,99,235,.10); border-color: rgba(37,99,235,.35); }
    button.danger{ background: rgba(239,68,68,.10); border-color: rgba(239,68,68,.35); }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    table{ width:100%; border-collapse: collapse; }
    th, td{ padding: 10px 8px; border-bottom: 1px solid var(--border); text-align:left; }
    code{ background:#f3f4f6; padding: 2px 6px; border-radius: 8px; }
    .pill{ display:inline-flex; gap:8px; align-items:center; padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background:#fff; }
    
    .badge{ display:inline-flex; align-items:center; justify-content:center; padding: 2px 8px; border-radius:999px; border:1px solid var(--border); background:#fff; font-size:12px; font-weight:800; letter-spacing:.3px; }
    .badge.ok{ background:rgba(16,185,129,.12); color:#065f46; border-color:rgba(16,185,129,.28); }
    .badge.info{ background:rgba(37,99,235,.12); color:#1d4ed8; border-color:rgba(37,99,235,.28); }
    .badge.warn{ background:rgba(245,158,11,.14); color:#92400e; border-color:rgba(245,158,11,.28); }
    .badge.danger{ background:rgba(239,68,68,.12); color:#991b1b; border-color:rgba(239,68,68,.28); }
    .badge.soft{ font-weight:700; letter-spacing:0; }
.hr{ height:1px; background: var(--border); margin:14px 0; }
  </style>
  ${headExtra || ""}
</head>
<body>
  <div class="app">
    <aside class="side">
      ${menu}
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h2>${escapeHtml(title || "Admin")}</h2>
          <div class="meta">Amigo das Vendas · Admin</div>
        </div>
        <div class="meta"><a href="/health" style="color:inherit">/health</a> · <a href="/health-redis" style="color:inherit">/health-redis</a></div>
      </div>
      <div class="wrap">
        ${content || ""}
      </div>
    </main>
  </div>
  ${scriptExtra || ""}
</body>
</html>`;
}

function renderSidebar(activePath){
  const ap = String(activePath||"");
  const usersOpen = ap.startsWith("/admin/users") || ap.startsWith("/admin/window24h");
  const item = (href, label, icon) => {
    const active = ap === href ? "active" : "";
    return `<a class="item ${active}" href="${href}"><span>${icon||"•"}</span><span>${escapeHtml(label)}</span></a>`;
  };

  // Cascata (details)
  return `
    <div class="brand">
      <div class="logo">AV</div>
      <div>
        <h1>Amigo das Vendas</h1>
        <div class="sub">Painel Admin</div>
      </div>
    </div>

    <nav class="nav">
      <div class="hint">Navegação</div>

      <details open>
        <summary>📊 Produto <span>▾</span></summary>
        ${item("/admin", "Início", "🏠")}
        ${item("/admin/dashboard", "Dashboard", "📈")}
        ${item("/admin/plans", "Planos", "💳")}
      </details>

      <details open>
        <summary>📣 Comunicação <span>▾</span></summary>
        ${item("/admin/broadcast-ui", "Broadcast", "📣")}
        ${item("/admin/campaigns-ui", "Campanhas", "📦")}
      </details>

      <details ${usersOpen ? "open" : ""}>
        <summary>👥 Usuários <span>▾</span></summary>
        ${item("/admin/users-list-ui", "Lista de usuários", "📋")}
        ${item("/admin/users-ui", "Ações / Consulta", "👤")}
        ${item("/admin/window24h-ui", "Janela 24h", "🕒")}
      </details>

      <details>
        <summary>⚙️ Sistema <span>▾</span></summary>
        ${item("/admin/alerts-ui", "Alertas", "🚨")}
        ${item("/admin/copy-ui", "Textos do Bot", "📝")}
        ${item("/asaas/test", "Asaas Test", "🧾")}
      </details>

      <div class="hint" style="margin-top:10px;">Dica: tudo é protegido por Basic Auth (ADMIN_SECRET).</div>
    </nav>
  `;
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
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">📊 Dashboard</h3>
            <div class="muted">Métricas globais, histórico (30d/12m) e opcional por usuário.</div>
          </div>
          <div class="muted">Dica: use <code>waId</code> para ver o individual.</div>
        </div>

        <div class="hr"></div>

        <div class="row">
          <input id="waId" placeholder="waId (opcional) ex: 5511..." style="min-width:320px" />
          <button class="primary" onclick="loadAll()">Atualizar</button>
        </div>

        <div class="row" style="margin-top:10px;">
          <input id="days" type="number" min="1" max="365" value="30" style="width:120px;" />
          <span class="muted">dias</span>
          <input id="months" type="number" min="1" max="36" value="12" style="width:120px;" />
          <span class="muted">meses</span>
          <span class="muted" style="margin-left:8px;">ou intervalo:</span>
          <input id="start" type="date" />
          <input id="end" type="date" />
          <button onclick="applyRange()">Aplicar</button>
          <button onclick="resetRange()">Reset</button>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div class="kpi">
            <div class="t">Descrições hoje (global)</div>
            <div class="v" id="kpiDay">—</div>
            <div class="muted" id="kpiDayLabel"></div>
          </div>
          <div class="kpi">
            <div class="t">Descrições no mês (global)</div>
            <div class="v" id="kpiMonth">—</div>
            <div class="muted" id="kpiMonthLabel"></div>
          </div>
          <div class="kpi">
            <div class="t">Usuários na janela 24h</div>
            <div class="v" id="kpi24h">—</div>
            <div class="muted">últimas 24 horas (inbound)</div>
          </div>
        </div>

        <div class="hr"></div>

        <h4 style="margin:0 0 6px 0;">Usuários</h4>
        <div class="row">
          <span class="pill">Total: <b id="uTotal">—</b></span>
          <span class="pill">TRIAL: <b id="uTrial">—</b></span>
          <span class="pill">ACTIVE: <b id="uActive">—</b></span>
          <span class="pill">WAIT_PLAN: <b id="uWait">—</b></span>
          <span class="pill">PAYMENT_PENDING: <b id="uPayPend">—</b></span>
          <span class="pill">BLOCKED: <b id="uBlocked">—</b></span>
          <span class="pill">UNKNOWN: <b id="uUnknown">—</b></span>
        </div>
        <div id="usersError" class="muted" style="margin-top:8px;"></div>

        <div class="hr"></div>

        <h4 style="margin:0 0 8px 0;">Planos (contagem)</h4>
        <div id="plans"></div>

        <div class="hr"></div>

        <div class="grid cols2">
          <div class="card pad">
            <div class="row" style="justify-content:space-between;">
              <h4 style="margin:0;">Série diária (Global)</h4>
              <div class="muted" id="daysLabel"></div>
            </div>
            <canvas id="chartDays" width="900" height="240" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
            <div id="daysTable"></div>
          </div>

          <div class="card pad">
            <div class="row" style="justify-content:space-between;">
              <h4 style="margin:0;">Série mensal (Global)</h4>
              <div class="muted" id="monthsLabel"></div>
            </div>
            <canvas id="chartMonths" width="900" height="240" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
            <div id="monthsTable"></div>
          </div>
        </div>

        <div class="hr"></div>

        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
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
          loadAll();
        }
        function applyRange(){ loadAll(); }

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

          const padL = 36, padR = 10, padT = 10, padB = 24;
          const iw = w - padL - padR;
          const ih = h - padT - padB;

          ctx.beginPath();
          ctx.moveTo(padL, padT);
          ctx.lineTo(padL, padT + ih);
          ctx.lineTo(padL + iw, padT + ih);
          ctx.strokeStyle = "#94a3b8";
          ctx.stroke();

          ctx.beginPath();
          points.forEach((p, i) => {
            const x = padL + (iw * (i / Math.max(1, points.length - 1)));
            const v = Number(p.count||0);
            const y = padT + ih - (ih * ((v - min) / (max - min || 1)));
            if(i===0) ctx.moveTo(x,y);
            else ctx.lineTo(x,y);
          });
          ctx.strokeStyle = "#2563eb";
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.fillStyle = "#64748b";
          ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
          ctx.fillText(String(points[0][labelKey] || ''), padL, h - 8);
          const last = points[points.length-1];
          const lastLabel = String(last[labelKey] || '');
          const tw = ctx.measureText(lastLabel).width;
          ctx.fillText(lastLabel, w - padR - tw, h - 8);
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
          const r = await fetch('/admin/dashboard/history?' + query);
          const j = await r.json().catch(()=>({}));
          const gd = j?.global?.days;
          const gm = j?.global?.months;

          const gdPts = gd?.points || [];
          const gmPts = gm?.points || [];

          document.getElementById('daysLabel').textContent = gd?.ok ? (gd.start + ' → ' + gd.end) : ('⚠️ ' + (gd?.error||''));
          document.getElementById('monthsLabel').textContent = gm?.ok ? (gm.start + ' → ' + gm.end) : ('⚠️ ' + (gm?.error||''));

          drawLine('chartDays', gdPts, 'day');
          drawLine('chartMonths', gmPts, 'month');
          renderMiniTable('daysTable', gdPts, 'day');
          renderMiniTable('monthsTable', gmPts, 'month');

          return j;
        }

        async function loadAll(){
          const waId = (document.getElementById('waId').value || '').trim();
          const url = waId ? '/admin/dashboard/data?waId=' + encodeURIComponent(waId) : '/admin/dashboard/data';
          const r = await fetch(url);
          const j = await r.json().catch(()=>({}));
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
          document.getElementById('usersError').textContent = u.error ? ('⚠️ users:index: ' + u.error) : '';

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

          const hist = await loadHistory();
          return { j, hist };
        }

        loadAll();
      </script>
    `;
    const html = layoutBase({ title: "Dashboard", activePath: "/admin/dashboard", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });
  /* NOTE: bloco duplicado/corrompido removido (mantido comentado para preservar histórico de linhas).

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
  */
router.get("/", async (req, res) => {
    const html = layoutBase({
      title: "Início",
      activePath: "/admin",
      content: `
        <div class="grid cols2">
          <div class="card pad">
            <h3 style="margin:0 0 6px 0;">Painel</h3>
            <div class="muted">Ações principais e atalhos organizados.</div>
            <div class="hr"></div>
            <div class="grid cols2">
              <a class="card pad" href="/admin/dashboard" style="display:block;">
                <div class="muted" style="font-weight:700;">📊 Dashboard</div>
                <div class="muted">Métricas globais, histórico e usuário.</div>
              </a>
              <a class="card pad" href="/admin/users-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">👥 Usuários</div>
                <div class="muted">Consulta e ações por waId.</div>
              </a>
              <a class="card pad" href="/admin/plans" style="display:block;">
                <div class="muted" style="font-weight:700;">💳 Planos</div>
                <div class="muted">Gerenciar catálogo e ativação.</div>
              </a>
              <a class="card pad" href="/admin/broadcast-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📣 Broadcast</div>
                <div class="muted">Criar envios por plano e janela.</div>
              </a>
            </div>
          </div>

          <div class="card pad">
            <h3 style="margin:0 0 6px 0;">Sistema</h3>
            <div class="muted">Saúde e diagnóstico rápido.</div>
            <div class="hr"></div>
            <div class="row">
              <a class="pill" href="/health">✅ Health</a>
              <a class="pill" href="/health-redis">🧠 Health Redis</a>
              <a class="pill" href="/admin/health-plans">🧾 Health Planos (JSON)</a>
              <a class="pill" href="/admin/alerts-ui">🚨 Alertas</a>
              <a class="pill" href="/asaas/test">🧾 Asaas Test</a>
            </div>
            <div class="hr"></div>
            <div class="muted">Observação: ações avançadas estão nas seções do menu.</div>
          </div>
        </div>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // 👥 Usuários — Lista (UI)
  // -----------------------------
  router.get("/users-list-ui", async (req, res) => {
    const html = layoutBase({
      title: "Usuários • Lista",
      activePath: "/admin/users-list-ui",
      content: `
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">Lista de usuários</h3>
              <div class="muted">Visualize rapidamente: Nome, waId, Plano e Janela 24h. Expanda para ver todos os dados salvos no fluxo.</div>
            </div>
            <div class="row">
              <button onclick="reloadUsers()">Recarregar</button>
            </div>
          </div>

          <div class="hr"></div>

          <div class="row" style="gap:10px; flex-wrap:wrap;">
            <input id="uSearch" placeholder="Buscar por nome ou waId..." style="min-width:320px" oninput="renderUsers()" />
            <input id="uLimit" type="number" min="1" max="500" value="200" style="width:110px" />
            <button class="primary" onclick="reloadUsers()">Carregar</button>
            <div class="muted" id="uMeta" style="margin-left:auto;"></div>
          </div>

          <div class="hr"></div>

          <div style="overflow:auto;">
            <table class="table" style="min-width:900px;">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>waId</th>
                  <th>Status</th>
                  <th>Plano</th>
                  <th>Janela 24h</th>
                  <th style="width:120px;">Ações</th>
                </tr>
              </thead>
              <tbody id="uTbody">
                <tr><td colspan="6" class="muted">Carregando...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <script>
          let _users = [];
          let _usersMeta = { total: 0, offset: 0, limit: 0 };

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(ts);
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function windowLabel(u){
            if (!u || !u.lastInboundTs) return "—";
            const exp = u.windowExpiresAt ? fmtTs(u.windowExpiresAt) : "—";
            return u.inWindow ? ("Ativa (até " + exp + ")") : ("Fora (expirou em " + exp + ")");
          }

          function escapeHtml(s){
            const v = String(s ?? "");
            return v
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          async function fetchJson(url, opt){
            const r = await fetch(url, opt);
            const j = await r.json().catch(()=>({}));
            return { r, j };
          }

          async function reloadUsers(){
            const limit = Number(document.getElementById("uLimit")?.value || 200);
            const url = "/admin/users/list?limit=" + encodeURIComponent(limit);

            // Feedback imediato
            const tbody = document.getElementById("uTbody");
            if (tbody) tbody.innerHTML = "<tr><td colspan=\"6\" class=\"muted\">Carregando...</td></tr>";
            const out = await fetchJson(url);
            const r = out.r, j = out.j;
            if (!r.ok || !j.ok) {
              document.getElementById("uTbody").innerHTML = "<tr><td colspan=\"6\" class=\"muted\">Erro ao carregar usuários.</td></tr>";
              return;
            }
            _users = j.items || [];
            _usersMeta = { total: j.total || 0, offset: j.offset || 0, limit: j.limit || limit };
            renderUsers();
          }

          function renderUsers(){
            const q = (document.getElementById("uSearch")?.value || "").trim().toLowerCase();
            const items = !_users?.length ? [] : _users.filter((u) => {
              if (!q) return true;
              return String(u.waId || "").includes(q) || String(u.fullName || "").toLowerCase().includes(q);
            });

            const metaEl = document.getElementById("uMeta");
            if (metaEl) metaEl.textContent = String(items.length) + " exibidos • Total: " + String(_usersMeta.total);

            if (!items.length){
              document.getElementById("uTbody").innerHTML = "<tr><td colspan=\"6\" class=\"muted\">Nenhum usuário encontrado.</td></tr>";
              return;
            }

            const rows = [];
            for (const u of items){
              const name = escapeHtml(u.fullName || "—");
              const wa = String(u.waId || "");
              const waHtml = escapeHtml(wa);
              const waJs = wa.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
              const st = escapeHtml(u.status || "");
              const pl = escapeHtml(u.plan || "");
              const win = escapeHtml(windowLabel(u));

              rows.push(
                "<tr>" +
                  "<td>" + name + "</td>" +
                  "<td><code>" + waHtml + "</code></td>" +
                  "<td>" + st + "</td>" +
                  "<td>" + (pl || "—") + "</td>" +
                  "<td>" + win + "</td>" +
                  "<td>" +
                    "<button onclick=\"expandUser(\'" + waJs + "\')\">Expandir</button> " +
                    "<button onclick=\"openActions(\'" + waJs + "\')\">Abrir</button>" +
                  "</td>" +
                "</tr>"
              );
              rows.push(
                "<tr id=\"exp_" + waHtml + "\" style=\"display:none;\">" +
                  "<td colspan=\"6\"><div class=\"muted\">Carregando...</div></td>" +
                "</tr>"
              );
            }

            document.getElementById("uTbody").innerHTML = rows.join("");
          }

          async function expandUser(wa){
            const row = document.getElementById("exp_" + String(wa));
            if (!row) return;

            if (row.style.display === "none"){
              row.style.display = "";
              row.querySelector("td").innerHTML = "<div class=\"muted\">Carregando...</div>";

              const url = "/admin/users/details?waId=" + encodeURIComponent(wa);
              const out = await fetchJson(url);
              const r = out.r, j = out.j;
              if (!r.ok || !j.ok) {
                row.querySelector("td").innerHTML = "<div class=\"muted\">Erro ao carregar detalhes.</div>";
                return;
              }

              const s = j.snapshot || {};
              const header = (
                "<div class=\"row\" style=\"justify-content:space-between; align-items:center;\">" +
                  "<div>" +
                    "<div><b>" + escapeHtml(s.fullName || "—") + "</b> <span class=\"muted\">(" + escapeHtml(wa) + ")</span></div>" +
                    "<div class=\"muted\">Status: <b>" + escapeHtml(s.status || "—") + "</b> • Plano: <b>" + escapeHtml(s.plan || "—") + "</b> • Janela 24h: <b>" + escapeHtml(j.inWindow ? "Ativa" : "Fora") + "</b></div>" +
                  "</div>" +
                  "<div class=\"row\">" +
                    "<button onclick=\"openActions(\'" + String(wa).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "\')\">Abrir nas ações</button> " +
                    "<button onclick=\"toggleRow(\'" + String(wa).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "\')\">Fechar</button>" +
                  "</div>" +
                "</div>"
              );

              const docLine = (s.doc && s.doc.docType) ? (s.doc.docType + " • " + (s.doc.docLast4 || "")) : "—";

              const details = (
                "<div class=\"hr\"></div>" +
                "<div class=\"grid cols2\">" +
                  "<div class=\"kpi\">" +
                    "<div class=\"t\">Dados pessoais</div>" +
                    "<div class=\"muted\">Nome: <b>" + escapeHtml(s.fullName || "—") + "</b></div>" +
                    "<div class=\"muted\">Documento: <b>" + escapeHtml(docLine) + "</b></div>" +
                    "<div class=\"muted\">Cidade/UF: <b>" + escapeHtml(s.billingCityState || "—") + "</b></div>" +
                    "<div class=\"muted\">Endereço: <b>" + escapeHtml(s.billingAddress || "—") + "</b></div>" +
                  "</div>" +
                  "<div class=\"kpi\">" +
                    "<div class=\"t\">Assinatura / Cobrança</div>" +
                    "<div class=\"muted\">Status: <b>" + escapeHtml(s.status || "—") + "</b></div>" +
                    "<div class=\"muted\">Plano: <b>" + escapeHtml(s.plan || "—") + "</b></div>" +
                    "<div class=\"muted\">Payment: <b>" + escapeHtml(s.paymentMethod || "—") + "</b></div>" +
                    "<div class=\"muted\">Asaas Customer: <code>" + escapeHtml(s.asaasCustomerId || "—") + "</code></div>" +
                    "<div class=\"muted\">Asaas Subscription: <code>" + escapeHtml(s.asaasSubscriptionId || "—") + "</code></div>" +
                  "</div>" +
                "</div>" +

                "<div class=\"hr\"></div>" +
                "<details>" +
                  "<summary class=\"muted\">Ver JSON completo (inclui perfil da empresa)</summary>" +
                  "<pre style=\"white-space:pre-wrap;\">" + escapeHtml(JSON.stringify(s, null, 2)) + "</pre>" +
                "</details>"
              );

              row.querySelector("td").innerHTML = header + details;
              return;
            }

            row.style.display = "none";
          }

          function toggleRow(wa){
            const row = document.getElementById("exp_" + String(wa));
            if (!row) return;
            row.style.display = "none";
          }

          function openActions(wa){
            window.location.href = "/admin/users-ui?waId=" + encodeURIComponent(wa);
          }

          // auto-load
          setTimeout(() => { reloadUsers().catch(()=>{}); }, 50);
        

          // Auto-load na primeira renderização
          (function initUsersList(){
            try { reloadUsers(); } catch (_) {}
          })();
</script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // 👥 Usuários — Ações/Consulta (UI)
  // -----------------------------
  router.get("/users-ui", async (req, res) => {
    const html = layoutBase({
      title: "Usuários • Ações",
      activePath: "/admin/users-ui",
      content: `
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">Ações por waId</h3>
              <div class="muted">Consulta e comandos operacionais, sem depender de URLs “soltas”.</div>
            </div>
            <div class="muted">Ex.: <code>5511960765975</code></div>
          </div>

          <div class="hr"></div>

          <div class="row">
            <input id="waId" placeholder="waId (somente números) ex: 5511..." style="min-width:320px" />
            <button class="primary" onclick="loadSnapshot()">Consultar</button>
            <button onclick="touchWindow()">Touch Janela 24h</button>
            <button onclick="sendTest()">Enviar 'oi'</button>
          </div>

          <div class="row" style="margin-top:10px;">
            <button class="danger" onclick="resetTrial()">Reset TRIAL</button>
            <button class="danger" onclick="resetUser()">Reset TOTAL (como novo)</button>
            <button onclick="setStatus('ACTIVE')">Forçar ACTIVE</button>
            <button onclick="setStatus('BLOCKED')">Forçar BLOCKED</button>
            <button onclick="clearPrompt()">Limpar lastPrompt</button>
          </div>

          <div class="hr"></div>
          <div class="grid cols2">
            <div class="kpi">
              <div class="t">Status</div>
              <div class="v" id="kStatus">—</div>
              <div class="muted" id="kPlan">Plano: —</div>
            </div>
            <div class="kpi">
              <div class="t">Uso</div>
              <div class="v" id="kUsage">—</div>
              <div class="muted" id="kUsage2">—</div>
            </div>
          </div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="out" style="white-space:pre-wrap;"></pre>
          </details>
        </div>

        <script>
          function waId(){
            return (document.getElementById('waId').value || '').trim();
          }
          async function fetchJson(url, opt){
            const r = await fetch(url, opt);
            const j = await r.json().catch(()=>({}));
            return { r, j };
          }
          function renderUser(j){
            const snap = j?.user || j?.userSnapshot || j?.user?.snapshot || j?.snapshot || {};
            document.getElementById('kStatus').textContent = snap.status || '—';
            document.getElementById('kPlan').textContent = 'Plano: ' + (snap.plan || '—');

            const quotaUsed = Number(snap.quotaUsed ?? 0);
            const trialUsed = Number(snap.trialUsed ?? 0);
            const quotaStr = (snap.status === 'TRIAL')
              ? (trialUsed + ' (trialUsed)')
              : (quotaUsed + ' (quotaUsed)');

            document.getElementById('kUsage').textContent = quotaStr;
            document.getElementById('kUsage2').textContent = 'templatePrompted: ' + String(snap.templatePrompted ?? '—');

            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function loadSnapshot(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {r,j} = await fetchJson('/admin/users/snapshot?waId=' + encodeURIComponent(id));
            if(!r.ok || !j.ok){ alert('Falha ao consultar.'); document.getElementById('out').textContent = JSON.stringify(j, null, 2); return; }
            renderUser(j);
          }

          async function touchWindow(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/window24h/touch?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function resetTrial(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            if(!confirm('Resetar TRIAL (status TRIAL, plan vazio, quotaUsed/trialUsed = 0, limpa lastPrompt)?')) return;
            const {j} = await fetchJson('/admin/state-test/reset-trial?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function resetUser(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            if(!confirm('RESET TOTAL: remove estado, métricas, janela 24h e overrides de copy. Confirmar?')) return;
            const {j} = await fetchJson('/admin/state-test/reset-user?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function sendTest(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/send-test?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function setStatus(st){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/users/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ waId:id, status:st }) });
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function clearPrompt(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/users/clear-lastprompt?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          // Carrega snapshot se waId vier na query string (opcional)
          (function init(){
            const p = new URLSearchParams(location.search);
            const id = (p.get('waId')||'').trim();
            if(id){ document.getElementById('waId').value = id; loadSnapshot(); }
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // APIs de usuário (para UI clean, sem depender de múltiplas URLs)
    router.get("/users/list", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200)));
      const offset = Math.max(0, Number(req.query?.offset || 0));

      const idsRaw = await listUsers();
      const ids = Array.isArray(idsRaw) ? idsRaw.slice() : [];
      ids.sort(); // ordenação simples por waId

      const slice = ids.slice(offset, offset + limit);

      const now = nowMs();

      const items = await mapLimit(
        slice,
        20,
        async (waId) => {
          const [snap, lastInboundTsRaw] = await Promise.all([
            getUserSnapshot(waId),
            getLastInboundTs(waId),
          ]);

          const lastInboundTs = Number(lastInboundTsRaw) || 0;
          const inWindow = lastInboundTs ? now - lastInboundTs < 24 * 60 * 60 * 1000 : false;
          const windowExpiresAt = lastInboundTs ? lastInboundTs + 24 * 60 * 60 * 1000 : 0;

          return {
            waId,
            fullName: snap.fullName || "",
            plan: snap.plan || "",
            status: snap.status || "",
            inWindow,
            lastInboundTs,
            windowExpiresAt,
          };
        }
      );

      return res.status(200).json({
        ok: true,
        total: ids.length,
        offset,
        limit,
        items,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/users/details", async (req, res) => {
    try {
      const waId = String(req.query?.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "waId required" });

      const snap = await getUserSnapshot(waId);
      const now = nowMs();
      const lastInboundTs = await getLastInboundTs(waId);
      const inWindow = lastInboundTs ? now - Number(lastInboundTs) < 24 * 60 * 60 * 1000 : false;
      const windowExpiresAt = lastInboundTs ? Number(lastInboundTs) + 24 * 60 * 60 * 1000 : 0;

      return res.status(200).json({
        ok: true,
        waId,
        inWindow,
        lastInboundTs: Number(lastInboundTs) || 0,
        windowExpiresAt,
        snapshot: snap,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

router.post("/users/status", async (req, res) => {
    try {
      const waId = String(req.body?.waId || "").trim();
      const status = String(req.body?.status || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "waId required" });
      if (!status) return res.status(400).json({ ok: false, error: "status required" });
      await setUserStatus(waId, status);
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, waId, status, user });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/users/clear-lastprompt", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await clearLastPrompt(waId);
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, waId, action: "clearLastPrompt", user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
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
        const price = escapeHtml(String((p.priceCents || 0) / 100).replace(".", ","));
        const quota = escapeHtml(String(p.monthlyQuota ?? ""));
        const refin = escapeHtml(String(p.maxRefinements ?? ""));
        const desc = escapeHtml(String(p.description ?? ""));
        const active = p.active ? "✅" : "❌";
        return `<tr data-code="${code}" data-name="${name}" data-pricecents="${escapeHtml(String(p.priceCents || 0))}" data-monthlyquota="${quota}" data-maxrefinements="${refin}" data-description="${desc}">
          <td><code>${code}</code></td>
          <td>${name}</td>
          <td>R$ ${price}</td>
          <td>${quota}</td>
          <td>${refin}</td>
          <td>${active}</td>
          <td style="max-width:420px;">${desc}</td>
          <td>
            <button onclick="editRow(this)">Editar</button>
            <button onclick="toggle('${code}', ${p.active ? "false" : "true"})">
              ${p.active ? "Desativar" : "Ativar"}
            </button>
          </td>
        </tr>`;
      })
      .join("");

    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">💳 Planos</h3>
            <div class="muted">Catálogo do sistema (ativos e inativos).</div>
          </div>
          <div class="muted">priceCents em centavos · R$ 24,90 = 2490</div>
        </div>

        <div class="hr"></div>

        <div class="row">
          <input id="code" placeholder="code (ex: DE_VEZ_EM_QUANDO)" style="min-width:260px" />
          <input id="name" placeholder="name (ex: De Vez em Quando)" style="min-width:260px" />
          <input id="priceCents" placeholder="priceCents (ex: 2490)" style="width:170px" />
          <input id="monthlyQuota" placeholder="monthlyQuota (ex: 20)" style="width:190px" />
          <input id="maxRefinements" placeholder="maxRefinements (ex: 2)" style="width:220px" />
          <input id="description" placeholder="description (ex: 20 descrições/mês)" style="min-width:260px" />
          <button class="primary" onclick="create()">Criar/Atualizar</button>
        </div>

        <div class="hr"></div>

        <table>
          <thead>
            <tr>
              <th>Code</th><th>Nome</th><th>Preço</th><th>Cota</th><th>Ref.</th><th>Ativo</th><th>Descrição</th><th>Ação</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver resposta</summary>
          <pre id="msg" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        async function create(){
          const body = {
            code: (document.getElementById('code').value||'').trim(),
            name: (document.getElementById('name').value||'').trim(),
            priceCents: Number((document.getElementById('priceCents').value||'0').trim()),
            monthlyQuota: Number((document.getElementById('monthlyQuota').value||'0').trim()),
            maxRefinements: Number((document.getElementById('maxRefinements').value||'0').trim()),
            description: (document.getElementById('description').value||'').trim(),
            active: true,
          };
          const r = await fetch('/admin/plans', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          const j = await r.json().catch(()=>({}));
          document.getElementById('msg').textContent = JSON.stringify(j, null, 2);
          if(j.ok) setTimeout(()=>location.reload(), 250);
        }
        
        function editRow(btn){
          try{
            const tr = btn.closest('tr');
            if(!tr) return;
            document.getElementById('code').value = tr.getAttribute('data-code') || '';
            document.getElementById('name').value = tr.getAttribute('data-name') || '';
            document.getElementById('priceCents').value = tr.getAttribute('data-pricecents') || '';
            document.getElementById('monthlyQuota').value = tr.getAttribute('data-monthlyquota') || '';
            document.getElementById('maxRefinements').value = tr.getAttribute('data-maxrefinements') || '';
            document.getElementById('description').value = tr.getAttribute('data-description') || '';
            const msg = document.getElementById('msg');
            if(msg) msg.textContent = 'Editando: ' + (tr.getAttribute('data-code')||'');
          }catch(e){
            console.error(e);
          }
        }

async function toggle(code, active){
          const r = await fetch('/admin/plans/'+encodeURIComponent(code)+'/active', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active}) });
          const j = await r.json().catch(()=>({}));
          document.getElementById('msg').textContent = JSON.stringify(j, null, 2);
          if(j.ok) setTimeout(()=>location.reload(), 250);
        }
      </script>
    `;

    const html = layoutBase({ title: "Planos", activePath: "/admin/plans", content: inner });
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
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🚨 Alertas</h3>
            <div class="muted">Registro de avisos do sistema (para detectar falhas cedo).</div>
          </div>
          <button class="primary" onclick="load()">Atualizar</button>
        </div>

        <div class="hr"></div>

        <div id="out" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        async function load(){
          const r = await fetch('/admin/alerts');
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

          const items = Array.isArray(j.items) ? j.items : [];
          if(!items.length){
            document.getElementById('out').innerHTML = '<div class="muted">Nenhum alerta registrado.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Quando</th><th>Nível</th><th>Evento</th><th>Detalhes</th></tr></thead><tbody>' +
            items.map(it => {
              return '<tr>' +
                '<td><code>'+esc(it.ts||'')+'</code></td>' +
                '<td>'+esc(it.level||'')+'</td>' +
                '<td>'+esc(it.event||'')+'</td>' +
                '<td style="max-width:640px; white-space:pre-wrap;">'+esc(it.message||'')+'</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('out').innerHTML = html;
        }
        load();
      </script>
    `;
    const html = layoutBase({ title: "Alertas", activePath: "/admin/alerts-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // ===================== Textos do Bot (Copy) =====================
  // ✅ V16.6.0 — Editor de mensagens (global + por usuário)
  router.get("/copy-ui", async (req, res) => {
    const waId = String(req.query?.waId || "").trim();
    const groups = groupCatalog();

    // Pré-carrega valores (evita várias requisições na UI)
    const catalogFlat = Object.values(groups).flat();
    const rows = await Promise.all(
      catalogFlat.map(async (row) => {
        const key = row.key;
        const resolved = await getCopyResolved(key, { waId: waId || null });
        const rawGlobal = await getCopyRawGlobal(key);
        const rawUser = waId ? await getCopyRawUser(waId, key) : null;

        const defaultText = (resolved.source === "DEFAULT") ? resolved.text : (await getCopyResolved(key, { waId: null })).text;

        return {
          category: row.category,
          key,
          label: row.label || key,
          resolvedText: resolved.text,
          resolvedSource: resolved.source,
          globalText: rawGlobal !== null && rawGlobal !== undefined && String(rawGlobal) !== "" ? String(rawGlobal) : defaultText,
          hasGlobalOverride: rawGlobal !== null && rawGlobal !== undefined && String(rawGlobal) !== "",
          userText: waId ? (rawUser !== null && rawUser !== undefined && String(rawUser) !== "" ? String(rawUser) : "") : "",
          hasUserOverride: waId ? (rawUser !== null && rawUser !== undefined && String(rawUser) !== "") : false,
        };
      })
    );

    // Monta HTML por categoria
    const byCat = {};
    for (const r of rows) {
      if (!byCat[r.category]) byCat[r.category] = [];
      byCat[r.category].push(r);
    }

    const inner = `
      <div class="row" style="justify-content:space-between; align-items:flex-end; gap:16px;">
        <div style="min-width:320px;">
          <h2 style="margin:0 0 6px 0;">📝 Textos do Bot</h2>
          <div class="muted">Edite mensagens padrão sem mexer no código. Override global e por usuário (opcional).</div>
        </div>

        <form method="GET" action="/admin/copy-ui" class="row" style="gap:8px; align-items:flex-end; margin:0; flex-wrap:wrap; justify-content:flex-end;">
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:6px;">waId (opcional)</div>
            <input name="waId" value="${escapeHtml(waId)}" placeholder="5511..." style="min-width:220px;" />
          </div>
          <button class="primary" type="submit">Carregar</button>
          <a class="btn" href="/admin/copy-ui">Limpar</a>
        </form>
      </div>

      <div class="hr"></div>

      <div class="row" style="gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div style="flex:1; min-width:260px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Buscar (key ou título)</div>
          <input id="copySearch" placeholder="Ex.: FLOW_ASK_NAME, OpenAI, pagamento..." style="width:100%;" />
        </div>

        <div style="min-width:220px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Categoria</div>
          <select id="copyCategory" style="width:100%;">
            <option value="">Todas</option>
            ${Object.keys(byCat).map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
        </div>

        <div class="pill" style="margin-left:auto;">
          <span class="muted">Visíveis:</span>
          <strong id="copyVisibleCount">0</strong>
        </div>
      </div>

      <div class="hr"></div>

      <div class="grid" style="grid-template-columns:1fr;">
        ${Object.entries(byCat).map(([cat, items]) => {
          return `
            <div class="card pad copy-cat" data-copy-category="${escapeHtml(cat)}">
              <div class="row" style="justify-content:space-between;">
                <div>
                  <h3 style="margin:0 0 4px 0;">${escapeHtml(cat)}</h3>
                  <div class="muted">Chaves: ${items.length}</div>
                </div>
              </div>
              <div class="hr"></div>
              ${items.map((it) => {
                const badge = it.resolvedSource === "USER"
                  ? "<span class=\"badge\" style=\"background:rgba(16,185,129,.15); color:#065f46; border-color:rgba(16,185,129,.35)\">USER</span>"
                  : it.resolvedSource === "GLOBAL"
                    ? "<span class=\"badge\" style=\"background:rgba(37,99,235,.15); color:#1d4ed8; border-color:rgba(37,99,235,.35)\">GLOBAL</span>"
                    : it.resolvedSource === "DEFAULT"
                      ? "<span class=\"badge\">DEFAULT</span>"
                      : "<span class=\"badge\" style=\"background:rgba(239,68,68,.12); color:#991b1b; border-color:rgba(239,68,68,.28)\">MISSING</span>";

                return `
                  <div class="copy-item" data-copy-category="${escapeHtml(it.category)}" data-copy-key="${escapeHtml(it.key)}" data-copy-label="${escapeHtml(it.label)}" data-copy-source="${escapeHtml(it.resolvedSource)}" style="margin-bottom:18px;">
                    <div class="row" style="justify-content:space-between; align-items:center;">
                      <div>
                        <div style="font-weight:800;">${escapeHtml(it.label)} <span class="muted" style="font-weight:700;">(${escapeHtml(it.key)})</span></div>
                        <div class="muted" style="margin-top:2px;">Em uso: ${badge}</div>
                      </div>
                    </div>

                    <div class="row" style="gap:16px; align-items:flex-start; margin-top:10px;">
                      <div style="flex:1;">
                        <div class="muted" style="font-size:12px; margin-bottom:6px;">Global (edite e salve)</div>
                        <form method="POST" action="/admin/copy/set-global" style="margin:0;">
                          <input type="hidden" name="key" value="${escapeHtml(it.key)}" />
                          <textarea name="value" style="min-height:120px;">${escapeHtml(it.globalText)}</textarea>
                          <div class="row" style="justify-content:space-between; margin-top:8px;">
                            <div class="muted" style="font-size:12px;">
                              ${it.hasGlobalOverride ? "Override global ativo." : "Usando default (sem override)."}
                            </div>
                            <div class="row" style="gap:8px;">
                              <button class="primary" type="submit">Salvar Global</button>
                              <button class="btn" type="submit" formaction="/admin/copy/del-global">Resetar Global</button>
                            </div>
                          </div>
                        </form>
                      </div>

                      ${waId ? `
                        <div style="flex:1;">
                          <div class="muted" style="font-size:12px; margin-bottom:6px;">Usuário (${escapeHtml(waId)})</div>
                          <form method="POST" action="/admin/copy/set-user" style="margin:0;">
                            <input type="hidden" name="key" value="${escapeHtml(it.key)}" />
                            <input type="hidden" name="waId" value="${escapeHtml(waId)}" />
                            <textarea name="value" style="min-height:120px;" placeholder="(opcional) override só para este usuário…">${escapeHtml(it.userText)}</textarea>
                            <div class="row" style="justify-content:space-between; margin-top:8px;">
                              <div class="muted" style="font-size:12px;">
                                ${it.hasUserOverride ? "Override USER ativo." : "Sem override por usuário."}
                              </div>
                              <div class="row" style="gap:8px;">
                                <button class="primary" type="submit">Salvar Usuário</button>
                                <button class="btn" type="submit" formaction="/admin/copy/del-user">Resetar Usuário</button>
                              </div>
                            </div>
                          </form>
                        </div>
                      ` : ""}
                    </div>

                    <details style="margin-top:10px;">
                      <summary class="muted">Ver texto resolvido (o que o usuário recebe)</summary>
                      <pre style="white-space:pre-wrap; margin-top:10px;">${escapeHtml(it.resolvedText)}</pre>
                      <div class="muted" style="font-size:12px; margin-top:6px;">
                        Dica: você pode usar variáveis como {{planName}}, {{planPrice}} em textos dinâmicos.
                      </div>
                    </details>

                    <div class="hr"></div>
                  </div>
                `;
              }).join("")}
            </div>
          `;
        }).join("")}
      </div>


      <script>
        (function(){
          const searchEl = document.getElementById('copySearch');
          const catEl = document.getElementById('copyCategory');
          const countEl = document.getElementById('copyVisibleCount');

          function norm(v){ return String(v || '').toLowerCase().trim(); }

          function apply(){
            const q = norm(searchEl ? searchEl.value : '');
            const cat = String(catEl ? catEl.value : '').trim();

            let visible = 0;

            const catCards = Array.from(document.querySelectorAll('.copy-cat'));
            for (const card of catCards){
              const cardCat = card.getAttribute('data-copy-category') || '';
              const showCat = !cat || cardCat === cat;

              let anyItemVisible = false;
              const items = Array.from(card.querySelectorAll('.copy-item'));
              for (const it of items){
                const k = norm(it.getAttribute('data-copy-key'));
                const l = norm(it.getAttribute('data-copy-label'));
                const matchQ = !q || k.includes(q) || l.includes(q);

                const show = showCat && matchQ;
                it.style.display = show ? '' : 'none';
                if (show){ anyItemVisible = true; visible++; }
              }

              card.style.display = (showCat && anyItemVisible) ? '' : 'none';
            }

            if (countEl) countEl.textContent = String(visible);
          }

          if (searchEl) searchEl.addEventListener('input', apply);
          if (catEl) catEl.addEventListener('change', apply);

          // tecla "/" foca busca
          document.addEventListener('keydown', (e) => {
            if (e.key === '/' && searchEl && document.activeElement !== searchEl) {
              e.preventDefault();
              searchEl.focus();
            }
          });

          apply();
        })();
      </script>

    `;

    const html = layoutBase({ title: "Textos do Bot", activePath: "/admin/copy-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });

  router.post("/copy/set-global", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "");
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    await setCopyGlobal(key, value);
    res.redirect("/admin/copy-ui");
  });

  router.post("/copy/del-global", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    await delCopyGlobal(key);
    res.redirect("/admin/copy-ui");
  });

  router.post("/copy/set-user", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const waId = String(req.body?.waId || "").trim();
    const value = String(req.body?.value || "");
    if (!key || !waId) {
      return res.status(400).json({ ok: false, error: "key and waId required" });
    }
    await setCopyUser(waId, key, value);
    res.redirect(`/admin/copy-ui?waId=${encodeURIComponent(waId)}`);
  });

  router.post("/copy/del-user", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const waId = String(req.body?.waId || "").trim();
    if (!key || !waId) {
      return res.status(400).json({ ok: false, error: "key and waId required" });
    }
    await delCopyUser(waId, key);
    res.redirect(`/admin/copy-ui?waId=${encodeURIComponent(waId)}`);
  });



  // -----------------------------
  // Janela 24h (UI já existente)
  // -----------------------------
  router.get("/window24h-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🕒 Janela 24h</h3>
            <div class="muted">Usuários que falaram com o bot nas últimas 24 horas (regra da janela do WhatsApp).</div>
          </div>
          <button class="primary" onclick="load()">Atualizar</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <input id="filter" placeholder="filtrar por waId (contém)" style="min-width:320px" />
          <button onclick="load()">Aplicar filtro</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <span class="pill">Total: <b id="total">—</b></span>
          <span class="pill">Agora: <b id="now">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="list" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        async function load(){
          const f = (document.getElementById('filter').value||'').trim();
          const r = await fetch('/admin/window24h' + (f ? ('?filter=' + encodeURIComponent(f)) : ''));
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

          document.getElementById('total').textContent = String(j.count ?? 0);
          document.getElementById('now').textContent = new Date().toLocaleString('pt-BR');

          const users = Array.isArray(j.users) ? j.users : [];
          if(!users.length){
            document.getElementById('list').innerHTML = '<div class="muted">Nenhum usuário na janela.</div>';
            return;
          }

          const html = '<table><thead><tr><th>waId</th><th>Last Seen</th><th>Ações</th></tr></thead><tbody>' +
            users.map(u => {
              return '<tr>' +
                '<td><code>'+esc(u.waId||'')+'</code></td>' +
                '<td>'+esc(u.lastSeen||'')+'</td>' +
                '<td class="row">' +
                  '<a class="pill" href="/admin/users-ui?waId='+encodeURIComponent(u.waId||'')+'">abrir</a>' +
                  '<a class="pill" href="/admin/send-test?waId='+encodeURIComponent(u.waId||'')+'">send-test</a>' +
                '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('list').innerHTML = html;
        }
        load();
      </script>
    `;
    const html = layoutBase({ title: "Janela 24h", activePath: "/admin/window24h-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });


  // -----------------------------
  // ✅ Broadcast UI
  // -----------------------------
  router.get("/broadcast-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">📣 Broadcast</h3>
            <div class="muted">Cria uma campanha e dispara automaticamente apenas para usuários na janela 24h. Quem estiver fora fica pendente e será enviado ao entrar na janela.</div>
          </div>
          <a class="pill" href="/admin/campaigns-ui">📦 Ver campanhas</a>
        </div>

        <div class="hr"></div>

        <div class="row">
          <label class="pill">Plano alvo:
            <select id="plan">
              <option value="">(todos os planos)</option>
              <option value="DE_VEZ_EM_QUANDO">DE_VEZ_EM_QUANDO</option>
              <option value="SEMPRE_POR_PERTO">SEMPRE_POR_PERTO</option>
              <option value="MELHOR_AMIGO">MELHOR_AMIGO</option>
            </select>
          </label>
        </div>

        <div style="margin-top:10px;">
          <input id="subject" placeholder="Assunto interno (ex: Promo fevereiro)" style="min-width:420px; width:100%;" />
        </div>

        <div style="margin-top:10px;">
          <textarea id="message" placeholder="Mensagem do broadcast (texto)"></textarea>
        </div>

        <div class="row" style="margin-top:10px;">
          <button class="primary" onclick="send()">Criar campanha e enviar (24h)</button>
          <span id="status" class="muted"></span>
        </div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver resposta</summary>
          <pre id="out" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        async function send(){
          const plan = (document.getElementById('plan').value||'').trim();
          const subject = (document.getElementById('subject').value||'').trim();
          const text = (document.getElementById('message').value||'').trim();
          if(!subject){ alert('Informe o assunto'); return; }
          if(!text){ alert('Escreva a mensagem'); return; }

          const body = { subject, text, planTargets: plan ? [plan] : [] };

          document.getElementById('status').textContent = 'Enviando...';
          const r = await fetch('/admin/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          const j = await r.json().catch(()=>({}));
          document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          document.getElementById('status').textContent = j.ok ? '✅ Campanha criada e disparo iniciado' : ('⚠️ ' + (j.error||'erro'));
        }
      </script>
    `;
    const html = layoutBase({ title: "Broadcast", activePath: "/admin/broadcast-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });



  // -----------------------------
  // ✅ Campanhas (UI + APIs)
  // -----------------------------
  router.get("/campaigns-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">📦 Campanhas</h3>
            <div class="muted">Histórico de envios, pendentes e reprocesamento (somente quem já está na janela 24h).</div>
          </div>
          <div class="row">
            <button class="primary" onclick="load()">Atualizar</button>
            <a class="pill" href="/admin/broadcast-ui">📣 Novo broadcast</a>
          </div>
        </div>

        <div class="hr"></div>

        <div id="list" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }

        async function load(){
          const r = await fetch('/admin/campaigns');
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

          const items = Array.isArray(j.items) ? j.items : [];
          if(!items.length){
            document.getElementById('list').innerHTML = '<div class="muted">Nenhuma campanha registrada.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Data</th><th>Assunto</th><th>Plano alvo</th><th>Total</th><th>Enviados</th><th>Pendentes</th><th>Erros</th><th>Ações</th></tr></thead><tbody>' +
            items.map(it => {
              const id = esc(it.id||'');
              return '<tr>' +
                '<td><code>'+esc(it.createdAt||'')+'</code></td>' +
                '<td>'+esc(it.subject||'')+'</td>' +
                '<td><code>'+esc(it.targetPlan||'')+'</code></td>' +
                '<td><b>'+esc(it.totalUsers||0)+'</b></td>' +
                '<td><b>'+esc(it.sentCount||0)+'</b></td>' +
                '<td><b>'+esc(it.pendingCount||0)+'</b></td>' +
                '<td><b>'+esc(it.errorCount||0)+'</b></td>' +
                '<td class="row">' +
                  '<a class="pill" href="#" onclick="reprocess(\\''+id+'\\');return false;">reprocess 24h</a>' +
                  '<a class="pill" href="#" onclick="details(\\''+id+'\\');return false;">detalhes</a>' +
                '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('list').innerHTML = html;
        }

        async function details(id){
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id));
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          alert('Detalhes carregados no JSON bruto.');
        }

        async function reprocess(id){
          if(!confirm('Reprocessar apenas usuários que JÁ estão na janela 24h agora?')) return;
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id) + '/reprocess-window24h', { method:'POST' });
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          await load();
        }

        load();
      </script>
    `;
    const html = layoutBase({ title: "Campanhas", activePath: "/admin/campaigns-ui", content: inner });
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

  // 🧹 Reset TOTAL (número de teste): remove estado, métricas, janela 24h e overrides de copy
  router.get('/state-test/reset-user', async (req, res) => {
    try {
      const waId = requireWaId(req);

      // 1) Estado (user:*) + remove do users:index
      const st = await resetUserAsNew(waId);

      // 2) Janela 24h (zset + last inbound ts) — best-effort
      const w = await clear24hWindowForUser(waId).catch((err) => ({ ok: false, error: String(err?.message || err) }));

      // 3) Métricas (user day/month) — best-effort
      const m = await resetUserDescriptionMetrics(waId, { days: 120, months: 18 }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

      // 4) Copy overrides por usuário — best-effort
      let copyDeleted = 0;
      let copyKeys = [];
      try {
        copyKeys = await listCopyKeys();
        for (const k of (copyKeys || [])) {
          await delCopyUser(waId, k).catch(() => null);
          copyDeleted++;
        }
      } catch (err) {
        // ignore (best-effort)
      }

      return res.json({
        ok: true,
        action: 'reset-user-total',
        waId,
        state: st,
        window24h: w,
        metrics: m,
        copy: { ok: true, keys: copyKeys?.length || 0, deleted: copyDeleted },
        note: 'Após esse reset, o usuário volta a ser “novo”. O snapshot (Consultar) recria defaults (TRIAL/FIXED).',
      });
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
