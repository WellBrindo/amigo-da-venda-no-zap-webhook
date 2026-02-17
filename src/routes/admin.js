// src/routes/admin.js
import { Router } from "express";

import {
  setUserStatus,
  setUserPlan,
  setUserQuotaUsed,
  setUserTrialUsed,
  getUserSnapshot,
  clearLastPrompt, // ✅ V16.4.6: limpar via DEL (não SET "")
  setLastPrompt,  // ✅ TESTE CONTROLADO: forçar setLastPrompt("")
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
} from "../services/window24h.js";

import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import { listPlans, upsertPlan, setPlanActive, getPlansHealth, listSystemAlerts, getSystemAlertsCount } from "../services/plans.js";

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
        <a href="/admin/plans">💳 Planos</a><br/>
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
    button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; cursor:pointer; background:white; }
    pre { background:#f6f6f6; padding: 12px; border-radius: 12px; overflow:auto; }
    .muted { color:#666; }
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

  router.get("/state-test/reset-trial", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await setUserStatus(waId, "TRIAL");
      await setUserPlan(waId, "");
      await setUserQuotaUsed(waId, 0);
      await setUserTrialUsed(waId, 0);

      // ✅ V16.4.6: Upstash REST não aceita SET com valor vazio de forma confiável
      // Para limpar, usamos DEL via clearLastPrompt()
      await clearLastPrompt(waId);

      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, action: "reset-trial", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  // ✅ TESTE CONTROLADO: força chamada direta de setLastPrompt("")
  // Objetivo: provar que o hardening no state.js está funcionando (vazio => DEL)
  router.get("/state-test/set-lastprompt-empty", async (req, res) => {
    try {
      const waId = requireWaId(req);

      // 🔴 proposital: chamar setLastPrompt com string vazia
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

  // ----------------------------
  // ✅ Health + Alertas (telemetria)
  // ----------------------------

  router.get("/health-plans", async (req, res) => {
    try {
      const health = await getPlansHealth();
      return res.json({ ok: true, health });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/alerts-count", async (req, res) => {
    try {
      const count = await getSystemAlertsCount();
      return res.json({ ok: true, count });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/alerts", async (req, res) => {
    try {
      const limit = Number(req.query?.limit || 50);
      const items = await listSystemAlerts({ limit });
      return res.json({ ok: true, returned: items.length, items });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
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
    button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; cursor:pointer; background:white; }
    pre { background:#f6f6f6; padding: 12px; border-radius: 12px; overflow:auto; }
    .muted { color:#666; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; width: 120px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚨 Alertas do Sistema</h2>
    <p><a href="/admin">⬅ Voltar</a></p>
    <div class="row">
      <div class="muted">Mostra os últimos alertas persistidos em Redis (TTL ~ 7 dias).</div>
    </div>

    <div class="row" style="margin-top:12px;">
      <input id="limit" value="50" />
      <button onclick="load()">Carregar</button>
      <button onclick="location.reload()">Atualizar</button>
    </div>

    <pre id="out"></pre>
  </div>

<script>
async function load(){
  const limit = Number(document.getElementById('limit').value || 50);
  const r = await fetch('/admin/alerts?limit=' + encodeURIComponent(limit));
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

  return router;
}
