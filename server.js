import express from "express";
import crypto from "crypto";
// AMIGO DAS VENDAS — server.js V15.9 (Dashboard Admin Basic Auth + métricas + consulta usuário) (Atualização: quotas/expiração + retry OpenAI + controle de custo + assinatura Asaas ativa)


// Node 18+ já tem fetch global.
// Este server.js é ESM (import ...). Garanta "type":"module" no package.json.

const app = express();
app.use(express.json());

// ===================== CONFIG =====================
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// OpenAI controle de custo (limite de saída por resposta)
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 450);

// Retry seguro OpenAI
const OPENAI_RETRY_MAX_ATTEMPTS = Number(process.env.OPENAI_RETRY_MAX_ATTEMPTS || 3);
const OPENAI_RETRY_BASE_DELAY_MS = Number(process.env.OPENAI_RETRY_BASE_DELAY_MS || 350);

// Upstash (Redis REST)
const USE_UPSTASH =
  String(process.env.USE_UPSTASH || "true").trim().toLowerCase() === "true";
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

// Asaas
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_ENV = (process.env.ASAAS_ENV || "sandbox").trim(); // "sandbox" | "production"
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim(); // opcional (recomendado)

// ✅ FIX CRÍTICO: Base URL correta do Asaas
// Production: https://api.asaas.com
// Sandbox: https://api-sandbox.asaas.com
const ASAAS_BASE_URL =
  ASAAS_ENV === "production" ? "https://api.asaas.com" : "https://api-sandbox.asaas.com";

// Produto
const HELP_URL = "https://amigodasvendas.com.br";

// Reset controlado (somente para seu número de teste)
const TEST_RESET_WAID = "5511960765975";
const TEST_RESET_COMMANDS = new Set(["resetar", "reset", "zerar"]); // comandos aceitos

// Trial e limites
const FREE_DESCRIPTIONS_LIMIT = 5;        // trial por uso
const MAX_REFINES_PER_DESCRIPTION = 2;    // até 2 refinamentos por descrição; o 3º conta como nova descrição

// TTLs (Upstash / Redis)
// Idempotência: evita crescer infinito (ex.: 7 dias)
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
// Pendência de pagamento: expira após 48h
const PENDING_PAYMENT_TTL_SECONDS = 48 * 60 * 60;

// Planos (descrições por mês)
const PLANS = {
  1: {
    code: "DE_VEZ_EM_QUANDO",
    name: "De Vez em Quando",
    price: 24.9,
    quotaMonthly: 20,
    description:
      "Ideal para quem quer ter o Amigo ali por perto, mas usa só quando precisa dar aquele empurrão nas vendas.",
    button: "Ficar de vez em quando",
  },
  2: {
    code: "SEMPRE_POR_PERTO",
    name: "Sempre por Perto",
    price: 34.9,
    quotaMonthly: 60,
    description: "Para quem já entendeu que vender melhor muda o jogo. O Amigo acompanha seu ritmo.",
    button: "Quero o Amigo comigo",
  },
  3: {
    code: "MELHOR_AMIGO",
    name: "Melhor Amigo",
    price: 49.9,
    quotaMonthly: 200,
    description: "Para quem não quer só ajuda. Quer parceria de verdade.",
    button: "Virar Melhor Amigo",
  },
};

// ===================== LOG SEGURO =====================
function safeLogError(prefix, err) {
  // Nunca logar CPF/CNPJ, nem payloads completos.
  const msg =
    err?.message ||
    err?.error?.message ||
    (typeof err === "string" ? err : "Erro desconhecido");
  console.error(prefix, { message: msg });
}

// ===================== HEALTH =====================
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap webhook rodando");
});

// Observabilidade leve (sem vazar segredos)
app.get("/healthz", async (_req, res) => {
  const missing = [];

  // Essenciais
  if (!ACCESS_TOKEN) missing.push("ACCESS_TOKEN");
  if (!PHONE_NUMBER_ID) missing.push("PHONE_NUMBER_ID");
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!ASAAS_API_KEY) missing.push("ASAAS_API_KEY");

  // Upstash (se habilitado)
  if (USE_UPSTASH) {
    if (!UPSTASH_REDIS_REST_URL) missing.push("UPSTASH_REDIS_REST_URL");
    if (!UPSTASH_REDIS_REST_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");
  }

  let upstashOk = null;
  if (USE_UPSTASH && UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    try {
      const pong = await upstashCommand(["PING"]);
      upstashOk = String(pong?.result || "").toUpperCase() === "PONG";
    } catch {
      upstashOk = false;
    }
  }

  const ok =
    missing.length === 0 &&
    (USE_UPSTASH ? (upstashOk === true) : true);

  return res.status(ok ? 200 : 503).json({
    ok,
    uptimeSec: Math.floor(process.uptime()),
    upstash: {
      enabled: USE_UPSTASH,
      ok: upstashOk,
    },
    env: {
      missing,
    },
  });
});

// ===================== ADMIN DASHBOARD (Basic Auth) =====================
function requireAdminBasicAuth(req, res, next) {
  try {
    if (!ADMIN_SECRET) {
      return res.status(500).send("ADMIN_SECRET não configurado");
    }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin Dashboard"');
      return res.status(401).send("Auth required");
    }
    const b64 = auth.slice(6).trim();
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (user !== "admin" || pass !== ADMIN_SECRET) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin Dashboard"');
      return res.status(401).send("Unauthorized");
    }
    return next();
  } catch (_e) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Dashboard"');
    return res.status(401).send("Unauthorized");
  }
}

async function scanKeys(match, maxKeys = 8000) {
  const keys = [];
  if (!USE_UPSTASH) return keys;
  let cursor = "0";
  let guard = 0;
  while (true) {
    guard += 1;
    if (guard > 60) break;
    const resp = await upstashCommand(["SCAN", cursor, "MATCH", match, "COUNT", "200"]);
    const result = resp?.result;
    if (!Array.isArray(result) || result.length < 2) break;
    cursor = String(result[0]);
    const batch = result[1] || [];
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= maxKeys) return keys;
    }
    if (cursor === "0") break;
  }
  return keys;
}

function normalizeWaIdLike(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  return s.replace(/\D/g, "");
}

