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
import { listPlans, upsertPlan, setPlanActive } from "../services/plans.js";

import { pushSystemAlert, listSystemAlerts, getSystemAlertsCount } from "../services/alerts.js";
import { createAndDispatchCampaign, listCampaigns, getCampaignDetails } from "../services/campaigns.js";

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
        <a href="/admin/broadcast-ui">📣 Broadcast</a><br/>
        <a href="/admin/campaigns-ui">📦 Campanhas</a><br/>
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
    priceCents: Number((document.getElementById('priceCents').value||'').trim()),
    monthlyQuota: Number((document.getElementById('monthlyQuota').value||'').trim()),
    description: (document.getElementById('description').value||'').trim(),
    active: true
  };
  const r = await fetch('/admin/plans', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>({}));
  document.getElementById('msg').textContent = JSON.stringify(j,null,2);
  if(j.ok) location.reload();
}

async function toggle(code, active){
  const r = await fetch('/admin/plans/toggle?code=' + encodeURIComponent(code) + '&active=' + encodeURIComponent(active));
  const j = await r.json().catch(()=>({}));
  document.getElementById('msg').textContent = JSON.stringify(j,null,2);
  if(j.ok) location.reload();
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.post("/plans", async (req, res) => {
    try {
      const plan = await upsertPlan(req.body);
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get("/plans/toggle", async (req, res) => {
    try {
      const code = String(req.query?.code || "").trim();
      const active = String(req.query?.active || "false").trim() === "true";
      const plan = await setPlanActive(code, active);
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get("/window24h-ui", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Janela 24h</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    button, input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
    .muted { color:#666; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🕒 Janela 24h</h2>
    <p><a href="/admin">⬅ Voltar</a></p>

    <div class="row">
      <button onclick="load()">Atualizar</button>
      <span class="muted">Total ativos na janela: <b id="count">...</b></span>
    </div>

    <pre id="out" class="muted">Clique em "Atualizar".</pre>
  </div>

<script>
async function load(){
  const r1 = await fetch('/admin/window24h');
  const j1 = await r1.json().catch(()=>({}));
  document.getElementById('count').textContent = (j1.count ?? 0);
  document.getElementById('out').textContent = JSON.stringify(j1, null, 2);
}
load();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // ----------------------------
  // ✅ State test endpoints
  // ----------------------------

  router.get("/state-test/reset-trial", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await setUserStatus(waId, "TRIAL");
      await setUserPlan(waId, "");
      await setUserQuotaUsed(waId, 0);
      await setUserTrialUsed(waId, 0);
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, action: "reset-trial", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/state-test/clear-lastprompt", async (req, res) => {
    try {
      const waId = requireWaId(req);
      await clearLastPrompt(waId);
      const user = await getUserSnapshot(waId);
      return res.json({ ok: true, action: "clear-lastprompt", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  // ✅ TESTE CONTROLADO (produção): força setLastPrompt("")
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
  // ✅ Broadcast Inteligente (Campanhas)
  // - POST /admin/campaigns  => cria + dispatch (janela 24h)
  // - GET  /admin/campaigns  => lista
  // - GET  /admin/campaigns/:id => detalhes
  // - UI: /admin/broadcast-ui e /admin/campaigns-ui
  // ----------------------------

  router.get("/campaigns", async (req, res) => {
    try {
      const limit = Number(req.query?.limit || 50);
      const items = await listCampaigns({ limit });
      return res.json({ ok: true, returned: items.length, items });
    } catch (err) {
      await pushSystemAlert("CAMPAIGNS_LIST_FAILED", { error: String(err?.message || err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/campaigns/:id", async (req, res) => {
    try {
      const id = String(req.params?.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "id required" });

      const item = await getCampaignDetails(id);
      if (!item) return res.status(404).json({ ok: false, error: "campaign not found" });

      return res.json({ ok: true, item });
    } catch (err) {
      await pushSystemAlert("CAMPAIGN_GET_FAILED", { error: String(err?.message || err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const subject = String(req.body?.subject || "").trim();
      const text = String(req.body?.text || "").trim();
      const messageType = String(req.body?.messageType || "TEXT").trim().toUpperCase();

      // planCodes pode vir como array ou string CSV
      let planCodes = req.body?.planCodes ?? [];
      if (typeof planCodes === "string") {
        planCodes = planCodes
          .split(",")
          .map((s) => String(s).trim())
          .filter(Boolean);
      }
      if (!Array.isArray(planCodes)) planCodes = [];

      if (!subject && !text) {
        return res.status(400).json({ ok: false, error: "subject or text is required" });
      }

      const result = await createAndDispatchCampaign({
        subject,
        text,
        planCodes,
        messageType: messageType === "TEMPLATE" ? "TEMPLATE" : "TEXT",
        template: req.body?.template ?? null,
      });

      return res.json({ ok: true, result });
    } catch (err) {
      await pushSystemAlert("CAMPAIGN_CREATE_FAILED", { error: String(err?.message || err) });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/broadcast-ui", async (req, res) => {
    const plans = await listPlans({ includeInactive: true });
    const planOptions = (plans || [])
      .filter((p) => p && p.code)
      .map((p) => {
        const code = escapeHtml(p.code);
        const name = escapeHtml(p.name || p.code);
        return `<label style="display:inline-flex; gap:6px; align-items:center; margin: 6px 10px 6px 0;">
          <input type="checkbox" name="plan" value="${code}" /> <span>${name} (<code>${code}</code>)</span>
        </label>`;
      })
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
    input, textarea, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid #ddd; }
    textarea { width: 100%; min-height: 160px; }
    button { cursor: pointer; background: white; }
    .muted { color: #666; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    code { background:#f6f6f6; padding:2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📣 Broadcast (Campanha)</h2>
    <p><a href="/admin">⬅ Voltar</a> · <a href="/admin/campaigns-ui">📦 Ver campanhas</a></p>

    <p class="muted">
      Regras: envia <b>agora</b> somente para quem está na janela 24h; quem estiver fora fica <b>pendente</b> e será enviado automaticamente quando entrar na janela (quando mandar inbound).
    </p>

    <div class="row">
      <input id="subject" placeholder="Assunto (opcional)" style="min-width:420px" />
      <select id="messageType">
        <option value="TEXT">Texto (agora)</option>
        <option value="TEMPLATE">Template (futuro)</option>
      </select>
      <button onclick="send()">Criar e enviar</button>
    </div>

    <div style="margin-top: 12px;">
      <textarea id="text" placeholder="Texto da campanha (ex.: manutenção, aviso, promoção...)"></textarea>
    </div>

    <h3 style="margin-top:16px;">Filtro por plano</h3>
    <p class="muted">Se não marcar nenhum, envia para <b>todos</b>.</p>
    <div>${planOptions || "<span class='muted'>Nenhum plano encontrado.</span>"}</div>

    <pre id="out"></pre>
  </div>

<script>
function selectedPlans(){
  return Array.from(document.querySelectorAll('input[name="plan"]:checked')).map(x => x.value);
}
async function send(){
  const subject = (document.getElementById('subject').value||'').trim();
  const text = (document.getElementById('text').value||'').trim();
  const messageType = (document.getElementById('messageType').value||'TEXT').trim();
  const planCodes = selectedPlans();

  const r = await fetch('/admin/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, text, messageType, planCodes })
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
    table { width:100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 10px; border-bottom: 1px solid #eee; text-align:left; vertical-align: top; }
    .muted { color:#666; }
    button, input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; background:white; cursor:pointer; }
    code { background:#f6f6f6; padding:2px 6px; border-radius: 6px; }
    pre { background:#f6f6f6; padding:12px; border-radius:12px; overflow:auto; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📦 Campanhas</h2>
    <p><a href="/admin">⬅ Voltar</a> · <a href="/admin/broadcast-ui">📣 Nova campanha</a></p>

    <div class="row">
      <input id="limit" value="50" />
      <button onclick="load()">Atualizar</button>
    </div>

    <div id="tableWrap"></div>
    <h3>Detalhes</h3>
    <pre id="details" class="muted">Clique em "Ver" em alguma campanha.</pre>
  </div>

<script>
function esc(s){ return String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

async function load(){
  const limit = Number(document.getElementById('limit').value||50);
  const r = await fetch('/admin/campaigns?limit=' + encodeURIComponent(limit));
  const j = await r.json().catch(()=>({}));
  const items = (j.items||[]);

  let rows = '';
  for(const it of items){
    const id = esc(it.id);
    const createdAt = esc(it.createdAt||'');
    const subject = esc(it.subject||'');
    const plans = Array.isArray(it.planCodes) && it.planCodes.length ? it.planCodes.join(', ') : 'TODOS';
    const sent = it.counts?.sentCount ?? 0;
    const pending = it.counts?.pendingCount ?? 0;
    const errors = it.counts?.errorCount ?? 0;

    rows += '<tr>'
      + '<td><code>' + id + '</code><br/><span class="muted">' + createdAt + '</span></td>'
      + '<td>' + subject + '<br/><span class="muted">Planos: ' + esc(plans) + '</span></td>'
      + '<td>Enviados: <b>' + sent + '</b><br/>Pendentes: <b>' + pending + '</b><br/>Erros: <b>' + errors + '</b></td>'
      + '<td><button onclick="view(\\'' + id + '\\')">Ver</button></td>'
      + '</tr>';
  }

  document.getElementById('tableWrap').innerHTML =
    '<table><thead><tr><th>ID</th><th>Conteúdo</th><th>Contagem</th><th>Ação</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="4" class="muted">Nenhuma campanha encontrada.</td></tr>')
    + '</tbody></table>';
}

async function view(id){
  const r = await fetch('/admin/campaigns/' + encodeURIComponent(id));
  const j = await r.json().catch(()=>({}));
  document.getElementById('details').textContent = JSON.stringify(j, null, 2);
}

load();
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // ----------------------------
  // ✅ Health + Alertas (telemetria)
  // ----------------------------

  router.get("/health-plans", async (req, res) => {
    try {
      const plansAll = await listPlans({ includeInactive: true });
      const activePlans = (plansAll || []).filter((p) => Boolean(p?.active));

      const health = {
        ok: activePlans.length > 0,
        countAll: (plansAll || []).length,
        countActive: activePlans.length,
        reason:
          (plansAll || []).length === 0
            ? "NO_PLANS"
            : activePlans.length === 0
              ? "ALL_INACTIVE"
              : null,
      };

      if (!health.ok) {
        await pushSystemAlert("PLANS_EMPTY_OR_ERROR", {
          reason: health.reason,
          countAll: health.countAll,
          countActive: health.countActive,
        });
      }

      return res.json({ ok: true, health });
    } catch (err) {
      await pushSystemAlert("PLANS_HEALTH_CHECK_FAILED", { error: String(err?.message || err) });
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
      const items = await listSystemAlerts(limit);
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
    <div class="row" style="margin-top: 10px;">
      <input id="limit" value="50" />
      <button onclick="load()">Atualizar</button>
    </div>
    <pre id="out" class="muted">Clique em "Atualizar".</pre>
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