app.get("/admin", requireAdminBasicAuth, async (_req, res) => {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Amigo das Vendas — Admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;line-height:1.35}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px}
    .muted{color:#666;font-size:13px}
    .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    input{padding:10px;border:1px solid #ccc;border-radius:8px;min-width:280px}
    button{padding:10px 14px;border:1px solid #111;border-radius:8px;background:#111;color:#fff;cursor:pointer}
    pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:10px;border:1px solid #eee;overflow:auto}
    h1{margin:0 0 6px 0}
    a{color:inherit}
  </style>
</head>
<body>
  <h1>Amigo das Vendas — Dashboard</h1>
  <div class="muted">Acesso restrito (Basic Auth). URL: <b>/admin</b></div>

  <div class="grid" id="cards"></div>

  <h2 style="margin-top:22px">Usuários</h2>
  <div class="muted">Carregue a lista e selecione um usuário para visualizar os dados. Você também pode digitar manualmente o waId.</div>

  <div class="row" style="margin-top:10px">
    <button onclick="loadUsers()">Carregar usuários</button>
    <select id="userSelect" onchange="onPickUser()" style="padding:10px;border:1px solid #ccc;border-radius:8px;min-width:320px">
      <option value="">— selecione —</option>
    </select>
    <input id="q" placeholder="Ou digite: 5511999999999" />
    <button onclick="lookup()">Buscar</button>
  </div>

  <div id="userBox" style="margin-top:12px"></div>

<script>
function escapeHtml(s){s=String(s??'');return s.replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));}
async function loadUsers(){
  const sel = document.getElementById('userSelect');
  sel.innerHTML = '<option value="">carregando...</option>';
  try{
    const r = await fetch('/admin/users?limit=1000');
    const j = await r.json();
    const users = (j && j.users) ? j.users : [];
    sel.innerHTML = '<option value="">— selecione —</option>' + users.map(u=>{
      const label = (u.waId || '') + (u.status ? (' — ' + u.status) : '') + (u.plan ? (' — ' + u.plan) : '');
      return '<option value="'+ escapeHtml(String(u.waId||'')) +'">'+ escapeHtml(label) +'</option>';
    }).join('');
  }catch(e){
    sel.innerHTML = '<option value="">erro ao carregar</option>';
  }
}
function onPickUser(){
  const sel = document.getElementById('userSelect');
  const v = sel.value || '';
  if(!v) return;
  document.getElementById('q').value = v;
  lookup();
}

async function loadMetrics(){
  const r = await fetch('/admin/metrics');
  const j = await r.json();
  const cards = document.getElementById('cards');
  const items = [
    ['Usuários (status:*)', j.usersTotal ?? '-'],
    ['Trial', j.status?.TRIAL ?? 0],
    ['Ativos', j.status?.ACTIVE ?? 0],
    ['Aguard. Plano', j.status?.WAIT_PLAN ?? 0],
    ['Pag. Pendente', j.status?.PAYMENT_PENDING ?? 0],
    ['Bloqueados', j.status?.BLOCKED ?? 0],
    ['Descrições hoje', j.descriptionsToday ?? 0],
    ['Descrições mês', j.descriptionsMonth ?? 0],
    ['Upstash', j.upstashOk ? 'OK' : 'Falha'],
    ['Uptime (min)', Math.round((j.uptimeSec||0)/60)],
  ];
  cards.innerHTML = items.map(([t,v]) => '<div class="card"><div class="muted">'+escapeHtml(String(t))+'</div><div style="font-size:22px;font-weight:700;margin-top:6px">'+escapeHtml(String(v))+'</div></div>').join('');
}
async function lookup(){
  const q = document.getElementById('q').value || '';
  const box = document.getElementById('userBox');
  if(!q.trim()){ box.innerHTML = '<div class="card">Digite um waId para consultar.</div>'; return; }
  box.innerHTML = '<div class="card">Carregando...</div>';
  const r = await fetch('/admin/user?q=' + encodeURIComponent(q));
  if(!r.ok){
    const t = await r.text().catch(()=> '');
    box.innerHTML = '<div class="card">Não encontrado / erro.<div class="muted" style="margin-top:6px">' + (t || '') + '</div></div>';
    return;
  }
  const j = await r.json();
  box.innerHTML = '<pre>' + JSON.stringify(j, null, 2) + '</pre>';
}
loadMetrics();
</script>
</body>
</html>`;
  res.status(200).send(html);
});

app.get("/admin/metrics", requireAdminBasicAuth, async (_req, res) => {
  let upstashOk = false;
  try {
    const ping = await upstashCommand(["PING"]);
    upstashOk = !!ping?.result;
  } catch (_e) {
    upstashOk = false;
  }

  const statusKeys = await scanKeys("status:*", 12000);
  const statusCounts = { TRIAL: 0, ACTIVE: 0, WAIT_PLAN: 0, PAYMENT_PENDING: 0, BLOCKED: 0, OTHER: 0 };
  for (const k of statusKeys) {
    const v = await redisGet(k);
    const vv = String(v || "").toUpperCase();
    if (statusCounts[vv] !== undefined) statusCounts[vv] += 1;
    else statusCounts.OTHER += 1;
  }

  const d = new Date();
  const dayKey = `metrics:descriptions:day:${d.toISOString().slice(0,10)}`;
  const monthKey = `metrics:descriptions:month:${d.toISOString().slice(0,7)}`;
  const descriptionsToday = Number((await redisGet(dayKey)) || 0) || 0;
  const descriptionsMonth = Number((await redisGet(monthKey)) || 0) || 0;

  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    upstashOk,
    usersTotal: statusKeys.length,
    status: statusCounts,
    descriptionsToday,
    descriptionsMonth,
  });
});

app.get("/admin/users", requireAdminBasicAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 5000);
  const statusKeys = await scanKeys("status:*", 12000);
  const waIds = statusKeys.map(k => String(k).split(":")[1]).filter(Boolean);

  // sort stable (lexicographic)
  waIds.sort();

  const slice = waIds.slice(0, limit);
  const out = [];
  for (const waId of slice) {
    const status = await redisGet(kStatus(waId));
    const plan = await redisGet(kPlan(waId));
    out.push({ waId, status: status || null, plan: plan || null });
  }

  res.status(200).json({ ok: true, total: waIds.length, returned: out.length, users: out });
});

app.get("/admin/user", requireAdminBasicAuth, async (req, res) => {
  const q = req.query.q || "";
  const waId = normalizeWaIdLike(q);
  if (!waId) return res.status(400).send("missing q");

  const status = await redisGet(kStatus(waId));
  const plan = await redisGet(kPlan(waId));
  const freeUsed = await redisGet(kFreeUsed(waId));
  const quotaUsed = await redisGet(kQuotaUsed(waId));
  const quotaMonth = await redisGet(kQuotaMonth(waId));
  const lastDesc = await redisGet(kLastDesc(waId));
  const refineCount = await redisGet(kRefineCount(waId));

  const prefs = await getPrefs(waId).catch(() => null);
  const savedConditions = await getSavedConditions(waId).catch(() => null);
  const styleAnchor = await getStyleAnchor(waId).catch(() => null);

  const pending = {
    plan: await redisGet(kPendingPlan(waId)),
    method: await redisGet(kPendingMethod(waId)),
    paymentId: await redisGet(kPendingPaymentId(waId)),
    subId: await redisGet(kPendingSubId(waId)),
    createdAt: await redisGet(kPendingCreatedAt(waId)),
  };

  if (!status && !plan && !freeUsed && !quotaUsed && !prefs && !savedConditions && !styleAnchor) {
    return res.status(404).json({ found: false, waId });
  }

  res.json({
    found: true,
    waId,
    status,
    plan,
    quota: {
      freeUsed: freeUsed ? Number(freeUsed) : 0,
      quotaUsed: quotaUsed ? Number(quotaUsed) : 0,
      quotaMonth,
      refineCount: refineCount ? Number(refineCount) : 0,
    },
    prefs,
    savedConditions,
    styleAnchor,
    lastDescriptionPreview: (lastDesc || "").slice(0, 700),
    pending,
  });
});


// ===================== WEBHOOK VERIFY (META) =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== UPSTASH (REST) =====================
async function upstashCommand(commandArr) {
  if (!USE_UPSTASH) return null;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    safeLogError("Upstash não configurado.", { message: "Falta UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN" });
    return null;
  }

  const url = UPSTASH_REDIS_REST_URL;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commandArr),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    safeLogError("Erro Upstash:", { message: JSON.stringify(data) });
    return null;
  }
  return data;
}

async function redisGet(key) {
  if (!USE_UPSTASH) return null;
  const r = await upstashCommand(["GET", key]);
  return r?.result ?? null;
}

async function redisSet(key, value) {
  if (!USE_UPSTASH) return null;
  const v = value === undefined ? "" : String(value);
  return upstashCommand(["SET", key, v]);
}

async function redisSetEx(key, value, ttlSeconds) {
  if (!USE_UPSTASH) return null;
  const v = value === undefined ? "" : String(value);
  const ttl = Number(ttlSeconds || 0);
  if (!ttl || ttl <= 0) return upstashCommand(["SET", key, v]);
  return upstashCommand(["SET", key, v, "EX", String(ttl)]);
}

async function redisDel(key) {
  if (!USE_UPSTASH) return null;
  return upstashCommand(["DEL", key]);
}

async function redisIncr(key) {
  if (!USE_UPSTASH) return null;
  const r = await upstashCommand(["INCR", key]);
  return Number(r?.result ?? 0);
}

// ===================== CHAVES (REDIS) =====================
function kUser(waId) { return `user:${waId}`; }
function kStatus(waId) { return `status:${waId}`; }

function kFreeUsed(waId) { return `freeused:${waId}`; }

function kPlan(waId) { return `plan:${waId}`; }                 // code
function kQuotaUsed(waId) { return `quotaused:${waId}`; }       // uso do mês
function kQuotaMonth(waId) { return `quotamonth:${waId}`; }     // YYYY-MM
function kPixValidUntil(waId) { return `pixvalid:${waId}`; }    // epoch ms

function kAsaasCustomerId(waId) { return `asaas:customer:${waId}`; }
function kAsaasSubscriptionId(waId) { return `asaas:sub:${waId}`; }

// índices reversos (para o webhook)
function kAsaasCustomerToWa(customerId) { return `asaas:customer_to_wa:${customerId}`; }
function kAsaasPaymentToWa(paymentId) { return `asaas:payment_to_wa:${paymentId}`; }
function kAsaasSubToWa(subId) { return `asaas:sub_to_wa:${subId}`; }

// cache rápido de status de assinatura (para evitar calls excessivas ao Asaas)
function kAsaasSubActiveCache(subId) { return `asaas:sub_active:${subId}`; }
function kAsaasSubActiveCacheAt(subId) { return `asaas:sub_active_at:${subId}`; }

// pagamento pendente
function kPendingPlan(waId) { return `pending:plan:${waId}`; }        // planCode
function kPendingMethod(waId) { return `pending:method:${waId}`; }    // PIX | CARD
function kPendingPaymentId(waId) { return `pending:payment:${waId}`; } // paymentId (pix)
function kPendingSubId(waId) { return `pending:sub:${waId}`; }         // subId (cartão)
function kPendingCreatedAt(waId) { return `pending:at:${waId}`; }      // epoch ms

function kDraft(waId) { return `draft:${waId}`; }
function kLastDesc(waId) { return `lastdesc:${waId}`; }
function kLastInput(waId) { return `lastinput:${waId}`; }      // texto base da última descrição (para refino)
function kRefineCount(waId) { return `refinecount:${waId}`; }

function kIdempotency(messageId) { return `idemp:${messageId}`; }
function kCleanupTick() { return `cleanup:last`; }

// Menu: “return status” separado para não travar
function kMenuReturn(waId) { return `menu:return:${waId}`; }

// Salvar condições neutras (confirmação)
function kCondPending(waId) { return `cond:pending:${waId}`; }
function kCondReturn(waId) { return `cond:return:${waId}`; }

// ===================== USER STATE =====================
async function getStatus(waId) {
  const s = await redisGet(kStatus(waId));
  return s || "WAIT_NAME";
}
async function setStatus(waId, status) {
  await redisSet(kStatus(waId), status);
}

async function getUser(waId) {
  const raw = await redisGet(kUser(waId));
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function setUser(waId, obj) {
  await redisSet(kUser(waId), JSON.stringify(obj || {}));
}
async function getFullName(waId) {
  const u = await getUser(waId);
  return u?.name || "";
}
async function setFullName(waId, name) {
  const u = await getUser(waId);
  u.name = String(name || "").trim();
  await setUser(waId, u);
}
async function getDoc(waId) {
  const u = await getUser(waId);
  return u?.doc || "";
}
async function setDoc(waId, doc) {
  const u = await getUser(waId);
  u.doc = String(doc || "").trim();
  await setUser(waId, u);
}

// ===================== CONDIÇÕES SALVAS / PREFERÊNCIAS =====================
async function getPrefs(waId) {
  const u = await getUser(waId);
  const p = { ...(u?.prefs || {}), ...(u?.structBasePrefs || {}) };
  return {
    // Estrutura (defaults do projeto)
    allowBullets: p.allowBullets !== false,                     // default true
    allowConditionsBlock: p.allowConditionsBlock !== false,     // default true
    allowConditionIcons: p.allowConditionIcons !== false,       // default true (📍 💰 🕒)

    // Preferências gerais de formatação (defaults do projeto)
    allowEmojis: p.allowEmojis !== false,                       // default true (afeta título, bullets e ícones)
    allowBold: p.allowBold !== false,                           // default true (uso de *negrito*)
    forceAllBold: p.forceAllBold === true,                      // default false
    plainText: p.plainText === true,                            // default false (sem markdown, sem emoji, sem bullets)
    oneParagraph: p.oneParagraph === true,                      // default false (tudo corrido / sem tabulação)
    tableLayout: p.tableLayout === true,                        // default false (formato tabela texto)
  };
}
async function setPrefs(waId, patch) {
  const u = await getUser(waId);
  u.prefs = { ...(u.prefs || {}), ...(patch || {}) };
  await setUser(waId, u);
}


// ===================== BASE E PENDÊNCIAS DE FORMATAÇÃO (ESTRUTURA) =====================
// A "base do projeto" é aplicada quando não há base customizada.
// Mudanças estruturais feitas pelo usuário em um refinamento podem ser aplicadas no momento,
// mas antes de criar uma NOVA descrição perguntamos se ele quer manter como base.

async function getStructBasePrefs(waId) {
  const u = await getUser(waId);
  return u?.structBasePrefs || null; // null = usar base do projeto
}
async function setStructBasePrefs(waId, patch) {
  const u = await getUser(waId);
  const cur = u?.structBasePrefs || {};
  u.structBasePrefs = { ...cur, ...(patch || {}) };
  await setUser(waId, u);
}
async function clearStructBasePrefs(waId) {
  const u = await getUser(waId);
  delete u.structBasePrefs;
  await setUser(waId, u);
}

async function resetAllFormattingPrefs(waId) {
  const u = await getUser(waId);
  delete u.prefs;
  delete u.structBasePrefs;
  delete u.pendingStruct;
  delete u.pendingStructQueuedText;
  await setUser(waId, u);
}

async function getPendingStruct(waId) {
  const u = await getUser(waId);
  return u?.pendingStruct || null;
}
async function setPendingStruct(waId, pending) {
  const u = await getUser(waId);
  u.pendingStruct = pending || null;
  await setUser(waId, u);
}
async function clearPendingStruct(waId) {
  const u = await getUser(waId);
  delete u.pendingStruct;
  delete u.pendingStructQueuedText;
  await setUser(waId, u);
}
async function getSavedConditions(waId) {
  const u = await getUser(waId);
  return u?.savedConditions || {};
}
async function setSavedConditions(waId, patch) {
  const u = await getUser(waId);
  u.savedConditions = { ...(u.savedConditions || {}), ...(patch || {}) };
  await setUser(waId, u);
}
async function clearSavedConditionsFields(waId, fields) {
  const u = await getUser(waId);
  const cur = { ...(u.savedConditions || {}) };
  for (const f of (fields || [])) delete cur[f];
  u.savedConditions = cur;
  await setUser(waId, u);
}

async function setPendingConditions(waId, obj, returnStatus) {
  await redisSet(kCondPending(waId), JSON.stringify(obj || {}));
  await redisSet(kCondReturn(waId), returnStatus || "ACTIVE");
}
async function getPendingConditions(waId) {
  const raw = await redisGet(kCondPending(waId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function clearPendingConditions(waId) {
  await redisDel(kCondPending(waId));
  await redisDel(kCondReturn(waId));
}
async function popCondReturn(waId) {
  const r = await redisGet(kCondReturn(waId));
  await redisDel(kCondReturn(waId));
  return r || "ACTIVE";
}

async function setStyleAnchor(waId, desc) {
  const u = await getUser(waId);
  u.styleAnchor = String(desc || "");
  u.styleAnchorAt = Date.now();
  await setUser(waId, u);
}
async function getStyleAnchor(waId) {
  const u = await getUser(waId);
  return String(u?.styleAnchor || "");
}

/**
 * Não “corrigir” estados intencionais (menu/compra/pagamento pendente etc.)
 */
async function normalizeOnboardingStatus(waId, status) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);

  /**
   * Não “corrigir” estados intencionais (menu/compra/pagamento pendente etc.)
   */
  const doNotNormalize = new Set([
    "MENU",
    "MENU_CANCEL_CONFIRM",
    "MENU_UPDATE_NAME",
    "MENU_UPDATE_DOC",
    "WAIT_PLAN",
    "WAIT_PAYMETHOD",
    "WAIT_DOC", // usado para coletar CPF/CNPJ apenas na contratação do plano
    "PAYMENT_PENDING",
    "BLOCKED",
    "ACTIVE",
  ]);
  if (doNotNormalize.has(status)) return status;

  // Se já tem nome, não deve ficar voltando a pedir nome novamente.
  if (name && (status === "WAIT_NAME" || status === "WAIT_NAME_VALUE")) {
    return "ACTIVE";
  }

  return status;
}

// ===================== TRIAL / LIMITES =====================
async function getFreeUsed(waId) {
  const v = await redisGet(kFreeUsed(waId));
  return Number(v || 0);
}
async function incFreeUsed(waId) {
  const v = await redisIncr(kFreeUsed(waId));
  return Number(v || 0);
}

function currentMonthKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function getPlanCode(waId) {
  return (await redisGet(kPlan(waId))) || "";
}
async function setPlanCode(waId, code) {
  await redisSet(kPlan(waId), code || "");
}
function findPlanByCode(code) {
  return Object.values(PLANS).find((p) => p.code === code) || null;
}

async function getQuotaUsed(waId) {
  const v = await redisGet(kQuotaUsed(waId));
  return Number(v || 0);
}
async function setQuotaUsed(waId, n) {
  await redisSet(kQuotaUsed(waId), String(Number(n || 0)));
}
async function incQuotaUsed(waId) {
  const v = await redisIncr(kQuotaUsed(waId));
  return Number(v || 0);
}
async function getQuotaMonth(waId) {
  return (await redisGet(kQuotaMonth(waId))) || "";
}
async function setQuotaMonth(waId, ym) {
  await redisSet(kQuotaMonth(waId), ym);
}

async function getPixValidUntil(waId) {
  const v = await redisGet(kPixValidUntil(waId));
  return Number(v || 0);
}
async function setPixValidUntil(waId, msEpoch) {
  await redisSet(kPixValidUntil(waId), String(Number(msEpoch || 0)));
}
async function clearPixValidUntil(waId) {
  await redisDel(kPixValidUntil(waId));
}

async function isActiveByPix(waId) {
  const until = await getPixValidUntil(waId);
  return until ? Date.now() < until : false;
}

async function canUseByPlanNow(waId) {
  const planCode = await getPlanCode(waId);
  if (!planCode) return false;

  const subId = await redisGet(kAsaasSubscriptionId(waId));
  if (subId) {
    const active = await isAsaasSubscriptionActive(subId);
    if (!active) return false;
  } else {
    const ok = await isActiveByPix(waId);
    if (!ok) return false;
  }

  const ym = currentMonthKey();
  const savedYm = await getQuotaMonth(waId);
  if (savedYm !== ym) {
    await setQuotaMonth(waId, ym);
    await setQuotaUsed(waId, 0);
  }

  const plan = findPlanByCode(planCode);
  if (!plan) return false;

  const used = await getQuotaUsed(waId);
  return used < plan.quotaMonthly;
}

async function consumeOneDescriptionOrBlock(waId) {
  const planCode = await getPlanCode(waId);
  if (planCode) {
    const can = await canUseByPlanNow(waId);
    if (!can) return false;
    await incQuotaUsed(waId);
    return true;
  }

  const used = await getFreeUsed(waId);
  if (used >= FREE_DESCRIPTIONS_LIMIT) return false;
  await incFreeUsed(waId);
  return true;
}

// ===================== DRAFT / REFINO =====================
async function getDraft(waId) {
  const raw = await redisGet(kDraft(waId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function setDraft(waId, obj) {
  await redisSet(kDraft(waId), JSON.stringify(obj || {}));
}
async function clearDraft(waId) { await redisDel(kDraft(waId)); }

async function getLastDescription(waId) {
  return (await redisGet(kLastDesc(waId))) || "";
}
async function setLastDescription(waId, text) {
  await redisSet(kLastDesc(waId), String(text || ""));
}
async function clearLastDescription(waId) { await redisDel(kLastDesc(waId)); }

async function getLastInput(waId) { return (await redisGet(kLastInput(waId))) || ""; }
async function setLastInput(waId, text) { await redisSet(kLastInput(waId), String(text || "")); }
async function clearLastInput(waId) { await redisDel(kLastInput(waId)); }

async function getRefineCount(waId) {
  const v = await redisGet(kRefineCount(waId));
  return Number(v || 0);
}
async function setRefineCount(waId, n) {
  await redisSet(kRefineCount(waId), String(Number(n || 0)));
}
async function clearRefineCount(waId) { await redisDel(kRefineCount(waId)); }

function mergeDraftFromMessage(prev, text) {
  const t = String(text || "").trim();
  const draft = prev ? { ...prev } : {};
  if (!draft.raw) draft.raw = [];
  draft.raw.push(t);
  return draft;
}
function draftToUserText(draft) {
  if (!draft) return "";
  return Array.isArray(draft.raw) ? draft.raw.join(" | ") : "";
}

function looksLikeRefinement(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const low = t.toLowerCase();

  if (isOkToFinish(t) || isPositiveFeedbackLegacy(t)) return false;

  const keywords = [
    "mais emoji", "emoji",
    "muda o titulo", "mude o titulo", "muda o título", "mude o título",
    "título", "titulo",
    "mais emocional", "emocional",
    "mais técnico", "mais tecnico", "técnico", "tecnico",
    "mais curto", "mais longo", "encurte", "aumente",
    "melhore", "ajuste", "refaça", "refaca",
    "troque", "substitua", "mude", "coloque", "retire", "remova", "inclua",
    "orçamento", "orcamento",
    "agende", "agendar", "horário", "horario",
    "consulte"
  ];
  if (keywords.some((k) => low.includes(k))) return true;

  if (t.length <= 120) return true;

  return false;
}

function looksLikeAdditionalInfo(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const low = t.toLowerCase();

  if (/(r\$\s*\d+)|(\d+\s*reais)/i.test(t)) return true;
  if (low.includes("preço") || low.includes("preco") || low.includes("valor")) return true;

  const k = [
    "sabor", "sabores", "tamanho", "tamanhos", "peso", "gramas", "kg", "ml", "litro",
    "entrega", "retirada", "cidade", "bairro", "região", "regiao",
    "atendo", "atendimento",
    "horário", "horario", "agendar", "agenda",
    "disponível", "disponivel"
  ];
  return k.some((x) => low.includes(x));
}

function isOkToFinish(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "ok" || t === "ok." || t === "okay" || t === "ok✅" || t === "ok ✅";
}
function isPositiveFeedbackLegacy(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["sim", "gostei", "perfeito", "ótimo", "otimo", "top", "show", "fechado"].includes(t);
}

function extractImprovementInstruction(text) {
  let t = String(text || "").trim();
  if (!t) return "";

  t = t.replace(/^((não\s+gostei|nao\s+gostei)\s*(do|da|de)?\s*)/i, "");
  t = t.replace(/^(melhore|melhorar|ajuste|ajustar|refaça|refaca|refazer|troque|substitua|mude|coloque)\s*[:\-]?\s*/i, "");
  // Se ficar algum "*" solto (WhatsApp exige pares para negrito), remove o último para balancear.
  while (((t.match(/\*/g) || []).length % 2) === 1) {
    const idx = t.lastIndexOf("*");
    if (idx === -1) break;
    t = t.slice(0, idx) + t.slice(idx + 1);
  }

  return t.trim();
}

// ===================== PREFERÊNCIAS & CONDIÇÕES (EXTRAÇÃO) =====================
function normalizeDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}
function formatBRPhoneToE164(raw) {
  const d = normalizeDigits(raw);
  if (!d) return "";
  // Já veio com 55 + DDD + número
  if (d.length === 13 && d.startsWith("55")) return d;
  // DDD + número (10 ou 11)
  if (d.length === 10 || d.length === 11) return `55${d}`;
  // Sem DDD (evitar chutar demais)
  return "";
}
function extractConditionsFromText(t) {
  const text = String(t || "");

  // telefone: tenta pegar qualquer número "de contato"
  const phoneMatches = text.match(/(\+?55\s*)?(\(?\d{2}\)?\s*)?9?\d{4}\-?\d{4}/g) || [];
  let phone = "";
  for (const m of phoneMatches) {
    const f = formatBRPhoneToE164(m);
    if (f) { phone = f; break; }
  }

  // instagram / site
  const ig = (text.match(/@([a-zA-Z0-9._]{3,})/g) || [])[0] || "";
  const site = (text.match(/\bhttps?:\/\/[^\s]+/i) || [])[0] || "";

  // preço
  const price = (text.match(/R\$\s*\d[\d\.\,]*/i) || [])[0] || "";

  // horário: pega a linha/frase com palavras-chave
  let hours = "";
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const hourLine = lines.find((l) =>
    /hor[aá]rio|atendimento|das\s+\d|às\s+\d|\d{1,2}\s*h|\bseg\b|\bsegunda\b|\bs[aá]bado\b|\bdom\b/i.test(l)
  );
  if (hourLine) hours = hourLine;

  // endereço/local: linha com rua/av/bairro/cidade/cep
  let address = "";
  const addrLine = lines.find((l) =>
    /\bru?a\b|\bav\.?\b|\bavenida\b|\btravessa\b|\bbairro\b|\bcep\b|\bcidade\b|\bn[ºo]\b/i.test(l)
  );
  if (addrLine) address = addrLine;

  // Se não achou em linhas, tenta por trechos
  if (!address) {
    const m = text.match(/(rua|av\.?|avenida|travessa|alameda)[^\n]{6,}/i);
    if (m) address = m[0].trim();
  }

  const out = {};
  if (phone) out.phone = phone;
  if (address) out.address = address;
  if (hours) out.hours = hours;
  if (price) out.price = price;
  if (ig) out.instagram = ig;
  if (site) out.website = site;

  return out;
}

function conditionsKeyOrder() {
  return [
    { key: "phone", label: "Telefone" },
    { key: "address", label: "Endereço / Local" },
    { key: "hours", label: "Horário" },
    { key: "price", label: "Valor / Preço" },
    { key: "instagram", label: "Instagram" },
    { key: "website", label: "Site / Link" },
  ];
}

function buildSaveConditionsPrompt(pending) {
  const items = [];
  const order = conditionsKeyOrder();
  for (let i = 0; i < order.length; i++) {
    const { key, label } = order[i];
    if (pending && pending[key]) {
      items.push({ n: items.length + 1, key, label, value: String(pending[key]).trim() });
    }
  }

  if (!items.length) {
    return `📌 Não encontrei dados claros (telefone/endereço/horário/valor/links) para salvar agora.`;
  }

  const lines = items.map((it) => `${it.n}) ${it.label}: ${it.value}`).join("\n");

  return `📌 Identifiquei estas informações na sua mensagem:\n\n${lines}\n\nQuer que eu salve alguma delas para usar automaticamente nas próximas descrições?\n\n✅ Para salvar *todas*, responda: *tudo*\n✅ Para salvar apenas algumas, responda com os números separados por espaço (ex.: *1 3 4*)\n🚫 Para não salvar nada, responda: *0*`;
}

function pickConditionsByNumbers(pending, numbers) {
  const order = conditionsKeyOrder();
  const presentKeys = order.map((o) => o.key).filter((k) => pending && pending[k]);
  // Mapeia números 1..N apenas para os itens presentes
  const selected = {};
  const valid = new Set();
  presentKeys.forEach((k, idx) => valid.add(idx + 1));
  const uniq = Array.from(new Set(numbers)).filter((n) => valid.has(n));
  for (const n of uniq) {
    const key = presentKeys[n - 1];
    if (key && pending[key]) selected[key] = pending[key];
  }
  return selected;
}

function hasAnyKeys(obj) {
  return obj && typeof obj === "object" && Object.keys(obj).length > 0;
}

function detectPrefsUpdate(messageText) {
  const raw = String(messageText || "");
  const t = raw.toLowerCase();

  const overrides = {};
  let wantsPersist = false;
  let wantsReset = false;

  // Intenção de persistência ("use isso daqui pra frente", "sempre", etc.)
  if (/(daqui\s+pra\s+frente|a\s+partir\s+de\s+agora|sempre|para\s+as\s+pr[oó]ximas|nas\s+pr[oó]ximas|mantenha\s+isso|guarda\s+isso|salve\s+isso|deixe\s+assim)/i.test(t)) {
    wantsPersist = true;
  }

  // Intenção de voltar ao modelo base
  if (/(voltar\s+ao\s+padr[aã]o|voltar\s+ao\s+modelo\s+base|voltar\s+ao\s+projeto\s+base|pode\s+voltar\s+ao\s+normal|usar\s+o\s+padr[aã]o\s+do\s+projeto|resetar\s+formata[cç][aã]o|remover\s+prefer[eê]ncias\s+de\s+formata[cç][aã]o)/i.test(t)) {
    wantsReset = true;
  }

  // Emojis (geral)
  if (/(sem\s+emoji|sem\s+emojis|retire\s+todos\s+os\s+emojis|tira\s+os\s+emojis|n[aã]o\s+use\s+emoji|sem\s+figurinhas?\s+no\s+texto)/i.test(t)) {
    overrides.allowEmojis = false;
    overrides.allowConditionIcons = false;
  }
  if (/(pode\s+usar\s+emojis|com\s+emojis|use\s+emojis)/i.test(t)) {
    overrides.allowEmojis = true;
  }

  // Bullets / lista
  if (/(sem\s+bullets?|sem\s+lista|sem\s+t[oó]picos|tira\s+bullets?|remover\s+bullets?|sem\s+itens)/i.test(t)) {
    overrides.allowBullets = false;
  }
  if (/(pode\s+usar\s+bullets?|coloque\s+bullets?|com\s+bullets?|pode\s+usar\s+lista)/i.test(t)) {
    overrides.allowBullets = true;
  }

  // Condições
  if (/(sem\s+condi[cç][oõ]es|tira\s+condi[cç][oõ]es|remover\s+condi[cç][oõ]es|sem\s+local\s+pre[cç]o\s+hor[aá]rio)/i.test(t)) {
    overrides.allowConditionsBlock = false;
  }
  if (/(pode\s+colocar\s+condi[cç][oõ]es|com\s+condi[cç][oõ]es|inclua\s+local\s+pre[cç]o\s+hor[aá]rio)/i.test(t)) {
    overrides.allowConditionsBlock = true;
  }

  // Ícones das condições (📍💰🕒) — só faz sentido se emojis estiverem liberados
  if (/(sem\s+📍|sem\s+💰|sem\s+🕒|sem\s+icones?\s+de\s+condi[cç][oõ]es|sem\s+emojis?\s+nas\s+condi[cç][oõ]es)/i.test(t)) {
    overrides.allowConditionIcons = false;
  }
  if (/(com\s+📍|com\s+💰|com\s+🕒|pode\s+usar\s+icones?\s+nas\s+condi[cç][oõ]es)/i.test(t)) {
    overrides.allowConditionIcons = true;
  }

  // Negrito
  if (/(sem\s+negrito|tira\s+o\s+negrito|retire\s+o\s+negrito|sem\s+asteriscos|n[aã]o\s+use\s+\*|n[aã]o\s+use\s+formata[cç][aã]o)/i.test(t)) {
    overrides.allowBold = false;
    overrides.forceAllBold = false;
  }
  if (/(tudo\s+em\s+negrito|deixe\s+tudo\s+em\s+negrito|coloque\s+tudo\s+em\s+negrito)/i.test(t)) {
    overrides.allowBold = true;
    overrides.forceAllBold = true;
  }
  if (/(pode\s+usar\s+negrito|use\s+negrito)/i.test(t)) {
    overrides.allowBold = true;
  }

  // Texto corrido / sem tabulação / um parágrafo
  if (/(tudo\s+corrido|texto\s+corrido|sem\s+tabula[cç][aã]o|sem\s+quebra\s+de\s+linha|um\s+par[aá]grafo|em\s+um\s+par[aá]grafo\s+s[oó])/i.test(t)) {
    overrides.oneParagraph = true;
    // se pediu 1 parágrafo, geralmente não quer bullets
    if (!("allowBullets" in overrides)) overrides.allowBullets = false;
  }
  if (/(pode\s+quebrar\s+linha|com\s+quebras\s+de\s+linha|pode\s+ser\s+em\s+blocos)/i.test(t)) {
    overrides.oneParagraph = false;
  }

  // Formato tabela
  if (/(em\s+forma\s+de\s+tabela|formato\s+tabela|coloque\s+em\s+tabela)/i.test(t)) {
    overrides.tableLayout = true;
    overrides.oneParagraph = false;
  }
  if (/(n[aã]o\s+precisa\s+de\s+tabela|sem\s+tabela)/i.test(t)) {
    overrides.tableLayout = false;
  }

  // Texto puro (sem emojis, sem negrito, sem bullets)
  if (/(texto\s+puro|sem\s+formata[cç][aã]o\s+nenhuma|sem\s+formata[cç][aã]o|sem\s+markdown)/i.test(t)) {
    overrides.plainText = true;
    overrides.allowEmojis = false;
    overrides.allowBold = false;
    overrides.allowConditionIcons = false;
    overrides.allowBullets = false;
  }
  if (/(pode\s+usar\s+formata[cç][aã]o|voltar\s+com\s+formata[cç][aã]o)/i.test(t)) {
    overrides.plainText = false;
  }

  const hasStructural = Object.keys(overrides).length > 0 || wantsReset;

  return { overrides, wantsPersist, wantsReset, hasStructural };
}
function detectRemoveSavedConditionsFields(messageText) {
  const t = String(messageText || "").toLowerCase();
  const fields = [];
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(telefone|celular|contato)/i.test(t)) fields.push("phone");
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(endere[cç]o|local|rua|bairro)/i.test(t)) fields.push("address");
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(hor[aá]rio|horarios|atendimento)/i.test(t)) fields.push("hours");
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(pre[cç]o|valor|valores|R\$)/i.test(t)) fields.push("price");
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(instagram|@)/i.test(t)) fields.push("instagram");
  if (/(tira|remova|n[aã]o\s+use|n[aã]o\s+coloque).*(site|link|https?:\/\/)/i.test(t)) fields.push("website");
  return [...new Set(fields)];
}

function askFeedbackText() {
  return `💬 Quer que eu deixe ainda mais a sua cara?

Me diga o que você quer ajustar (ex.: mais emoji, mudar o título, mais emocional, mais curto, mais técnico).

Se estiver tudo certinho, me manda um OK ✅`;
}

// ===================== WHATSAPP SEND =====================
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    safeLogError("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID no Render.", { message: "Env vars ausentes" });
    return;
  }

  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    safeLogError("Erro ao enviar mensagem:", { message: `${resp.status} ${JSON.stringify(data)}` });
  }
}

// ===================== OPENAI =====================
function sanitizeWhatsAppMarkdown(text) {
  let t = String(text || "");

  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");
  t = t.replace(/\*\s+\*/g, "*");
  t = t.replace(/\*{3,}/g, "*");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/\*(Preço|Preco|Valor)\:\*\s*\*/gi, "*$1:* ");
  t = t.replace(/\*\s*(R\$)/g, "$1");
  t = t.replace(/(R\$\s*\d[^\n]*)\*/g, "$1");

  return t.trim();
}


function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

async function openaiFetchWithRetry(url, options) {
  const attempts = Math.max(1, OPENAI_RETRY_MAX_ATTEMPTS || 1);
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      // timeout simples por tentativa (25s)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const err = new Error(`OpenAI error: ${resp.status} ${body}`);
        err.status = resp.status;

        if (isRetryableStatus(resp.status) && i < attempts) {
          const delay = OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, i - 1);
          await sleep(delay);
          continue;
        }
        throw err;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      const status = Number(e?.status || 0);
      const isAbort = String(e?.name || "") === "AbortError";
      const retryable = isAbort || isRetryableStatus(status);
      if (retryable && i < attempts) {
        const delay = OPENAI_RETRY_BASE_DELAY_MS * Math.pow(2, i - 1);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("OpenAI fetch falhou.");
}


function stripEmojis(text) {
  // Remove caracteres de emoji (Extended_Pictographic) e variações
  let t = String(text || "");
  try {
    t = t.replace(/[\p{Extended_Pictographic}]/gu, "");
  } catch {
    // fallback simples (remove alguns emojis comuns)
    t = t.replace(/[📍💰🕒✅❌⭐️✨🔥😍😊😉😄😃😁😂🤣🙂🙌👍👎💡📌📣]/g, "");
  }
  // remove variation selectors e chars invisíveis comuns
  t = t.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  // limpa espaços duplicados
  t = t.replace(/[ \t]{2,}/g, " ").replace(/\n[ \t]+/g, "\n");
  return t.trim();
}

function stripBold(text) {
  let t = String(text || "");
  // remove marcações de negrito do WhatsApp (*texto*)
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/\*/g, "");
  return t;
}

function toOneParagraph(text) {
  let t = String(text || "").trim();
  // troca quebras por espaço
  t = t.replace(/\s*\n\s*/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ");
  return t.trim();
}

function stripBullets(text) {
  let t = String(text || "");
  // remove bullets comuns no começo da linha
  t = t.replace(/^\s*[•\-–—]\s+/gm, "");
  t = t.replace(/^\s*\d+[\)\.]\s+/gm, "");
  return t;
}

function normalizeConditionsIcons(text) {
  let t = String(text || "");
  // troca ícones por labels
  t = t.replace(/📍\s*/g, "Local: ");
  t = t.replace(/💰\s*/g, "Preço: ");
  t = t.replace(/🕒\s*/g, "Horário: ");
  return t;
}

function applyFormattingEnforcement(text, formatting) {
  const fmt = formatting || {};

  const clip = (s, max) => {
    const t = String(s || "");
    return t.length > max ? (t.slice(0, max) + "…") : t;
  };
  let t = String(text || "");

  if (fmt.plainText) {
    // texto puro: sem emojis, sem negrito, sem bullets
    t = stripEmojis(t);
    t = stripBold(t);
    t = stripBullets(t);
    t = normalizeConditionsIcons(t);
    // remove pipes excessivos de tabela se não solicitado
    t = t.replace(/\|{2,}/g, "|");
    return t.trim();
  }

  if (fmt.allowEmojis === false) {
    t = stripEmojis(t);
    // se pediu sem emojis, também normaliza os ícones para texto (se existirem)
    t = normalizeConditionsIcons(t);
  } else if (fmt.allowConditionIcons === false) {
    t = normalizeConditionsIcons(t);
  }

  if (fmt.allowBold === false) {
    t = stripBold(t);
  }

  if (fmt.allowBullets === false) {
    t = stripBullets(t);
  }

  if (fmt.oneParagraph) {
    t = stripBullets(t);
    t = toOneParagraph(t);
  }

  if (fmt.forceAllBold && fmt.allowBold !== false) {
    // coloca tudo em negrito com um par de asteriscos
    t = stripBold(t);
    t = `*${t}*`;
  }

  return t.trim();
}


async function openaiGenerateDescription({ baseUserText, previousDescription, instruction, fullName, prefs, savedConditions, styleAnchor, formatting }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente.");

  const fmt = formatting || {};

  // Regras de estrutura base do projeto (serão adaptadas por fmt)
  const structureLines = [];

  if (fmt.plainText) {
    structureLines.push("- Entregue em TEXTO PURO: sem emojis, sem negrito (sem *), sem markdown e sem bullets.");
  } else {
    if (fmt.allowBold) {
      structureLines.push("- Use negrito (*...*) com moderação, a menos que o usuário peça diferente.");
    } else {
      structureLines.push("- NÃO use negrito, NÃO use asteriscos (*).");
    }

    if (fmt.allowEmojis) {
      structureLines.push('- Se fizer sentido, pode usar emojis com parcimônia (3 a 6), mas SEM exageros.');
      structureLines.push('- Título na 1ª linha pode ter 1 emoji no início, se não houver pedido contrário.');
    } else {
      structureLines.push("- NÃO use nenhum emoji ou símbolo gráfico do tipo emoji.");
      structureLines.push("- Título na 1ª linha SEM emoji.");
    }

    if (fmt.tableLayout) {
      structureLines.push("- Entregue em formato de tabela de texto simples usando '|' (sem markdown complexo), com linhas curtas.");
    } else if (fmt.oneParagraph) {
      structureLines.push("- Entregue tudo em UM ÚNICO PARÁGRAFO (texto corrido), sem listas e sem quebras de linha.");
    } else {
      // Layout padrão escaneável
      structureLines.push("- Estrutura preferida (quando aplicável):");
      structureLines.push("  1) Título");
      structureLines.push("  2) Linha em branco");
      structureLines.push("  3) Proposta de valor (até 2 linhas)");
      if (fmt.allowBullets) {
        structureLines.push("  4) Até 3 itens (bullets) SE fizer sentido (não é obrigatório).");
      } else {
        structureLines.push("  4) NÃO use bullets/listas.");
      }
      structureLines.push("  5) Impulso de venda");
      if (fmt.allowConditionsBlock) {
        structureLines.push("  6) Condições neutras (Local/Preço/Horário) apenas se houver dados ou se fizer sentido.");
        if (fmt.allowEmojis && fmt.allowConditionIcons) {
          structureLines.push("     Pode usar ícones 📍 💰 🕒 nas condições.");
        } else {
          structureLines.push("     Não use ícones nas condições; use 'Local:', 'Preço:', 'Horário:'.");
        }
      } else {
        structureLines.push("  6) NÃO inclua bloco de condições.");
      }
      structureLines.push("  7) CTA final adequado ao segmento.");
    }
  }

  // Âncora de estilo: quando houver, peça para manter o mesmo padrão (sem copiar texto)
  const styleHint = styleAnchor ? `
PADRÃO APROVADO (ÂNCORA): use como referência de estrutura/tom/ritmo, sem copiar literalmente:
---
${clip(styleAnchor, 1800)}
---
` : "";

  const system = `
Você é o "Amigo das Vendas": cria anúncios prontos para WhatsApp (curtos, escaneáveis e vendáveis).

ENTREGA
- Entregue SOMENTE o anúncio final. Sem explicações, sem rascunhos e sem títulos extras.
- Nunca invente informações. Se faltar algo (local, preço, prazo, entrega, horários, etc.), use termos neutros:
  "sob consulta", "a combinar", "conforme disponibilidade", "valores sob consulta", "atendimento sob consulta".

PRIORIDADE ABSOLUTA
- A solicitação explícita do usuário sempre vence quaisquer regras internas.
- Se o usuário pedir "sem emojis", "texto corrido", "sem negrito", "em tabela", etc., obedeça integralmente.

REGRAS DE FORMATAÇÃO (DINÂMICAS)
${structureLines.join("\n")}

REGRAS INTELIGENTES
- Produto físico: pode usar "Consulte valores" (se não houver preço).
- Serviço com agendamento: prefira "Agende seu horário".
- Serviço técnico: prefira "Solicite seu orçamento".
- Nunca usar "Consulte entrega" para serviços.
`;

  const user = `
DADOS DO USUÁRIO
- Nome completo: ${fullName || "não informado"}

PREFERÊNCIAS DO USUÁRIO (GERAIS)
${JSON.stringify(prefs || {}, null, 2)}

CONDIÇÕES SALVAS (SE HOUVER)
${JSON.stringify(savedConditions || {}, null, 2)}

CONTEXTO / PEDIDO
- O que o usuário vende / presta: ${clip(baseUserText, 1800)}
- Instrução atual do usuário (refinamento/pedido): ${clip(instruction, 1200)}
- Descrição anterior (se houver): ${clip(previousDescription, 2200)}

${styleHint}
`;

  // OpenAI Responses API
  const payload = {
    model: OPENAI_MODEL,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }
  const data = await res.json();

  // Extrai texto
  let out = "";
  if (data.output_text) out = data.output_text;
  if (!out && Array.isArray(data.output)) {
    // fallback (caso output_text não exista)
    const chunks = [];
    for (const o of data.output) {
      if (o?.content) {
        for (const c of o.content) {
          if (c?.type === "output_text" && c.text) chunks.push(c.text);
          if (c?.type === "text" && c.text) chunks.push(c.text);
        }
      }
    }
    out = chunks.join("\n").trim();
  }

  return String(out || "").trim();
}

async function asaasFetch(path, method, bodyObj) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY ausente.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      access_token: ASAAS_API_KEY,
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
  }
  if (data && typeof data === "object" && Array.isArray(data.errors) && data.errors.length) {
    throw new Error(`Asaas: retornou errors no body.`);
  }
  return data;
}


async function isAsaasSubscriptionActive(subId) {
  const id = String(subId || "").trim();
  if (!id) return false;

  // cache por 10 minutos para não bater no Asaas o tempo todo
  const CACHE_TTL_SECONDS = 600;

  const lastAt = Number((await redisGet(kAsaasSubActiveCacheAt(id))) || 0);
  const cached = (await redisGet(kAsaasSubActiveCache(id))) || "";
  if (cached && lastAt && (Date.now() - lastAt) < (CACHE_TTL_SECONDS * 1000)) {
    return cached === "1";
  }

  try {
    const sub = await asaasFetch(`/v3/subscriptions/${encodeURIComponent(id)}`, "GET");
    // Status esperados (Asaas): ACTIVE / INACTIVE / CANCELED etc.
    const st = String(sub?.status || "").toUpperCase();
    const ok = st === "ACTIVE";
    await redisSetEx(kAsaasSubActiveCache(id), ok ? "1" : "0", CACHE_TTL_SECONDS);
    await redisSetEx(kAsaasSubActiveCacheAt(id), String(Date.now()), CACHE_TTL_SECONDS);
    return ok;
  } catch (e) {
    safeLogError("Asaas subscription status falhou:", e);
    // Em caso de erro, seja conservador (não libera uso) para não dar custo sem receber
    await redisSetEx(kAsaasSubActiveCache(id), "0", CACHE_TTL_SECONDS);
    await redisSetEx(kAsaasSubActiveCacheAt(id), String(Date.now()), CACHE_TTL_SECONDS);
    return false;
  }
}


async function findCustomerByCpfCnpj(doc) {
  const q = encodeURIComponent(doc);
  const data = await asaasFetch(`/v3/customers?cpfCnpj=${q}`, "GET");
  const list = Array.isArray(data?.data) ? data.data : [];
  if (list.length > 0 && list[0]?.id) return String(list[0].id);
  return "";
}

async function findOrCreateAsaasCustomer({ waId, name, doc }) {
  const cached = await redisGet(kAsaasCustomerId(waId));
  if (cached) return cached;

  let created = null;
  try {
    created = await asaasFetch("/v3/customers", "POST", {
      name,
      cpfCnpj: doc,
      externalReference: waId,
    });
  } catch (e) {
    safeLogError("Asaas create customer falhou (tentando buscar):", e);
  }

  let customerId = created?.id ? String(created.id) : "";

  if (!customerId) {
    try {
      const found = await findCustomerByCpfCnpj(doc);
      if (found) customerId = found;
    } catch (e) {
      safeLogError("Asaas search customer falhou:", e);
    }
  }

  if (!customerId) throw new Error("Asaas: customerId não retornou.");

  await redisSet(kAsaasCustomerId(waId), customerId);
  await redisSet(kAsaasCustomerToWa(customerId), waId);
  return customerId;
}

async function createCardSubscription({ waId, plan }) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);
  if (!name) throw new Error("Nome ausente.");
  if (!doc) throw new Error("CPF/CNPJ ausente.");

  const customerId = await findOrCreateAsaasCustomer({ waId, name, doc });

  // Para cobrança recorrente por cartão, criamos a assinatura e enviamos a invoiceUrl
  // da primeira cobrança gerada (o cliente informa os dados do cartão na interface do Asaas).
  const sub = await asaasFetch("/v3/subscriptions", "POST", {
    customer: customerId,
    billingType: "CREDIT_CARD",
    nextDueDate: new Date().toISOString().slice(0, 10),
    value: plan.price,
    cycle: "MONTHLY",
    description: `Amigo das Vendas - Plano ${plan.name}`,
  });

  const subId = sub?.id ? String(sub.id) : "";
  if (!subId) throw new Error("Asaas: subscription id não retornou.");

  await redisSet(kAsaasSubToWa(subId), waId);

  // Buscar as cobranças geradas para obter invoiceUrl (checkout do cartão)
  let invoiceUrl = "";
  try {
    const pays = await asaasFetch(`/v3/subscriptions/${subId}/payments`, "GET");
    const first = Array.isArray(pays?.data) && pays.data.length ? pays.data[0] : null;

    const payId = first?.id ? String(first.id) : "";
    if (payId) await redisSet(kAsaasPaymentToWa(payId), waId);

    invoiceUrl = first?.invoiceUrl ? String(first.invoiceUrl) : "";
  } catch (e) {
    safeLogError("Asaas subscriptions/{id}/payments falhou:", e);
  }

  if (!invoiceUrl) {
    // fallback (algumas respostas podem vir com url em campos diferentes)
    invoiceUrl = sub?.invoiceUrl || sub?.paymentLink || sub?.url || "";
  }

  return { subscriptionId: subId, invoiceUrl };
}

async function createPixPayment({ waId, plan }) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);
  if (!name) throw new Error("Nome ausente.");
  if (!doc) throw new Error("CPF/CNPJ ausente.");

  const customerId = await findOrCreateAsaasCustomer({ waId, name, doc });

  const due = new Date();
  due.setDate(due.getDate() + 1);
  const dueDate = due.toISOString().slice(0, 10);

  const payment = await asaasFetch("/v3/payments", "POST", {
    customer: customerId,
    billingType: "PIX",
    dueDate,
    value: plan.price,
    description: `Amigo das Vendas - Plano ${plan.name} (PIX)`,
  });

  const payId = payment?.id ? String(payment.id) : "";
  if (!payId) throw new Error("Asaas: payment id não retornou.");

  await redisSet(kAsaasPaymentToWa(payId), waId);

  const pix = await asaasFetch(`/v3/payments/${payId}/pixQrCode`, "GET");
  const link = payment?.invoiceUrl || pix?.payload || "";
  return { paymentId: payId, link, invoiceUrl: payment?.invoiceUrl || "" };
}

// ===================== PENDÊNCIA DE PAGAMENTO =====================
async function clearPendingPayment(waId) {
  await redisDel(kPendingPlan(waId));
  await redisDel(kPendingMethod(waId));
  await redisDel(kPendingPaymentId(waId));
  await redisDel(kPendingSubId(waId));
  await redisDel(kPendingCreatedAt(waId));
}

async function setPendingPayment({ waId, planCode, method, paymentId, subId }) {
  await redisSetEx(kPendingPlan(waId), planCode || "", PENDING_PAYMENT_TTL_SECONDS);
  await redisSetEx(kPendingMethod(waId), method || "", PENDING_PAYMENT_TTL_SECONDS);
  if (paymentId) await redisSetEx(kPendingPaymentId(waId), paymentId, PENDING_PAYMENT_TTL_SECONDS);
  if (subId) await redisSetEx(kPendingSubId(waId), subId, PENDING_PAYMENT_TTL_SECONDS);
  await redisSetEx(kPendingCreatedAt(waId), String(Date.now()), PENDING_PAYMENT_TTL_SECONDS);
}

async function isPendingPaymentExpired(waId) {
  const at = Number((await redisGet(kPendingCreatedAt(waId))) || 0);
  if (!at) return false;
  return Date.now() - at > PENDING_PAYMENT_TTL_SECONDS * 1000;
}

async function expirePendingPaymentIfNeeded(waId) {
  const status = await getStatus(waId);
  if (status !== "PAYMENT_PENDING") return false;

  const expired = await isPendingPaymentExpired(waId);
  if (!expired) return false;

  // Expirou: limpa pendência e orienta o usuário a gerar novo pagamento
  await clearPendingPayment(waId);
  await setStatus(waId, "WAIT_PLAN");

  await sendWhatsAppText(
    waId,
    `⏳ Seu pagamento ficou pendente por mais de 48h e o link expirou.

Vamos gerar um novo rapidinho 🙂`
  );
  await sendWhatsAppText(waId, plansMenuText());
  return true;
}

async function activatePlanAfterPayment({ waId, planCode, method, subscriptionId }) {
  const plan = findPlanByCode(planCode);
  if (!plan) return false;

  await setPlanCode(waId, plan.code);
  await setQuotaMonth(waId, currentMonthKey());
  await setQuotaUsed(waId, 0);

  if (method === "PIX") {
    const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setPixValidUntil(waId, validUntil);
    await redisDel(kAsaasSubscriptionId(waId));
  }

  if (method === "CARD") {
    if (subscriptionId) await redisSet(kAsaasSubscriptionId(waId), subscriptionId);
    await clearPixValidUntil(waId);
  }

  await clearPendingPayment(waId);
  await setStatus(waId, "ACTIVE");

  await sendWhatsAppText(waId, `✅ Pagamento confirmado!\nPlano ativado: *${plan.name}* 🎉`);
  await sendWhatsAppText(waId, "Agora é só me mandar o que você vende/serviço que oferece 🙂");
  return true;
}

// ===================== WEBHOOK ASAAS =====================
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (ASAAS_WEBHOOK_TOKEN) {
      const token = req.header("asaas-access-token") || req.header("Authorization") || "";
      if (!token || !token.includes(ASAAS_WEBHOOK_TOKEN)) return;
    }

    const payload = req.body || {};
    const event = String(payload?.event || "").trim();

    const allowedEvents = new Set([
      "PAYMENT_CONFIRMED",
      "PAYMENT_RECEIVED",
      "PAYMENT_APPROVED",
    ]);
    if (!allowedEvents.has(event)) return;

    const paymentId = payload?.payment?.id ? String(payload.payment.id) : "";
    const subscriptionId = payload?.payment?.subscription ? String(payload.payment.subscription) : "";
    const customerId = payload?.payment?.customer ? String(payload.payment.customer) : "";

    let waId = "";
    if (paymentId) waId = (await redisGet(kAsaasPaymentToWa(paymentId))) || "";
    if (!waId && subscriptionId) waId = (await redisGet(kAsaasSubToWa(subscriptionId))) || "";
    if (!waId && customerId) waId = (await redisGet(kAsaasCustomerToWa(customerId))) || "";

    if (!waId) return;

    const pendingPlanCode = (await redisGet(kPendingPlan(waId))) || "";
    const pendingMethod = (await redisGet(kPendingMethod(waId))) || "";
    const pendingPaymentId = (await redisGet(kPendingPaymentId(waId))) || "";
    const pendingSubId = (await redisGet(kPendingSubId(waId))) || "";

    if (!pendingPlanCode || !pendingMethod) return;

    if (pendingMethod === "PIX" && pendingPaymentId && paymentId && pendingPaymentId !== paymentId) return;
    if (pendingMethod === "CARD" && pendingSubId && subscriptionId && pendingSubId !== subscriptionId) return;

    await activatePlanAfterPayment({
      waId,
      planCode: pendingPlanCode,
      method: pendingMethod,
      subscriptionId: pendingMethod === "CARD" ? (subscriptionId || pendingSubId) : "",
    });

    return;
  } catch (e) {
    safeLogError("Erro webhook Asaas:", e);
  }
});

// ===================== MENUS =====================
function menuText() {
  return (
    "*MENU — Amigo das Vendas* 📌\n\n" +
    "1) Minha assinatura\n" +
    "2) Mudar plano\n" +
    "3) Cancelar plano (cartão)\n" +
    "4) Alterar nome\n" +
    "5) Alterar CPF/CNPJ\n" +
    "6) Ajuda\n\n" +
    "Responda com o número.\n" +
    "Se quiser sair do menu, é só mandar sua próxima descrição 🙂"
  );
}
function plansMenuText() {
  return (
    "*Escolha um plano* 👇\n\n" +
    `1) *${PLANS[1].name}* — R$ ${PLANS[1].price.toFixed(2)}\n   • ${PLANS[1].quotaMonthly} descrições/mês\n\n` +
    `2) *${PLANS[2].name}* — R$ ${PLANS[2].price.toFixed(2)}\n   • ${PLANS[2].quotaMonthly} descrições/mês\n\n` +
    `3) *${PLANS[3].name}* — R$ ${PLANS[3].price.toFixed(2)}\n   • ${PLANS[3].quotaMonthly} descrições/mês\n\n` +
    "Responda com 1, 2 ou 3."
  );
}
function paymentMethodText() {
  return `Perfeito 🙂
Assim que você escolher a forma de pagamento, eu já preparo tudinho pra gente continuar com as suas descrições sem parar. 💳

1) Cartão
2) Pix

Me responde com 1 ou 2 🙂`;
}
async function buildMySubscriptionText(waId) {
  const status = await getStatus(waId);
  if (status === "PAYMENT_PENDING") {
    const planCode = (await redisGet(kPendingPlan(waId))) || "";
    const method = (await redisGet(kPendingMethod(waId))) || "";
    const plan = findPlanByCode(planCode);
    return (
      "*Minha assinatura*\n\n" +
      "Status: *Aguardando confirmação de pagamento*\n" +
      `Plano escolhido: *${plan?.name || "—"}*\n` +
      `Forma: *${method === "PIX" ? "Pix" : method === "CARD" ? "Cartão" : "—"}*`
    );
  }

  const planCode = await getPlanCode(waId);
  if (!planCode) {
    const used = await getFreeUsed(waId);
    const left = Math.max(0, FREE_DESCRIPTIONS_LIMIT - used);
    return (
      "*Minha assinatura*\n\n" +
      "Você ainda não ativou um plano.\n\n" +
      `Grátis restantes: *${left}* de *${FREE_DESCRIPTIONS_LIMIT}*`
    );
  }

  const plan = findPlanByCode(planCode);
  const used = await getQuotaUsed(waId);

  let extra = "";
  const subId = await redisGet(kAsaasSubscriptionId(waId));
  if (!subId) {
    const until = await getPixValidUntil(waId);
    if (until) {
      const daysLeft = Math.max(0, Math.ceil((until - Date.now()) / (1000 * 60 * 60 * 24)));
      extra = `\nValidade (Pix): *${daysLeft} dia(s)* restantes`;
    }
  }

  return (
    "*Minha assinatura*\n\n" +
    `Plano: *${plan?.name || "—"}*\n` +
    `Uso no mês: *${used}* / *${plan?.quotaMonthly || "—"}*` +
    extra +
    `\n\nAjuda: ${HELP_URL}`
  );
}

// ===== menu return helpers (não trava no menu) =====
async function setMenuReturn(waId, status) {
  const cur = await redisGet(kMenuReturn(waId));
  if (!cur) await redisSet(kMenuReturn(waId), status);
}
async function popMenuReturn(waId) {
  const cur = await redisGet(kMenuReturn(waId));
  await redisDel(kMenuReturn(waId));
  return cur || "";
}
async function clearMenuReturn(waId) {
  await redisDel(kMenuReturn(waId));
}

async function sendTrialEndedFlow(waId) {
  // Fim do trial: mensagem + convite + planos
  await sendWhatsAppText(waId, "Aaa que pena 🥺\nSuas *5 descrições grátis* do teste já foram usadas — mas foi só o começo!");
  await sendWhatsAppText(
        waId,
        `Não fica triste 🥺🙂\nEssa nossa amizade só começou.\n\n" +
      "Você gostou das descrições que eu criei? Achou que ficou mais fácil divulgar, mais organizado e com cara mais vendável?\n\n" +
      "Então bora escolher como a gente vai continuar daqui pra frente: 👇`
      );

  await setStatus(waId, "WAIT_PLAN");
  await sendWhatsAppText(waId, plansMenuText());
}

// ===================== LIMPEZA (a cada ~1h) =====================
async function maybeCleanup() {
  if (!USE_UPSTASH) return;
  const last = Number((await redisGet(kCleanupTick())) || 0);
  const now = Date.now();
  if (now - last < 60 * 60 * 1000) return;
  await redisSet(kCleanupTick(), String(now));
}

// ===================== IDEMPOTÊNCIA =====================
async function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const key = kIdempotency(messageId);
  const seen = await redisGet(key);
  if (seen) return true;
  await redisSetEx(key, "1", IDEMPOTENCY_TTL_SECONDS);
  return false;
}

// ===================== HELPERS =====================
function isMenuCommand(text) {
  return String(text || "").trim().toLowerCase() === "menu";
}
function cleanDoc(text) {
  return String(text || "").replace(/\D/g, "");
}

// ===================== RESET (APENAS TESTE) =====================
async function resetTestNumber(waId) {
  // Segurança: só permite para o número de teste definido
  if (waId !== TEST_RESET_WAID) return false;

  // Captura ids para apagar índices reversos (se existirem)
  const customerId = (await redisGet(kAsaasCustomerId(waId))) || "";
  const subId = (await redisGet(kAsaasSubscriptionId(waId))) || "";
  const pendingPaymentId = (await redisGet(kPendingPaymentId(waId))) || "";
  const pendingSubId = (await redisGet(kPendingSubId(waId))) || "";

  const keysToDelete = [
    kStatus(waId),
    kUser(waId),

    kFreeUsed(waId),

    kPlan(waId),
    kQuotaUsed(waId),
    kQuotaMonth(waId),
    kPixValidUntil(waId),

    kAsaasCustomerId(waId),
    kAsaasSubscriptionId(waId),

    kPendingPlan(waId),
    kPendingMethod(waId),
    kPendingPaymentId(waId),
    kPendingSubId(waId),
    kPendingCreatedAt(waId),

    kDraft(waId),
    kLastDesc(waId),
    kLastInput(waId),
    kRefineCount(waId),

    kMenuReturn(waId),

    `tmp:planchoice:${waId}`,
    `tmp:paymethod:${waId}`,
  ];

  for (const k of keysToDelete) {
    try { await redisDel(k); } catch {}
  }

  // Apaga índices reversos do Asaas (se existirem)
  if (customerId) {
    try { await redisDel(kAsaasCustomerToWa(customerId)); } catch {}
  }
  if (subId) {
    try { await redisDel(kAsaasSubToWa(subId)); } catch {}
  }
  if (pendingPaymentId) {
    try { await redisDel(kAsaasPaymentToWa(pendingPaymentId)); } catch {}
  }
  if (pendingSubId) {
    try { await redisDel(kAsaasSubToWa(pendingSubId)); } catch {}
  }

  // Observação: NÃO apagamos idempotência (idemp:*) para não reprocessar mensagens antigas.
  return true;
}


// ===================== WEBHOOK (META EVENTS) =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    await maybeCleanup();

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();
    if (metaPhoneId === "123456123") return; // mock
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    const statuses = value?.statuses;
    if (statuses && statuses.length) return;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const waId = msg.from;
    if (!waId) return;

    if (await isDuplicateMessage(msg.id)) return;

    if (msg.type !== "text") {
      await sendWhatsAppText(
        waId,
        "Por enquanto eu respondo só texto 🙂\nMe mande em texto o que você está vendendo/serviço que oferece."
      );
      return;
    }

    let text = String(msg.text?.body || "").trim();
    if (!text) return;

    // Reset controlado (somente para o número de teste)
    if (TEST_RESET_COMMANDS.has(text.toLowerCase())) {
      const ok = await resetTestNumber(waId);
      if (ok) {
        await sendWhatsAppText(
          waId,
          "🧹 Reset concluído ✅\n\nSeu cadastro, plano e contadores foram zerados para teste.\n\nVamos começar do zero 🙂"
        );
        // Já vamos perguntar o nome agora, então o próximo input deve ser tratado como o valor do nome
        await setStatus(waId, "WAIT_NAME_VALUE");
        await sendWhatsAppText(waId, "Oi! 👋😊\nEu sou o Amigo das Vendas — pode me chamar de Amigo.\n\nVocê me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.\n\nAntes que eu esqueça 😄 qual é o seu nome completo?");
      } else {
        await sendWhatsAppText(waId, "Esse comando de reset está disponível apenas para o número de teste.");
      }
      return;
    }

    let status = await getStatus(waId);
    status = await normalizeOnboardingStatus(waId, status);

    // Expiração de pagamento pendente (48h)
    if (await expirePendingPaymentIfNeeded(waId)) return;


    // ===================== FORMATAÇÃO (prioridade do usuário) =====================
    // A mensagem atual pode conter pedidos estruturais (sem emojis, texto corrido, tabela, etc.).
    // Esses pedidos SEMPRE têm prioridade no anúncio atual.
    // Persistência: só salvamos como base se o usuário pedir explicitamente, ou se ele confirmar na pergunta antes da próxima descrição.

    // Se estivermos aguardando confirmação de estrutura, processa aqui
    if (status === "WAIT_STRUCT_CONFIRM") {
      const pendingS = await getPendingStruct(waId);
      const ans = text.trim().toLowerCase();
      const yes = ans === "1" || ans === "sim" || ans === "s" || ans === "manter" || ans === "salvar";
      const no = ans === "2" || ans === "nao" || ans === "não" || ans === "n" || ans === "voltar" || ans === "reset";

      if (!pendingS || (!yes && !no)) {
        await sendWhatsAppText(waId, `Responda com:\n1) Manter essas alterações como padrão\n2) Voltar ao modelo base do projeto`);
        return;
      }

      if (yes) {
        await setStructBasePrefs(waId, pendingS.patch || {});
      } else {
        await resetAllFormattingPrefs(waId);
      }

      // retoma o fluxo e processa o texto que estava "na fila"
      const queued = pendingS.queuedText || "";
      const returnStatus = pendingS.returnStatus || "ACTIVE";
      await clearPendingStruct(waId);
      await setStatus(waId, returnStatus);
      status = returnStatus;
      text = queued;
    }

    const fmtIntent = detectPrefsUpdate(text);

    // Reset explícito ao padrão do projeto
    if (fmtIntent.wantsReset) {
      await resetAllFormattingPrefs(waId);
    }

    // Se o usuário explicitou que quer manter daqui pra frente, salvamos como base imediatamente
    if (fmtIntent.wantsPersist && Object.keys(fmtIntent.overrides).length) {
      await setStructBasePrefs(waId, fmtIntent.overrides);
    }

    // Remoção explícita de dados salvos (ex.: "não use meu endereço") (ex.: "não use meu endereço")
    const removeFields = detectRemoveSavedConditionsFields(text);
    if (removeFields.length) {
      await clearSavedConditionsFields(waId, removeFields);
    }

    // ===================== CONFIRMAÇÃO DE SALVAR CONDIÇÕES =====================
    
    // ===================== CONFIRMAÇÃO GRANULAR DE SALVAR CONDIÇÕES =====================
    if (status === "WAIT_SAVE_CONDITIONS_CONFIRM") {
      const pending = await getPendingConditions(waId);

      const raw = String(text || "").trim();
      const t = raw.toLowerCase();

      const saveAll =
        t === "tudo" ||
        t === "todos" ||
        t === "salvar tudo" ||
        t === "salvar todos" ||
        t === "sim" ||
        t === "s";

      const saveNone =
        t === "0" ||
        t === "nao" ||
        t === "não" ||
        t === "n" ||
        t === "não salvar" ||
        t === "nao salvar" ||
        t === "nenhum" ||
        t === "nenhuma";

      // Extrai números (ex.: "1 3 4" ou "1,3,4")
      const nums = (raw.match(/\d+/g) || []).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));

      if (!pending || !hasAnyKeys(pending)) {
        // Não há nada pendente para salvar
        await sendWhatsAppText(waId, "Beleza 🙂 Não tenho informações pendentes para salvar agora.");
      } else if (saveAll) {
        await setSavedConditions(waId, pending);
        await sendWhatsAppText(
          waId,
          `Perfeito ✅ Vou salvar e usar essas informações nas próximas descrições.\n\nSe quiser tirar depois, é só me pedir (ex.: "não use meu endereço").`
        );
      } else if (saveNone) {
        await sendWhatsAppText(waId, "Beleza 🙂 Não vou salvar essas informações para as próximas descrições.");
      } else if (nums.length) {
        const picked = pickConditionsByNumbers(pending, nums);
        if (picked && hasAnyKeys(picked)) {
          // Mescla com o que já existe, preservando o que não foi selecionado
          const current = await getSavedConditions(waId);
          await setSavedConditions(waId, { ...(current || {}), ...picked });
          await sendWhatsAppText(
            waId,
            `Combinado ✅ Vou salvar apenas o que você escolheu e usar nas próximas descrições.\n\nSe quiser tirar depois, é só me pedir (ex.: "não use meu endereço").`
          );
        } else {
          await sendWhatsAppText(waId, buildSaveConditionsPrompt(pending));
          return;
        }
      } else {
        await sendWhatsAppText(waId, buildSaveConditionsPrompt(pending));
        return;
      }

      const back = await popCondReturn(waId);
      await clearPendingConditions(waId);
      await setStatus(waId, back);

      // Depois da confirmação, segue o fluxo normal (ex.: feedback da descrição)
      await sendWhatsAppText(waId, askFeedbackText());
      return;
    }


    if (isMenuCommand(text)) {
      await setMenuReturn(waId, status);
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    if (status === "PAYMENT_PENDING") {
      await sendWhatsAppText(
        waId,
        `⏳ Estou aguardando a confirmação do seu pagamento pelo Asaas.\n\n" +
        "Assim que confirmar, eu te aviso aqui e seu plano será ativado ✅\n\n" +
        "Se quiser, digite *MENU* para ver seu status.`
      );
      return;
    }

    if (status === "MENU") {
      if (!["1", "2", "3", "4", "5", "6"].includes(text)) {
        const back = (await popMenuReturn(waId)) || "ACTIVE";
        await setStatus(waId, back);
        status = back;
      } else {
        if (text === "1") {
          const info = await buildMySubscriptionText(waId);
          await sendWhatsAppText(waId, info);
          const back = (await popMenuReturn(waId)) || "ACTIVE";
          await setStatus(waId, back);
          return;
        }
        if (text === "2") {
          await clearMenuReturn(waId);
          await setStatus(waId, "WAIT_PLAN");
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }
        if (text === "3") {
          await setStatus(waId, "MENU_CANCEL_CONFIRM");
          await sendWhatsAppText(
            waId,
            "*Cancelar plano (cartão)*\n\nResponda:\n1) Confirmar cancelamento\n2) Voltar"
          );
          return;
        }
        if (text === "4") {
          await setStatus(waId, "MENU_UPDATE_NAME");
          await sendWhatsAppText(waId, "Me envie seu *nome completo* para atualizar.");
          return;
        }
        if (text === "5") {
          await setStatus(waId, "MENU_UPDATE_DOC");
          await sendWhatsAppText(waId, "Me envie seu *CPF ou CNPJ* (somente números) para atualizar.");
          return;
        }
        if (text === "6") {
          await sendWhatsAppText(waId, `*Ajuda* 🙋\n\nDúvidas e perguntas frequentes: ${HELP_URL}`);
          const back = (await popMenuReturn(waId)) || "ACTIVE";
          await setStatus(waId, back);
          return;
        }
      }
    }

    if (status === "MENU_CANCEL_CONFIRM") {
      if (text === "2") {
        await setStatus(waId, "MENU");
        await sendWhatsAppText(waId, menuText());
        return;
      }
      if (text !== "1") {
        const back = (await popMenuReturn(waId)) || "ACTIVE";
        await setStatus(waId, back);
        status = back;
      } else {
        const subId = await redisGet(kAsaasSubscriptionId(waId));
        if (!subId) {
          await sendWhatsAppText(waId, "Você não tem uma assinatura de cartão ativa no momento.");
        } else {
          try {
            await asaasFetch(`/v3/subscriptions/${subId}`, "DELETE");
            await redisDel(kAsaasSubscriptionId(waId));
            await setPlanCode(waId, "");
            await sendWhatsAppText(waId, "Plano cancelado com sucesso ✅");
          } catch (e) {
            safeLogError("Erro cancelando assinatura:", e);
            await sendWhatsAppText(waId, "Não consegui cancelar agora. Tente novamente mais tarde.");
          }
        }
        const back = (await popMenuReturn(waId)) || "ACTIVE";
        await setStatus(waId, back);
        return;
      }
    }

    if (status === "MENU_UPDATE_NAME") {
      const name = text.trim();
      if (name.length < 3) {
        await sendWhatsAppText(waId, "Nome muito curto. Me envie seu *nome completo*.");
        return;
      }
      await setFullName(waId, name);
      await sendWhatsAppText(waId, "Nome atualizado ✅");
      const back = (await popMenuReturn(waId)) || "ACTIVE";
      await setStatus(waId, back);
      return;
    }

    if (status === "MENU_UPDATE_DOC") {
      const doc = cleanDoc(text);
      if (doc.length !== 11 && doc.length !== 14) {
        await sendWhatsAppText(waId, "Uhmm… acho que algum dígito ficou diferente aí 🥺😄\nDá uma olhadinha e me envia de novo, por favor, somente números:\n\nCPF: 11 dígitos\nCNPJ: 14 dígitos");
        return;
      }
      await setDoc(waId, doc);
      await sendWhatsAppText(waId, "CPF/CNPJ atualizado ✅");
      const back = (await popMenuReturn(waId)) || "ACTIVE";
      await setStatus(waId, back);
      return;
    }

    if (status === "WAIT_NAME") {
      await sendWhatsAppText(waId, "Oi! 👋😊\nEu sou o Amigo das Vendas — pode me chamar de Amigo.\n\nVocê me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.\n\nAntes que eu esqueça 😄 qual é o seu nome completo?");
      await setStatus(waId, "WAIT_NAME_VALUE");
      return;
    }

    if (status === "WAIT_NAME_VALUE") {
      const name = text.trim();
      if (name.length < 3) {
        await sendWhatsAppText(waId, "Me envie seu *nome completo*, por favor 🙂");
        return;
      }
      await setFullName(waId, name);

      // Fluxo correto: agradece o nome e libera o trial (5 descrições) sem pedir CPF/CNPJ agora.
      await sendWhatsAppText(waId, `É um prazer te conhecer, ${name.split(" ")[0]} 🙂`);
            await sendWhatsAppText(
        waId,
        `Pra gente se conhecer melhor 😊 você pode me pedir *5 descrições gratuitas* pra testar.

Você pode mandar bem completo (com preço, detalhes, entrega etc.) ou bem simples mesmo, tipo: “Faço bolo de chocolate R$35”. Eu organizo e deixo com cara de anúncio.

E tem mais: depois que eu te entregar a descrição, você pode pedir até *2 ajustes* (ex.: mais emoji, mais emocional, mudar o título) sem consumir uma nova descrição.

Me manda agora o que você vende ou o serviço que você oferece.`
      );

      await setStatus(waId, "ACTIVE");
      return;
    }

    if (status === "WAIT_DOC") {
      // Coleta CPF/CNPJ apenas para contratação / troca de plano
      const doc = cleanDoc(text);
      if (doc.length !== 11 && doc.length !== 14) {
        await sendWhatsAppText(waId, "Uhmm… acho que algum dígito ficou diferente aí 🥺😄\nDá uma olhadinha e me envia de novo, por favor, somente números:\n\nCPF: 11 dígitos\nCNPJ: 14 dígitos");
        return;
      }

      await setDoc(waId, doc);

      // Retoma o fluxo de pagamento de onde parou (Pix/Cartão)
      const planChoice = await redisGet(`tmp:planchoice:${waId}`);
      const payMethod = await redisGet(`tmp:paymethod:${waId}`); // "1" cartão | "2" pix

      const plan = PLANS[Number(planChoice || 0)];
      if (!plan || !["1", "2"].includes(String(payMethod || ""))) {
        await sendWhatsAppText(waId, "CPF/CNPJ registrado ✅\n\nAgora escolha um plano para continuar:");
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // Limpa o temp de método (planchoice mantemos porque ainda pode precisar)
      await redisDel(`tmp:paymethod:${waId}`);

      if (String(payMethod) === "1") {
        try {
          const r = await createCardSubscription({ waId, plan });

          await setPendingPayment({
            waId,
            planCode: plan.code,
            method: "CARD",
            subId: r.subscriptionId,
          });

          await setStatus(waId, "PAYMENT_PENDING");

          if (r.invoiceUrl) {
            await sendWhatsAppText(
              waId,
              `🧾 *Pagamento gerado!*

Finalize por aqui:
${r.invoiceUrl}

` +
                "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
            );
          } else {
            await sendWhatsAppText(
              waId,
              "🧾 *Pagamento gerado!*\n\n" + "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
            );
          }
        } catch (e) {
          safeLogError("Erro criando assinatura Asaas:", e);
          await sendWhatsAppText(
            waId,
            "Não consegui gerar o pagamento agora.\n\n" + "Digite *MENU* e tente novamente em *Mudar plano*."
          );
          await setStatus(waId, "WAIT_PLAN");
        }
        return;
      }

      // Pix
      try {
        const r = await createPixPayment({ waId, plan });

        await setPendingPayment({
          waId,
          planCode: plan.code,
          method: "PIX",
          paymentId: r.paymentId,
        });

        await setStatus(waId, "PAYMENT_PENDING");

        await sendWhatsAppText(
          waId,
          `🧾 *Pagamento Pix gerado!*

Pague neste link:
${r.invoiceUrl || r.link || ""}

` +
            "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
        );
      } catch (e) {
        safeLogError("Erro criando pagamento Pix Asaas:", e);
        await sendWhatsAppText(
          waId,
          "Não consegui gerar o Pix agora.\n\n" + "Digite *MENU* e tente novamente em *Mudar plano*."
        );
        await setStatus(waId, "WAIT_PLAN");
      }
      return;
    }

    if (status === "WAIT_PLAN") {
      if (!["1", "2", "3"].includes(text)) {
        await sendWhatsAppText(waId, "Responda com 1, 2 ou 3 para escolher o plano.");
        return;
      }
      await redisSet(`tmp:planchoice:${waId}`, text);
      await setStatus(waId, "WAIT_PAYMETHOD");
      await sendWhatsAppText(waId, paymentMethodText());
      return;
    }

    if (status === "WAIT_PAYMETHOD") {
      if (!["1", "2"].includes(text)) {
        await sendWhatsAppText(waId, "Responda com 1 (Cartão) ou 2 (Pix).");
        return;
      }

      const planChoice = await redisGet(`tmp:planchoice:${waId}`);
      const plan = PLANS[Number(planChoice || 0)];
      if (!plan) {
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // Se ainda não temos CPF/CNPJ, pede agora (apenas na contratação do plano)
      const existingDoc = await getDoc(waId);
      if (!existingDoc) {
        await redisSet(`tmp:paymethod:${waId}`, text); // guarda 1/2 para retomar depois
        await setStatus(waId, "WAIT_DOC");
        await sendWhatsAppText(
        waId,
        `Nossa, quase esqueci 😄\nPra eu conseguir gerar e registrar o pagamento, preciso do seu CPF ou CNPJ (somente números).\n\n" +
            "Pode me enviar, por favor?\nFica tranquilo(a): eu uso só pra isso e não aparece em mensagens nem em logs.`
      );
        return;
      }

      if (text === "1") {
        try {
          const r = await createCardSubscription({ waId, plan });

          await setPendingPayment({
            waId,
            planCode: plan.code,
            method: "CARD",
            subId: r.subscriptionId,
          });

          await setStatus(waId, "PAYMENT_PENDING");

          if (r.invoiceUrl) {
            await sendWhatsAppText(
              waId,
              `🧾 *Pagamento gerado!*\n\nFinalize por aqui:\n${r.invoiceUrl}\n\n` +
              "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
            );
          } else {
            await sendWhatsAppText(
        waId,
        `🧾 *Pagamento gerado!*\n\n" +
              "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅`
      );
          }
        } catch (e) {
          safeLogError("Erro criando assinatura Asaas:", e);
          await sendWhatsAppText(
        waId,
        `Não consegui gerar o pagamento agora.\n\n" +
            "Se quiser, digite *MENU* e tente novamente em *Mudar plano*.\n" +
            "Ou revise seu CPF/CNPJ em *Alterar CPF/CNPJ*.`
      );
          await setStatus(waId, "WAIT_PLAN");
        }
        return;
      }

      if (text === "2") {
        try {
          const r = await createPixPayment({ waId, plan });

          await setPendingPayment({
            waId,
            planCode: plan.code,
            method: "PIX",
            paymentId: r.paymentId,
          });

          await setStatus(waId, "PAYMENT_PENDING");

          await sendWhatsAppText(
            waId,
            `🧾 *Pagamento Pix gerado!*\n\nPague neste link:\n${r.invoiceUrl || r.link || ""}\n\n` +
            "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
          );
        } catch (e) {
          safeLogError("Erro criando pagamento Pix Asaas:", e);
          await sendWhatsAppText(
        waId,
        `Não consegui gerar o Pix agora.\n\n" +
            "Se quiser, digite *MENU* e tente novamente em *Mudar plano*.\n" +
            "Ou revise seu CPF/CNPJ em *Alterar CPF/CNPJ*.`
      );
          await setStatus(waId, "WAIT_PLAN");
        }
        return;
      }
    }

    // ===================== BLOQUEIOS =====================
    const planCode = await getPlanCode(waId);
    if (!planCode) {
      const used = await getFreeUsed(waId);
      if (used >= FREE_DESCRIPTIONS_LIMIT) {
        await setStatus(waId, "BLOCKED");
        await sendTrialEndedFlow(waId);
        return;
      }
    }

    if (planCode) {
      const can = await canUseByPlanNow(waId);
      if (!can) {
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, "Seu plano expirou ou atingiu o limite. Vamos renovar?");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }
    }

    // ===================== DESCRIÇÃO / REFINO =====================
    const prevDraft = await getDraft(waId);
    const lastDesc = await getLastDescription(waId);
    const refineCount = await getRefineCount(waId);
    const lastInput = await getLastInput(waId);

    if (lastDesc && (isOkToFinish(text) || isPositiveFeedbackLegacy(text))) {
      // "OK" significa que o cliente gostou — vamos guardar como referência de estilo.
      await setStyleAnchor(waId, lastDesc);

      await sendWhatsAppText(waId, "Legal! ✅\nQuando quiser criar outra descrição, é só me mandar. Tô aqui prontinho pra te ajudar 🙂");
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);
      await clearLastInput(waId);
      return;
    }

    if (lastDesc) {
      const isRefine = looksLikeRefinement(text);
      const isExtraInfo = looksLikeAdditionalInfo(text);

      if (!isRefine && !isExtraInfo) {
        await clearDraft(waId);
        await clearRefineCount(waId);
        await clearLastDescription(waId);
        await clearLastInput(waId);
      } else {
        let instruction = "";
        let baseText = lastInput || draftToUserText(prevDraft) || "";

        if (isExtraInfo) {
          const merged = mergeDraftFromMessage(prevDraft, text);
          await setDraft(waId, merged);
          baseText = draftToUserText(merged) || baseText;
          instruction = `Incorpore estas novas informações do cliente: ${text}`;
        } else {
          instruction = extractImprovementInstruction(text) || text;
        }

        
        // Contagem de refinamentos:
        // - 0,1,2 refinamentos => ainda conta como 1 descrição
        // - 3,4,5 refinamentos => passa a contar como 2 descrições
        // - 6,7,8 refinamentos => passa a contar como 3 descrições
        // Ou seja: a cada 3 refinamentos (3º, 6º, 9º, ...) consome +1 descrição.
        const nextRef = refineCount + 1;
        if (nextRef % 3 === 0) {
          const okConsume = await consumeOneDescriptionOrBlock(waId);
          if (!okConsume) {
            await setStatus(waId, "WAIT_PLAN");
            const planCodeNow = await redisGet(kPlanCode(waId));
            if (!planCodeNow) {
              await sendTrialEndedFlow(waId);
              return;
            }
            await sendWhatsAppText(waId, "Seu plano expirou ou atingiu o limite. Vamos renovar?");
            await sendWhatsAppText(waId, plansMenuText());
            return;
          }
        }
        await setRefineCount(waId, nextRef);
try {
          const basePrefsNow = await getPrefs(waId);
          const formatting = { ...(basePrefsNow || {}), ...((fmtIntent && fmtIntent.overrides) || {}) };
          if (formatting.allowEmojis === false) formatting.allowConditionIcons = false;

          const genRaw = await openaiGenerateDescription({
            baseUserText: baseText,
            previousDescription: lastDesc,
            instruction,
            fullName: await getFullName(waId),
            prefs: await getPrefs(waId),
            savedConditions: await getSavedConditions(waId),
            styleAnchor: await getStyleAnchor(waId),
            formatting,
          });
          const gen = applyFormattingEnforcement(sanitizeWhatsAppMarkdown(genRaw), formatting);
          await setLastDescription(waId, gen);
          await sendWhatsAppText(waId, gen);
          // Se houve alteração estrutural nesta mensagem (sem emojis, texto corrido, tabela, etc.)
          // e o usuário não pediu explicitamente para manter daqui pra frente, marcamos para perguntar
          // antes da PRÓXIMA nova descrição.
          if (fmtIntent && fmtIntent.hasStructural && !fmtIntent.wantsPersist && !fmtIntent.wantsReset) {
            if (fmtIntent.overrides && Object.keys(fmtIntent.overrides).length) {
              await setPendingStruct(waId, { patch: fmtIntent.overrides });
            }
          }



          // Se no refinamento o cliente mandou dados (telefone/endereço/horário/etc), oferecemos salvar.
          const extractedConds2 = extractConditionsFromText(text);
          if (hasAnyKeys(extractedConds2)) {
            const already2 = await getSavedConditions(waId);
            const isNew2 =
              (extractedConds2.phone && extractedConds2.phone !== already2.phone) ||
              (extractedConds2.address && extractedConds2.address !== already2.address) ||
              (extractedConds2.hours && extractedConds2.hours !== already2.hours) ||
              (extractedConds2.price && extractedConds2.price !== already2.price) ||
              (extractedConds2.instagram && extractedConds2.instagram !== already2.instagram) ||
              (extractedConds2.website && extractedConds2.website !== already2.website);

            if (isNew2) {
              await setPendingConditions(waId, extractedConds2, "ACTIVE");
              await setStatus(waId, "WAIT_SAVE_CONDITIONS_CONFIRM");

              await sendWhatsAppText(waId, buildSaveConditionsPrompt(extractedConds2));
              return;
            }
          }

          await sendWhatsAppText(waId, askFeedbackText());
        } catch (e) {
          safeLogError("Erro OpenAI (refino):", e);
          await sendWhatsAppText(waId, "Tive um problema ao melhorar a descrição agora. Tente novamente em instantes.");
        }
        return;
      }
    }

    
    // ===================== CONFIRMAÇÃO DE BASE ESTRUTURAL (antes de nova descrição) =====================
    const pendingStruct = await getPendingStruct(waId);
    if (pendingStruct && pendingStruct.patch && Object.keys(pendingStruct.patch).length) {
      await setPendingStruct(waId, { ...pendingStruct, queuedText: text, returnStatus: "ACTIVE" });
      await setStatus(waId, "WAIT_STRUCT_CONFIRM");
      await sendWhatsAppText(
        waId,
        `Antes de criar a próxima descrição: você quer *manter as alterações estruturais* que você fez (ex.: sem emojis, texto corrido, tabela, sem negrito etc.) como padrão para as próximas descrições?

1) Sim, manter como padrão
2) Não, voltar ao modelo base do projeto`
      );
      return;
    }

const draft = mergeDraftFromMessage(await getDraft(waId), text);
    await setDraft(waId, draft);

    const okConsume = await consumeOneDescriptionOrBlock(waId);
    if (!okConsume) {
      if (!planCode) {
        await setStatus(waId, "BLOCKED");
        await sendTrialEndedFlow(waId);
        return;
      }
      await setStatus(waId, "WAIT_PLAN");
      await sendWhatsAppText(waId, "Seu plano expirou ou atingiu o limite. Vamos renovar?");
      await sendWhatsAppText(waId, plansMenuText());
      return;
    }

    try {
      const baseText = draftToUserText(draft);
      const basePrefsNow = await getPrefs(waId);
      const formatting = { ...(basePrefsNow || {}), ...((fmtIntent && fmtIntent.overrides) || {}) };
      if (formatting.allowEmojis === false) formatting.allowConditionIcons = false;

      const genRaw = await openaiGenerateDescription({
        baseUserText: baseText,
        previousDescription: "",
        instruction: "",
        fullName: await getFullName(waId),
        prefs: await getPrefs(waId),
        savedConditions: await getSavedConditions(waId),
        styleAnchor: await getStyleAnchor(waId),
        formatting,
      });

      const gen = applyFormattingEnforcement(sanitizeWhatsAppMarkdown(genRaw), formatting);

      await setLastInput(waId, baseText);
      await setLastDescription(waId, gen);
      await setRefineCount(waId, 0);

      await sendWhatsAppText(waId, gen);

      // Se o cliente mandou telefone/endereço/horário/etc no texto, oferecemos salvar para próximas descrições.
      const extractedConds = extractConditionsFromText(text);
      if (hasAnyKeys(extractedConds)) {
        // Só pergunta se for algo novo (não ficar insistindo)
        const already = await getSavedConditions(waId);
        const isNew =
          (extractedConds.phone && extractedConds.phone !== already.phone) ||
          (extractedConds.address && extractedConds.address !== already.address) ||
          (extractedConds.hours && extractedConds.hours !== already.hours) ||
          (extractedConds.price && extractedConds.price !== already.price) ||
          (extractedConds.instagram && extractedConds.instagram !== already.instagram) ||
          (extractedConds.website && extractedConds.website !== already.website);

        if (isNew) {
          await setPendingConditions(waId, extractedConds, "ACTIVE");
          await setStatus(waId, "WAIT_SAVE_CONDITIONS_CONFIRM");

          await sendWhatsAppText(
            waId,
            `📌 Vi que você colocou alguns dados como telefone, endereço, horário, valores ou links.

Quer que eu *salve essas informações* para incluir nas descrições futuras?

1) Sim, pode salvar
2) Não, não salvar`
          );
          return;
        }
      }

      await sendWhatsAppText(waId, askFeedbackText());
    } catch (e) {
      safeLogError("Erro OpenAI (geração):", e);
      await sendWhatsAppText(waId, "Tive um problema ao gerar a descrição agora. Tente novamente em instantes.");
    }

  } catch (err) {
    safeLogError("Erro no webhook:", err);
  }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
