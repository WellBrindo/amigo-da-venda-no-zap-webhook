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
  resetUserToTrial,
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
import { listPayments, getSubscription, cancelSubscription } from "../services/asaas/client.js";
import { listAsaasEvents } from "../services/asaas/ledger.js";

import { redisGet, redisSet, redisDel } from "../services/redis.js";
import { logAdminAudit, listAdminAudit, getAdminAuditCount } from "../services/audit.js";


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
  const usersOpen = ap.startsWith("/admin/users") || ap.startsWith("/admin/window24h") || ap.startsWith("/admin/crm") || ap.startsWith("/admin/bulk");
  const financeOpen = ap.startsWith("/admin/finance") || ap.startsWith("/admin/finance-");
  const systemOpen = ap.startsWith("/admin/alerts") || ap.startsWith("/admin/audit") || ap.startsWith("/admin/inconsistencies") || ap.startsWith("/admin/copy") || ap.startsWith("/admin/asaas-test") || ap.startsWith("/admin/settings");
  const reportsOpen = ap.startsWith("/admin/reports");

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
        ${item("/admin/executive-ui", "Dashboard Executivo", "🧠")}
        ${item("/admin/plans", "Planos", "💳")}
      </details>

      <details open>
        <summary>📣 Comunicação <span>▾</span></summary>
        ${item("/admin/broadcast-ui", "Broadcast", "📣")}
        ${item("/admin/campaigns-ui", "Campanhas", "📦")}
      </details>

      <details ${usersOpen ? "open" : ""}>
        <summary>👥 Usuários <span>▾</span></summary>
        ${item("/admin/crm-ui", "CRM de usuários", "🧭")}
        ${item("/admin/bulk-ui", "Ações em massa", "🧰")}
        ${item("/admin/users-list-ui", "Lista de usuários", "📋")}
        ${item("/admin/users-ui", "Ações / Consulta", "👤")}
        ${item("/admin/window24h-ui", "Janela 24h", "🕒")}
      </details>

      <details ${financeOpen ? "open" : ""}>
        <summary>💰 Financeiro <span>▾</span></summary>
        ${item("/admin/finance-asaas-ui", "Asaas (Reconciliação)", "🧾")}
      </details>

      <details ${reportsOpen ? "open" : ""}>
        <summary>📑 Relatórios <span>▾</span></summary>
        ${item("/admin/reports-ui", "Relatórios e Exportação", "📑")}
      </details>

      <details ${systemOpen ? "open" : ""}>
        <summary>⚙️ Sistema <span>▾</span></summary>
        ${item("/admin/alerts-ui", "Alertas", "🚨")}
        ${item("/admin/audit-ui", "Auditoria administrativa", "📚")}
        ${item("/admin/inconsistencies-ui", "Inconsistências", "🩺")}
        ${item("/admin/copy-ui", "Textos do Bot", "📝")}
        ${item("/admin/settings-ui", "Configurações Globais", "🛠️")}
        ${item("/admin/asaas-test-ui", "Asaas Teste", "🧪")}
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

const GLOBAL_SETTINGS_PREFIX = "cfg:global:";


const GLOBAL_SETTINGS_CATALOG = [
  {
    key: "trial.maxDescriptions",
    label: "Limite de anúncios no teste gratuito",
    section: "Plano Trial",
    type: "int",
    defaultValue: 5,
    min: 1,
    max: 1000,
    help: "Define quantos anúncios um usuário pode gerar durante o período de teste gratuito. Se você aumentar esse número, os usuários poderão criar mais anúncios antes de precisar assinar um plano."
  },
  {
    key: "trial.maxRefinements",
    label: "Limite de melhorias do anúncio no teste",
    section: "Plano Trial",
    type: "int",
    defaultValue: 2,
    min: 0,
    max: 100,
    help: "Define quantas vezes o usuário pode pedir para o sistema melhorar ou ajustar um anúncio durante o teste gratuito."
  },
  {
    key: "flow.defaultTemplateMode",
    label: "Modo padrão de criação de anúncio",
    section: "Fluxo do Bot",
    type: "enum",
    defaultValue: "FIXED",
    options: ["FIXED", "FREE"],
    help: "Define como o anúncio será criado por padrão. FIXED = usa um modelo estruturado do sistema. FREE = permite texto mais livre e criativo."
  },
  {
    key: "flow.requireNameOnStart",
    label: "Solicitar nome do usuário no início",
    section: "Fluxo do Bot",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o bot sempre pedirá o nome do usuário antes de iniciar o fluxo de criação de anúncios."
  },
  {
    key: "feature.companyProfileWizard",
    label: "Ativar cadastro de dados da empresa",
    section: "Funcionalidades",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o sistema pedirá dados da empresa do usuário (nome do negócio, cidade, etc.) para melhorar os anúncios gerados."
  },
  {
    key: "feature.refinement",
    label: "Permitir melhoria automática de anúncios",
    section: "Funcionalidades",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o usuário pode pedir para o sistema melhorar ou ajustar o anúncio gerado."
  }
];


function settingRedisKey(key) {
  return `${GLOBAL_SETTINGS_PREFIX}${key}`;
}

function normalizeSettingValue(def, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return def.defaultValue;
  }

  if (def.type === "bool") {
    if (typeof rawValue === "boolean") return rawValue;
    const v = String(rawValue).trim().toLowerCase();
    return v === "1" || v === "true" || v === "on" || v === "yes";
  }

  if (def.type === "int") {
    const n = Number(rawValue);
    let out = Number.isFinite(n) ? Math.trunc(n) : Number(def.defaultValue || 0);
    if (Number.isFinite(def.min)) out = Math.max(def.min, out);
    if (Number.isFinite(def.max)) out = Math.min(def.max, out);
    return out;
  }

  if (def.type === "enum") {
    const v = String(rawValue).trim();
    return Array.isArray(def.options) && def.options.includes(v) ? v : def.defaultValue;
  }

  return String(rawValue);
}

function serializeSettingValue(def, value) {
  if (def.type === "bool") return value ? "true" : "false";
  if (def.type === "int") return String(Math.trunc(Number(value) || 0));
  return String(value ?? "");
}

async function getResolvedGlobalSettings() {
  const rows = [];
  for (const def of GLOBAL_SETTINGS_CATALOG) {
    const raw = await redisGet(settingRedisKey(def.key));
    const resolved = normalizeSettingValue(def, raw);
    rows.push({
      ...def,
      value: resolved,
      storedValue: raw,
      isCustom: raw !== null && raw !== undefined,
    });
  }
  return rows;
}

function groupGlobalSettings(rows) {
  const groups = new Map();
  for (const row of rows) {
    const section = row.section || "Geral";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(row);
  }
  return Array.from(groups.entries()).map(([section, items]) => ({ section, items }));
}

function limitText(value, max = 240) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parseBasicAuthUser(req) {
  const auth = String(req?.headers?.authorization || "").trim();
  if (!auth.startsWith("Basic ")) return "admin";
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const username = String(decoded.split(":")[0] || "").trim();
    return username || "admin";
  } catch (_) {
    return "admin";
  }
}

function getAdminActor(req) {
  const xfwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xfwd || String(req?.ip || req?.socket?.remoteAddress || "").trim() || "unknown";
  const userAgent = limitText(req?.headers?.["user-agent"] || "", 180);
  return {
    type: "admin",
    user: parseBasicAuthUser(req),
    ip,
    userAgent,
  };
}

function buildAuditUserSnapshot(user) {
  const u = user || {};
  return {
    waId: String(u.waId || "").trim(),
    status: String(u.status || "").trim(),
    plan: String(u.plan || "").trim(),
    fullName: String(u.fullName || "").trim(),
    paymentMethod: String(u.paymentMethod || "").trim(),
    quotaUsed: Number(u.quotaUsed || 0),
    trialUsed: Number(u.trialUsed || 0),
    asaasCustomerId: String(u.asaasCustomerId || "").trim(),
    asaasSubscriptionId: String(u.asaasSubscriptionId || "").trim(),
    cardValidUntil: String(u.cardValidUntil || "").trim(),
    cardCanceledAt: String(u.cardCanceledAt || "").trim(),
  };
}

async function safeRecordAdminAudit(req, entry) {
  try {
    await logAdminAudit({
      ...entry,
      actor: getAdminActor(req),
    });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "admin_audit_failed",
      error: String(err?.message || err),
      action: String(entry?.action || ""),
      module: String(entry?.module || ""),
    }));
  }
}

function formatMoneyCents(cents) {
  const value = (Number(cents) || 0) / 100;
  try {
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch (_) {
    return `R$ ${value.toFixed(2)}`;
  }
}

function normalizeExportFormat(value) {
  const format = String(value || "csv").trim().toLowerCase();
  return format === "json" ? "json" : "csv";
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).replace(/\r?\n/g, " ");
  return '"' + str.replace(/"/g, '""') + '"';
}

function rowsToCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const headers = Array.from(new Set(list.flatMap((row) => Object.keys(row || {}))));
  const lines = [headers.map(csvCell).join(",")];
  for (const row of list) {
    lines.push(headers.map((key) => csvCell(row?.[key] ?? "")).join(","));
  }
  return lines.join("\n");
}

function sendExport(res, filenameBase, format, payload) {
  if (format === "json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.json"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  }

  const rows = Array.isArray(payload) ? payload : [];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
  return res.status(200).send(rowsToCsv(rows));
}

async function buildExportUsersRows() {
  const usersRaw = await listUsers();
  const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
  const plans = await listPlans({ includeInactive: true });
  const planMap = buildPlanMap(plans);
  const now = nowMs();
  const users = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));

  return users.map((user) => ({
    waId: String(user.waId || ""),
    fullName: String(user.fullName || ""),
    status: String(user.status || ""),
    plan: String(user.plan || ""),
    planName: String(user.planName || ""),
    planDescription: String(user.planDescription || ""),
    paymentMethod: String(user.paymentMethod || ""),
    quotaUsed: Number(user.quotaUsed || 0),
    trialUsed: Number(user.trialUsed || 0),
    templateMode: String(user.templateMode || ""),
    billingCityState: String(user.billingCityState || ""),
    billingAddress: String(user.billingAddress || ""),
    hasBizProfile: user.hasBizProfile ? "yes" : "no",
    hasPendingBizProfile: user.hasPendingBizProfile ? "yes" : "no",
    inWindow24h: user.inWindow ? "yes" : "no",
    lastInboundTs: Number(user.lastInboundTs || 0),
    windowExpiresAt: Number(user.windowExpiresAt || 0),
    issueCount: Number(user.issueCount || 0),
    issueKeys: (user.issueKeys || []).join(" | "),
    asaasCustomerId: String(user.asaasCustomerId || ""),
    asaasSubscriptionId: String(user.asaasSubscriptionId || ""),
    cardValidUntil: String(user.cardValidUntil || ""),
    cardCanceledAt: String(user.cardCanceledAt || ""),
    docType: String(user?.doc?.docType || ""),
    docLast4: String(user?.doc?.docLast4 || ""),
  }));
}

async function buildExportInconsistencyRows() {
  const data = await collectInconsistencies();
  const rows = [];
  for (const [key, bucket] of Object.entries(data.items || {})) {
    for (const item of bucket.items || []) {
      rows.push({
        bucketKey: key,
        label: String(bucket.label || ""),
        severity: String(bucket.severity || ""),
        description: String(bucket.description || ""),
        waId: String(item.waId || ""),
        fullName: String(item.fullName || ""),
        status: String(item.status || ""),
        plan: String(item.plan || ""),
        paymentMethod: String(item.paymentMethod || ""),
        asaasCustomerId: String(item.asaasCustomerId || ""),
        asaasSubscriptionId: String(item.asaasSubscriptionId || ""),
        quotaUsed: Number(item.quotaUsed || 0),
        trialUsed: Number(item.trialUsed || 0),
        cardValidUntil: String(item.cardValidUntil || ""),
        cardCanceledAt: String(item.cardCanceledAt || ""),
      });
    }
  }
  return rows;
}

async function buildExportAuditRows() {
  const items = await listAdminAudit({ limit: 1000 });
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ""),
    ts: String(item?.ts || ""),
    module: String(item?.module || ""),
    action: String(item?.action || ""),
    waId: String(item?.waId || ""),
    targetId: String(item?.targetId || ""),
    targetLabel: String(item?.targetLabel || ""),
    summary: String(item?.summary || ""),
    actorUser: String(item?.actor?.user || ""),
    actorIp: String(item?.actor?.ip || ""),
    actorType: String(item?.actor?.type || ""),
    before: JSON.stringify(item?.before || {}),
    after: JSON.stringify(item?.after || {}),
    meta: JSON.stringify(item?.meta || {}),
  }));
}

function buildReportsFallbackData(errorMessage = "") {
  return {
    ok: true,
    ts: Date.now(),
    warning: String(errorMessage || "").trim(),
    executive: {
      ok: true,
      ts: Date.now(),
      overview: { totalUsers: 0, activeUsers: 0, trialUsers: 0, paymentPendingUsers: 0, waitPlanUsers: 0, blockedUsers: 0, activeSharePct: 0, trialToPaidPct: 0 },
      revenue: { mrrCents: 0, avgTicketCents: 0, activePaidUsers: 0 },
      usage: { descriptionsToday: 0, descriptionsMonth: 0, dayLabel: "", monthLabel: "", window24hCount: 0, avgDescriptionsPerActive: 0 },
      quality: { withName: 0, withBizProfile: 0, withPendingBizProfile: 0, withAsaasCustomer: 0, withAsaasSubscription: 0, withBilling: 0, issueUsers: 0, profileCoveragePct: 0, nameCoveragePct: 0, inconsistencyPct: 0 },
      statusCounts: { TRIAL: 0, ACTIVE: 0, WAIT_PLAN: 0, PAYMENT_PENDING: 0, BLOCKED: 0, UNKNOWN: 0 },
      payments: [],
      plans: [],
      cities: [],
      inconsistencies: { ok: true, ts: Date.now(), usersCount: 0, totalIssues: 0, summary: [], items: {} },
    },
    audit: {
      totalStored: 0,
      recentCount: 0,
      modules: [],
      actions: [],
      items: [],
    },
  };
}

async function buildReportsCenterData(executiveBuilder) {
  const executivePromise = typeof executiveBuilder === "function"
    ? executiveBuilder()
    : Promise.resolve(buildReportsFallbackData("Executive builder unavailable").executive);

  const [executive, auditItems, auditTotal] = await Promise.all([
    executivePromise,
    listAdminAudit({ limit: 30 }),
    getAdminAuditCount(),
  ]);

  const recentAudit = Array.isArray(auditItems) ? auditItems : [];
  const moduleCounts = new Map();
  const actionCounts = new Map();
  for (const item of recentAudit) {
    const moduleName = String(item?.module || "—").trim() || "—";
    const actionName = String(item?.action || "—").trim() || "—";
    moduleCounts.set(moduleName, (moduleCounts.get(moduleName) || 0) + 1);
    actionCounts.set(actionName, (actionCounts.get(actionName) || 0) + 1);
  }

  const modules = Array.from(moduleCounts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  const actions = Array.from(actionCounts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)).slice(0, 10);

  return {
    ok: true,
    ts: Date.now(),
    executive,
    audit: {
      totalStored: Number(auditTotal || 0),
      recentCount: recentAudit.length,
      modules,
      actions,
      items: recentAudit,
    },
  };
}

export function adminRouter() {
  const router = Router();

  // ===================== Dashboard (Métricas consolidadas) =====================
  // ✅ V16.4.9 — Dashboard consolidado (global + por usuário)
  function toInt(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  async function mapLimitDashboard(items, limit, fn) {
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


  function buildInconsistencyBucket(label, severity, description = "") {
    return { label, severity, description, count: 0, items: [] };
  }

  function buildPlanMap(plans) {
    return new Map(
      (Array.isArray(plans) ? plans : [])
        .map((plan) => {
          const code = String(plan?.code || "").trim().toUpperCase();
          return code ? [code, plan] : null;
        })
        .filter(Boolean)
    );
  }

  function getCrmStatusCounters() {
    return {
      TRIAL: 0,
      ACTIVE: 0,
      WAIT_PLAN: 0,
      PAYMENT_PENDING: 0,
      BLOCKED: 0,
      UNKNOWN: 0,
    };
  }

  function detectUserInconsistencyKeys(snap, lastInboundTs, now, planMap) {
    const keys = [];
    const status = String(snap?.status || "").trim().toUpperCase();
    const planCode = String(snap?.plan || "").trim().toUpperCase();
    const paymentMethod = String(snap?.paymentMethod || "").trim().toUpperCase();
    const asaasCustomerId = String(snap?.asaasCustomerId || "").trim();
    const asaasSubscriptionId = String(snap?.asaasSubscriptionId || "").trim();
    const fullName = String(snap?.fullName || "").trim();
    const quotaUsed = Number(snap?.quotaUsed || 0);
    const trialUsed = Number(snap?.trialUsed || 0);
    const planMeta = planCode ? planMap.get(planCode) : null;
    const hasPendingBizProfile = !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === "object");

    if (status === "ACTIVE" && !planCode) keys.push("activeWithoutPlan");
    if (status === "TRIAL" && planCode) keys.push("trialWithPlan");
    if (planCode && !planMeta) keys.push("planNotFound");
    if (planMeta && !planMeta.active) keys.push("inactivePlanInUse");
    if (paymentMethod && !asaasCustomerId) keys.push("paymentWithoutCustomer");
    if (asaasSubscriptionId && !asaasCustomerId) keys.push("subscriptionWithoutCustomer");
    if (status === "ACTIVE" && !asaasSubscriptionId) keys.push("activeWithoutSubscription");
    if (quotaUsed < 0) keys.push("quotaNegative");
    if (trialUsed < 0) keys.push("trialNegative");
    if (status === "TRIAL" && quotaUsed > 0) keys.push("trialWithQuota");
    if (!fullName) keys.push("noName");
    if (lastInboundTs > now) keys.push("futureInbound");
    if (status === "WAIT_PLAN" && asaasSubscriptionId) keys.push("waitPlanWithSubscription");
    if (snap?.cardCanceledAt && !snap?.cardValidUntil) keys.push("cardCanceledWithoutValidUntil");
    if (hasPendingBizProfile) keys.push("pendingBizProfile");

    return keys;
  }

  async function enrichUserForCrm(waId, planMap, now) {
    const [snap, lastInboundTsRaw] = await Promise.all([
      getUserSnapshot(waId),
      getLastInboundTs(waId),
    ]);

    const lastInboundTs = Number(lastInboundTsRaw || 0);
    const windowExpiresAt = lastInboundTs ? lastInboundTs + 24 * 60 * 60 * 1000 : 0;
    const inWindow = lastInboundTs ? now - lastInboundTs < 24 * 60 * 60 * 1000 : false;
    const planCode = String(snap?.plan || "").trim().toUpperCase();
    const planMeta = planCode ? planMap.get(planCode) : null;
    const issueKeys = detectUserInconsistencyKeys(snap, lastInboundTs, now, planMap);

    return {
      waId: String(waId || ""),
      fullName: String(snap?.fullName || ""),
      status: String(snap?.status || ""),
      plan: String(snap?.plan || ""),
      planName: String(planMeta?.name || ""),
      planDescription: String(planMeta?.description || ""),
      paymentMethod: String(snap?.paymentMethod || ""),
      quotaUsed: Number(snap?.quotaUsed || 0),
      trialUsed: Number(snap?.trialUsed || 0),
      templateMode: String(snap?.templateMode || ""),
      billingCityState: String(snap?.billingCityState || ""),
      billingAddress: String(snap?.billingAddress || ""),
      asaasCustomerId: String(snap?.asaasCustomerId || ""),
      asaasSubscriptionId: String(snap?.asaasSubscriptionId || ""),
      cardValidUntil: String(snap?.cardValidUntil || ""),
      cardCanceledAt: String(snap?.cardCanceledAt || ""),
      doc: snap?.doc || { docType: "", docLast4: "" },
      bizProfile: snap?.bizProfile || null,
      pendingBizProfile: snap?.pendingBizProfile || null,
      hasBizProfile: !!(snap?.bizProfile && typeof snap.bizProfile === "object"),
      hasPendingBizProfile: !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === "object"),
      inWindow,
      lastInboundTs,
      windowExpiresAt,
      issueKeys,
      issueCount: issueKeys.length,
      snapshot: snap,
    };
  }

  async function collectInconsistencies() {
    const usersRaw = await listUsers();
    const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
    const plans = await listPlans({ includeInactive: true });
    const planMap = buildPlanMap(plans);

    const buckets = {
      activeWithoutPlan: buildInconsistencyBucket("Assinante sem plano", "danger", "Usuário está ativo, mas não tem nenhum plano salvo."),
      trialWithPlan: buildInconsistencyBucket("Trial com plano salvo", "warn", "Usuário ainda está no teste, mas já aparece com um plano preenchido."),
      planNotFound: buildInconsistencyBucket("Plano não encontrado", "danger", "O plano salvo no usuário não existe mais no catálogo do sistema."),
      inactivePlanInUse: buildInconsistencyBucket("Plano desativado em uso", "warn", "O usuário está vinculado a um plano que hoje está desativado."),
      paymentWithoutCustomer: buildInconsistencyBucket("Pagamento sem cadastro Asaas", "warn", "Há forma de pagamento definida, mas falta o código do cliente no Asaas."),
      subscriptionWithoutCustomer: buildInconsistencyBucket("Assinatura sem cliente Asaas", "danger", "Existe assinatura salva, mas não existe cliente correspondente no Asaas."),
      activeWithoutSubscription: buildInconsistencyBucket("Assinante sem assinatura Asaas", "danger", "Usuário está ativo, mas não há assinatura registrada no Asaas."),
      quotaNegative: buildInconsistencyBucket("Uso mensal negativo", "danger", "O contador de uso mensal ficou abaixo de zero, o que não deveria acontecer."),
      trialNegative: buildInconsistencyBucket("Uso do trial negativo", "danger", "O contador de uso do teste ficou abaixo de zero, o que indica erro de dados."),
      trialWithQuota: buildInconsistencyBucket("Trial usando quota de plano", "warn", "Usuário em teste aparece com consumo na quota mensal de assinante."),
      noName: buildInconsistencyBucket("Usuário sem nome", "info", "Cadastro sem nome preenchido, o que dificulta suporte e cobrança."),
      futureInbound: buildInconsistencyBucket("Mensagem com data futura", "warn", "A última mensagem recebida ficou registrada com horário no futuro."),
      waitPlanWithSubscription: buildInconsistencyBucket("Aguardando plano com assinatura", "warn", "Usuário ainda está aguardando plano, mas já possui assinatura criada."),
      cardCanceledWithoutValidUntil: buildInconsistencyBucket("Cancelado sem data final", "warn", "O cartão foi cancelado, mas não foi salva a data final de acesso."),
      pendingBizProfile: buildInconsistencyBucket("Perfil da empresa pendente", "info", "Há dados da empresa aguardando confirmação ou finalização pelo usuário."),
    };

    function pushIssue(bucketKey, snap, extra = {}) {
      const bucket = buckets[bucketKey];
      if (!bucket) return;
      bucket.items.push({
        waId: String(snap?.waId || extra.waId || ""),
        fullName: String(snap?.fullName || ""),
        status: String(snap?.status || ""),
        plan: String(snap?.plan || ""),
        paymentMethod: String(snap?.paymentMethod || ""),
        asaasCustomerId: String(snap?.asaasCustomerId || ""),
        asaasSubscriptionId: String(snap?.asaasSubscriptionId || ""),
        quotaUsed: Number(snap?.quotaUsed || 0),
        trialUsed: Number(snap?.trialUsed || 0),
        cardValidUntil: String(snap?.cardValidUntil || ""),
        cardCanceledAt: String(snap?.cardCanceledAt || ""),
        ...extra,
      });
      bucket.count = bucket.items.length;
    }

    const now = nowMs();

    await mapLimit(waIds, 20, async (waId) => {
      const user = await enrichUserForCrm(waId, planMap, now);
      const snap = user.snapshot || {};
      const planMeta = user.plan ? planMap.get(String(user.plan || "").trim().toUpperCase()) : null;

      for (const key of user.issueKeys || []) {
        const extra = {};
        if (key === "inactivePlanInUse") extra.planName = String(planMeta?.name || "");
        if (key === "futureInbound") {
          extra.lastInboundTs = user.lastInboundTs;
          extra.nowMs = now;
        }
        if (key === "pendingBizProfile") extra.pendingKeys = Object.keys(snap.pendingBizProfile || {});
        pushIssue(key, snap, extra);
      }
    });

    const summary = Object.entries(buckets).map(([key, bucket]) => ({
      key,
      label: bucket.label,
      severity: bucket.severity,
      description: bucket.description,
      count: bucket.count,
    }));

    const totalIssues = summary.reduce((acc, item) => acc + item.count, 0);

    return {
      ok: true,
      ts: Date.now(),
      usersCount: waIds.length,
      totalIssues,
      summary,
      items: buckets,
    };
  }

  async function buildExecutiveDashboardData() {
    const [usersRaw, global, window24hCount, systemPlans, inconsistencyData] = await Promise.all([
      listUsers(),
      getGlobalDescriptionMetrics(),
      countWindow24hActive(),
      listPlans({ includeInactive: true }),
      collectInconsistencies(),
    ]);

    const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
    const now = nowMs();
    const planMap = buildPlanMap(systemPlans);
    const users = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));

    const statusCounts = getCrmStatusCounters();
    const paymentCounts = { CARD: 0, PIX: 0, NONE: 0, OTHER: 0 };
    const planCounts = new Map();
    const cityCounts = new Map();

    let activePaidUsers = 0;
    let totalMrrCents = 0;
    let withName = 0;
    let withBizProfile = 0;
    let withPendingBizProfile = 0;
    let withAsaasCustomer = 0;
    let withAsaasSubscription = 0;
    let withBilling = 0;
    let issueUsers = 0;

    for (const user of users) {
      const status = String(user?.status || "").trim().toUpperCase();
      if (statusCounts[status] === undefined) statusCounts.UNKNOWN += 1;
      else statusCounts[status] += 1;

      const payment = String(user?.paymentMethod || "").trim().toUpperCase();
      if (payment === "CARD") paymentCounts.CARD += 1;
      else if (payment === "PIX") paymentCounts.PIX += 1;
      else if (!payment) paymentCounts.NONE += 1;
      else paymentCounts.OTHER += 1;

      if (user?.fullName) withName += 1;
      if (user?.hasBizProfile) withBizProfile += 1;
      if (user?.hasPendingBizProfile) withPendingBizProfile += 1;
      if (user?.asaasCustomerId) withAsaasCustomer += 1;
      if (user?.asaasSubscriptionId) withAsaasSubscription += 1;
      if (user?.billingCityState || user?.billingAddress) withBilling += 1;
      if ((user?.issueCount || 0) > 0) issueUsers += 1;

      const city = String(user?.billingCityState || "").trim();
      if (city) cityCounts.set(city, (cityCounts.get(city) || 0) + 1);

      const planCode = String(user?.plan || "").trim().toUpperCase();
      const planMeta = planCode ? planMap.get(planCode) : null;
      if (planCode) {
        const prev = planCounts.get(planCode) || {
          code: planCode,
          name: String(planMeta?.name || planCode),
          description: String(planMeta?.description || ""),
          priceCents: Number(planMeta?.priceCents || 0),
          count: 0,
          mrrCents: 0,
        };
        prev.count += 1;
        if (status === "ACTIVE" && Number.isFinite(Number(planMeta?.priceCents))) {
          prev.mrrCents += Number(planMeta?.priceCents || 0);
        }
        planCounts.set(planCode, prev);
      }

      if (status === "ACTIVE" && planMeta) {
        activePaidUsers += 1;
        totalMrrCents += Number(planMeta?.priceCents || 0);
      }
    }

    const totalUsers = users.length;
    const activeUsers = statusCounts.ACTIVE || 0;
    const trialUsers = statusCounts.TRIAL || 0;
    const paymentPendingUsers = statusCounts.PAYMENT_PENDING || 0;
    const waitPlanUsers = statusCounts.WAIT_PLAN || 0;
    const blockedUsers = statusCounts.BLOCKED || 0;
    const avgTicketCents = activePaidUsers ? Math.round(totalMrrCents / activePaidUsers) : 0;
    const avgDescriptionsPerActive = activeUsers ? Number((Number(global?.monthCount || 0) / activeUsers).toFixed(2)) : 0;
    const conversionBase = activeUsers + trialUsers;
    const trialToPaidPct = conversionBase > 0 ? Number(((activeUsers / conversionBase) * 100).toFixed(1)) : 0;
    const baseActivationPct = totalUsers > 0 ? Number(((activeUsers / totalUsers) * 100).toFixed(1)) : 0;
    const profileCoveragePct = totalUsers > 0 ? Number(((withBizProfile / totalUsers) * 100).toFixed(1)) : 0;
    const nameCoveragePct = totalUsers > 0 ? Number(((withName / totalUsers) * 100).toFixed(1)) : 0;
    const inconsistencyPct = totalUsers > 0 ? Number(((issueUsers / totalUsers) * 100).toFixed(1)) : 0;

    const plans = Array.from(planCounts.values()).sort((a, b) => {
      if (b.mrrCents !== a.mrrCents) return b.mrrCents - a.mrrCents;
      if (b.count !== a.count) return b.count - a.count;
      return String(a.code).localeCompare(String(b.code));
    });

    const cities = Array.from(cityCounts.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => (b.count - a.count) || String(a.city).localeCompare(String(b.city)))
      .slice(0, 8);

    const payments = [
      { type: "CARD", count: paymentCounts.CARD },
      { type: "PIX", count: paymentCounts.PIX },
      { type: "Sem método", count: paymentCounts.NONE },
      { type: "Outro", count: paymentCounts.OTHER },
    ];

    return {
      ok: true,
      ts: Date.now(),
      overview: {
        totalUsers,
        activeUsers,
        trialUsers,
        paymentPendingUsers,
        waitPlanUsers,
        blockedUsers,
        activeSharePct: baseActivationPct,
        trialToPaidPct,
      },
      revenue: {
        mrrCents: totalMrrCents,
        avgTicketCents,
        activePaidUsers,
      },
      usage: {
        descriptionsToday: Number(global?.dayCount || 0),
        descriptionsMonth: Number(global?.monthCount || 0),
        dayLabel: String(global?.day || ""),
        monthLabel: String(global?.month || ""),
        window24hCount: Number(window24hCount || 0),
        avgDescriptionsPerActive,
      },
      quality: {
        withName,
        withBizProfile,
        withPendingBizProfile,
        withAsaasCustomer,
        withAsaasSubscription,
        withBilling,
        issueUsers,
        profileCoveragePct,
        nameCoveragePct,
        inconsistencyPct,
      },
      statusCounts,
      payments,
      plans,
      cities,
      inconsistencies: inconsistencyData,
    };
  }

  router.get("/executive/data", async (req, res) => {
    try {
      const data = await buildExecutiveDashboardData();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/executive-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧠 Dashboard Executivo SaaS</h3>
            <div class="muted">Visão gerencial do produto: base de usuários, receita estimada, uso do sistema e saúde operacional.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/dashboard">Dashboard operacional</a>
            <a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>
            <button type="button" class="primary" id="reloadExecutiveBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Usuários totais</div><div class="v" id="exTotalUsers">—</div><div class="muted" id="exActiveShare">—</div></div>
        <div class="kpi"><div class="t">Assinantes ativos</div><div class="v" id="exActiveUsers">—</div><div class="muted" id="exTrialToPaid">—</div></div>
        <div class="kpi"><div class="t">MRR estimado</div><div class="v" id="exMrr">—</div><div class="muted" id="exAvgTicket">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Descrições hoje</div><div class="v" id="exDescToday">—</div><div class="muted" id="exDescTodayLabel">—</div></div>
        <div class="kpi"><div class="t">Descrições no mês</div><div class="v" id="exDescMonth">—</div><div class="muted" id="exDescMonthLabel">—</div></div>
        <div class="kpi"><div class="t">Usuários ativos 24h</div><div class="v" id="ex24hUsers">—</div><div class="muted" id="exAvgUsage">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Perfis com empresa salva</div><div class="v" id="exBizProfiles">—</div><div class="muted" id="exBizProfilesPct">—</div></div>
        <div class="kpi"><div class="t">Cadastros com nome</div><div class="v" id="exWithName">—</div><div class="muted" id="exWithNamePct">—</div></div>
        <div class="kpi"><div class="t">Usuários com inconsistência</div><div class="v" id="exIssueUsers">—</div><div class="muted" id="exIssuePct">—</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Distribuição da base</h4>
            <span class="muted">Status atuais</span>
          </div>
          <div class="hr"></div>
          <div id="statusPills"></div>
          <div class="hr"></div>
          <div id="paymentPills"></div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Saúde operacional</h4>
            <a class="pill" href="/admin/audit-ui">Auditoria</a>
          </div>
          <div class="hr"></div>
          <div id="healthPills"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Planos e MRR</h4>
            <span class="muted">Ranking atual</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>Plano</th>
                  <th>Usuários</th>
                  <th>MRR</th>
                  <th>Descrição</th>
                </tr>
              </thead>
              <tbody id="plansRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Top cidades / região</h4>
            <span class="muted">billingCityState</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Usuários</th>
                </tr>
              </thead>
              <tbody id="citiesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h4 style="margin:0;">Resumo de inconsistências</h4>
            <div class="muted">Leitura consolidada do painel de inconsistências.</div>
          </div>
          <a class="pill" href="/admin/inconsistencies-ui">Abrir painel completo</a>
        </div>
        <div class="hr"></div>
        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>Indicador</th>
                <th>Nível</th>
                <th>Qtd.</th>
                <th>Descrição</th>
              </tr>
            </thead>
            <tbody id="issuesRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="executiveRaw" style="white-space:pre-wrap; overflow:auto; max-height:360px;"></pre>
        </details>
      </div>
    `;

    const scriptExtra = `
      <script>
        (function(){
          function esc(value){
            return String(value ?? '')
              .replaceAll('&','&amp;')
              .replaceAll('<','&lt;')
              .replaceAll('>','&gt;')
              .replaceAll('"','&quot;')
              .replaceAll("'",'&#39;');
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value ?? '—');
          }
          function fmtBRL(cents){
            const v = (Number(cents) || 0) / 100;
            try { return v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
            catch (_) { return 'R$ ' + v.toFixed(2); }
          }
          function fmtPct(value){
            const n = Number(value || 0);
            return n.toFixed(1).replace('.', ',') + '%';
          }
          function severityBadge(severity){
            const s = String(severity || 'soft').toLowerCase();
            const cls = ['danger','warn','info','ok'].includes(s) ? s : 'soft';
            const label = cls === 'danger' ? 'Crítico' : cls === 'warn' ? 'Atenção' : cls === 'info' ? 'Info' : 'OK';
            return '<span class="badge ' + cls + '">' + label + '</span>';
          }
          function renderPills(containerId, items, formatter){
            const el = document.getElementById(containerId);
            if (!el) return;
            if (!Array.isArray(items) || !items.length) {
              el.innerHTML = '<span class="muted">Sem dados.</span>';
              return;
            }
            el.innerHTML = items.map(function(item){ return formatter(item); }).join(' ');
          }
          function renderTableRows(containerId, rowsHtml, emptyColspan, emptyText){
            const el = document.getElementById(containerId);
            if (!el) return;
            el.innerHTML = rowsHtml || '<tr><td colspan="' + String(emptyColspan) + '" class="muted">' + esc(emptyText || 'Sem dados.') + '</td></tr>';
          }
          async function loadExecutive(){
            const response = await fetch('/admin/executive/data');
            const data = await response.json().catch(function(){ return {}; });
            document.getElementById('executiveRaw').textContent = JSON.stringify(data, null, 2);
            if (!response.ok || !data.ok) {
              renderTableRows('plansRows', '', 4, 'Erro ao carregar dashboard executivo.');
              renderTableRows('citiesRows', '', 2, 'Erro ao carregar dashboard executivo.');
              renderTableRows('issuesRows', '', 4, 'Erro ao carregar dashboard executivo.');
              return;
            }

            const overview = data.overview || {};
            const revenue = data.revenue || {};
            const usage = data.usage || {};
            const quality = data.quality || {};
            const statusCounts = data.statusCounts || {};
            const payments = Array.isArray(data.payments) ? data.payments : [];
            const plans = Array.isArray(data.plans) ? data.plans : [];
            const cities = Array.isArray(data.cities) ? data.cities : [];
            const issues = Array.isArray(data?.inconsistencies?.summary) ? data.inconsistencies.summary : [];

            setText('exTotalUsers', overview.totalUsers || 0);
            setText('exActiveShare', 'Ativação da base: ' + fmtPct(overview.activeSharePct || 0));
            setText('exActiveUsers', overview.activeUsers || 0);
            setText('exTrialToPaid', 'Conversão trial → pago: ' + fmtPct(overview.trialToPaidPct || 0));
            setText('exMrr', fmtBRL(revenue.mrrCents || 0));
            setText('exAvgTicket', 'Ticket médio: ' + fmtBRL(revenue.avgTicketCents || 0));

            setText('exDescToday', usage.descriptionsToday || 0);
            setText('exDescTodayLabel', usage.dayLabel ? ('Dia ' + usage.dayLabel) : 'Sem referência');
            setText('exDescMonth', usage.descriptionsMonth || 0);
            setText('exDescMonthLabel', usage.monthLabel ? ('Mês ' + usage.monthLabel) : 'Sem referência');
            setText('ex24hUsers', usage.window24hCount || 0);
            setText('exAvgUsage', 'Média por ativo: ' + String(usage.avgDescriptionsPerActive || 0).replace('.', ','));

            setText('exBizProfiles', quality.withBizProfile || 0);
            setText('exBizProfilesPct', 'Cobertura: ' + fmtPct(quality.profileCoveragePct || 0));
            setText('exWithName', quality.withName || 0);
            setText('exWithNamePct', 'Cobertura: ' + fmtPct(quality.nameCoveragePct || 0));
            setText('exIssueUsers', quality.issueUsers || 0);
            setText('exIssuePct', 'Base afetada: ' + fmtPct(quality.inconsistencyPct || 0));

            renderPills('statusPills', [
              { label: 'TRIAL', value: statusCounts.TRIAL || 0 },
              { label: 'ACTIVE', value: statusCounts.ACTIVE || 0 },
              { label: 'WAIT_PLAN', value: statusCounts.WAIT_PLAN || 0 },
              { label: 'PAYMENT_PENDING', value: statusCounts.PAYMENT_PENDING || 0 },
              { label: 'BLOCKED', value: statusCounts.BLOCKED || 0 },
              { label: 'UNKNOWN', value: statusCounts.UNKNOWN || 0 }
            ], function(item){
              return '<span class="pill"><b>' + esc(item.label) + '</b>: ' + esc(item.value) + '</span>';
            });

            renderPills('paymentPills', payments, function(item){
              return '<span class="pill"><b>' + esc(item.type) + '</b>: ' + esc(item.count) + '</span>';
            });

            renderPills('healthPills', [
              { label: 'Com Asaas Customer', value: quality.withAsaasCustomer || 0 },
              { label: 'Com assinatura Asaas', value: quality.withAsaasSubscription || 0 },
              { label: 'Com billing preenchido', value: quality.withBilling || 0 },
              { label: 'Perfil pendente', value: quality.withPendingBizProfile || 0 }
            ], function(item){
              return '<span class="pill"><b>' + esc(item.label) + '</b>: ' + esc(item.value) + '</span>';
            });

            const plansRows = plans.map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.name || item.code || '—') + '</b><div class="muted" style="font-size:12px;">' + esc(item.code || '') + '</div></td>' +
                '<td>' + esc(item.count || 0) + '</td>' +
                '<td>' + esc(fmtBRL(item.mrrCents || 0)) + '</td>' +
                '<td>' + esc(item.description || '—') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('plansRows', plansRows, 4, 'Nenhum plano encontrado.');

            const citiesRows = cities.map(function(item){
              return '<tr><td>' + esc(item.city || '—') + '</td><td><b>' + esc(item.count || 0) + '</b></td></tr>';
            }).join('');
            renderTableRows('citiesRows', citiesRows, 2, 'Nenhuma cidade/região preenchida.');

            const issuesRows = issues.map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.label || '') + '</b></td>' +
                '<td>' + severityBadge(item.severity) + '</td>' +
                '<td><b>' + esc(item.count || 0) + '</b></td>' +
                '<td>' + esc(item.description || '') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('issuesRows', issuesRows, 4, 'Nenhuma inconsistência encontrada.');
          }

          document.addEventListener('DOMContentLoaded', function(){
            const reloadBtn = document.getElementById('reloadExecutiveBtn');
            if (reloadBtn) reloadBtn.addEventListener('click', loadExecutive);
            loadExecutive();
          });
        })();
      </script>
    `;

    const html = layoutBase({
      title: "Dashboard Executivo",
      activePath: "/admin/executive-ui",
      content: inner,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

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

    const snapshots = await mapLimitDashboard(users, 25, async (id) => {
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
          <span class="pill">👥 Total de Usuários: <b id="uTotal">—</b></span>
          <span class="pill">🧪 Em Teste: <b id="uTrial">—</b></span>
          <span class="pill">🟢 Assinantes Ativos: <b id="uActive">—</b></span>
          <span class="pill">⏳ Aguardando Plano: <b id="uWait">—</b></span>
          <span class="pill">💳 Pagamento Pendente: <b id="uPayPend">—</b></span>
          <span class="pill">🔒 Bloqueados: <b id="uBlocked">—</b></span>
          <span class="pill">⚠️ Inconsistentes: <b id="uUnknown">—</b></span>
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
              <a class="card pad" href="/admin/executive-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">🧠 Dashboard Executivo</div>
                <div class="muted">Visão gerencial de base, receita e saúde.</div>
              </a>
              <a class="card pad" href="/admin/users-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">👥 Usuários</div>
                <div class="muted">Consulta e ações por waId.</div>
              </a>
              <a class="card pad" href="/admin/bulk-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">🧰 Ações em massa</div>
                <div class="muted">Operações em lote para usuários filtrados.</div>
              </a>
              <a class="card pad" href="/admin/plans" style="display:block;">
                <div class="muted" style="font-weight:700;">💳 Planos</div>
                <div class="muted">Gerenciar catálogo e ativação.</div>
              </a>
              <a class="card pad" href="/admin/broadcast-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📣 Broadcast</div>
                <div class="muted">Criar envios por plano e janela.</div>
              </a>
              <a class="card pad" href="/admin/reports-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📑 Relatórios e Exportação</div>
                <div class="muted">Relatórios gerenciais, gráficos e downloads do sistema.</div>
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
              <a class="pill" href="/admin/audit-ui">📚 Auditoria</a>
              <a class="pill" href="/admin/executive-ui">🧠 Dashboard Executivo</a>
              <a class="pill" href="/admin/reports-ui">📑 Relatórios</a>
              <a class="pill" href="/admin/asaas-test-ui">🧪 Asaas Teste</a>
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
  // 🛠️ Configurações Globais
  // -----------------------------
  router.get("/settings", async (req, res) => {
    try {
      const rows = await getResolvedGlobalSettings();
      return res.json({ ok: true, items: rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/settings", async (req, res) => {
    try {
      const key = String(req.body?.key || "").trim();
      const def = GLOBAL_SETTINGS_CATALOG.find((item) => item.key === key);
      if (!def) return res.status(400).json({ ok: false, error: "invalid setting key" });

      const beforeStored = await redisGet(settingRedisKey(def.key));
      const normalized = normalizeSettingValue(def, req.body?.value);
      await redisSet(settingRedisKey(def.key), serializeSettingValue(def, normalized));
      await safeRecordAdminAudit(req, {
        module: "settings",
        action: "SET_GLOBAL_SETTING",
        targetId: def.key,
        targetLabel: def.label,
        summary: `Atualizou a configuração global ${def.key}.`,
        before: { storedValue: beforeStored },
        after: { value: normalized },
        meta: { key: def.key, type: def.type },
      });

      return res.json({ ok: true, key: def.key, value: normalized });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/settings/reset", async (req, res) => {
    try {
      const key = String(req.body?.key || "").trim();
      const def = GLOBAL_SETTINGS_CATALOG.find((item) => item.key === key);
      if (!def) return res.status(400).json({ ok: false, error: "invalid setting key" });

      const beforeStored = await redisGet(settingRedisKey(def.key));
      await redisDel(settingRedisKey(def.key));
      await safeRecordAdminAudit(req, {
        module: "settings",
        action: "RESET_GLOBAL_SETTING",
        targetId: def.key,
        targetLabel: def.label,
        summary: `Resetou a configuração global ${def.key} para o padrão.`,
        before: { storedValue: beforeStored },
        after: { value: def.defaultValue, reset: true },
        meta: { key: def.key },
      });
      return res.json({ ok: true, key: def.key, value: def.defaultValue, reset: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/settings-ui", async (req, res) => {
    const rows = await getResolvedGlobalSettings();
    const groups = groupGlobalSettings(rows);

    const cards = groups.map(({ section, items }) => {
      const body = items.map((row) => {
        const inputHtml = (() => {
          if (row.type === "bool") {
            return `<label class="pill"><input type="checkbox" data-setting-input="${escapeHtml(row.key)}" ${row.value ? "checked" : ""} /> Ativo</label>`;
          }
          if (row.type === "enum") {
            const options = (row.options || []).map((opt) => `<option value="${escapeHtml(opt)}" ${String(opt) === String(row.value) ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("");
            return `<select data-setting-input="${escapeHtml(row.key)}">${options}</select>`;
          }
          if (row.type === "int") {
            const min = Number.isFinite(row.min) ? ` min="${escapeHtml(String(row.min))}"` : "";
            const max = Number.isFinite(row.max) ? ` max="${escapeHtml(String(row.max))}"` : "";
            return `<input type="number" data-setting-input="${escapeHtml(row.key)}" value="${escapeHtml(String(row.value))}"${min}${max} />`;
          }
          return `<input type="text" data-setting-input="${escapeHtml(row.key)}" value="${escapeHtml(String(row.value || ""))}" />`;
        })();

        return `
          <tr>
            <td>
              <div><b>${escapeHtml(row.label)}</b></div>
              <div class="muted" style="font-size:12px;">${escapeHtml(row.key)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(row.help || "")}</div>
            </td>
            <td>${inputHtml}</td>
            <td><code>${escapeHtml(String(row.defaultValue ?? ""))}</code></td>
            <td>${row.isCustom ? '<span class="badge warn">custom</span>' : '<span class="badge soft">default</span>'}</td>
            <td>
              <div class="row">
                <button type="button" class="primary" data-save-setting="${escapeHtml(row.key)}">Salvar</button>
                <button type="button" data-reset-setting="${escapeHtml(row.key)}">Resetar</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");

      return `
        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">${escapeHtml(section)}</h3>
              <div class="muted">Configurações globais persistidas no Redis.</div>
            </div>
          </div>
          <div class="hr"></div>
          <table>
            <thead>
              <tr>
                <th>Configuração</th>
                <th>Valor atual</th>
                <th>Padrão</th>
                <th>Origem</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      `;
    }).join("");

    const html = layoutBase({
      title: "Configurações Globais",
      activePath: "/admin/settings-ui",
      content: `
        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">🛠️ Configurações Globais</h3>
              <div class="muted">Controle operacional centralizado do sistema. Essas regras não substituem os planos; elas complementam o comportamento global.</div>
            </div>
            <div class="pill">Persistência: <b>Redis</b></div>
          </div>
        </div>
        ${cards}
        <div class="card pad">
          <details>
            <summary class="muted">Ver JSON resolvido</summary>
            <pre id="settingsRaw" style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(rows, null, 2))}</pre>
          </details>
        </div>
      `,
      scriptExtra: `
        <script>
          (function(){
            async function postJson(url, body){
              const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
              const j = await r.json().catch(()=>({}));
              return { r, j };
            }
            function readSettingValue(key){
              const el = document.querySelector('[data-setting-input="' + CSS.escape(key) + '"]');
              if (!el) return '';
              if (el.type === 'checkbox') return !!el.checked;
              return el.value;
            }
            async function saveSetting(key){
              const value = readSettingValue(key);
              const out = await postJson('/admin/settings', { key, value });
              if (!out.r.ok || !out.j.ok) {
                alert('Falha ao salvar configuração.');
                return;
              }
              window.location.reload();
            }
            async function resetSetting(key){
              const out = await postJson('/admin/settings/reset', { key });
              if (!out.r.ok || !out.j.ok) {
                alert('Falha ao resetar configuração.');
                return;
              }
              window.location.reload();
            }
            document.addEventListener('click', function(ev){
              const saveBtn = ev.target.closest('[data-save-setting]');
              if (saveBtn) {
                saveSetting(saveBtn.getAttribute('data-save-setting'));
                return;
              }
              const resetBtn = ev.target.closest('[data-reset-setting]');
              if (resetBtn) {
                resetSetting(resetBtn.getAttribute('data-reset-setting'));
              }
            });
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // 👥 Usuários — Lista (UI)
  // -----------------------------
  router.get("/users-list-ui", async (req, res) => {
    const content = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">Lista de usuários</h3>
            <div class="muted">Visualize rapidamente: Nome, waId, plano e janela 24h. Expanda cada linha para ver os dados completos do usuário.</div>
          </div>
          <div class="row">
            <button type="button" id="usersReloadTop">Recarregar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="gap:10px; flex-wrap:wrap;">
          <input id="uSearch" placeholder="Buscar por nome ou waId..." style="min-width:320px" />
          <input id="uLimit" type="number" min="1" max="500" value="200" style="width:110px" />
          <button type="button" class="primary" id="usersLoadBtn">Carregar</button>
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
                <th style="width:140px;">Ações</th>
              </tr>
            </thead>
            <tbody id="uTbody">
              <tr><td colspan="6" class="muted">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            users: [],
            meta: { total: 0, offset: 0, limit: 200 }
          };

          const els = {
            search: document.getElementById("uSearch"),
            limit: document.getElementById("uLimit"),
            tbody: document.getElementById("uTbody"),
            meta: document.getElementById("uMeta"),
            reloadTop: document.getElementById("usersReloadTop"),
            loadBtn: document.getElementById("usersLoadBtn"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function windowLabel(user){
            if (!user || !user.lastInboundTs) return "—";
            if (user.inWindow) {
              return "Ativa (até " + fmtTs(user.windowExpiresAt) + ")";
            }
            return "Fora (última inbound em " + fmtTs(user.lastInboundTs) + ")";
          }

          function setTbody(html){
            if (els.tbody) els.tbody.innerHTML = html;
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(() => ({}));
            return { response, json };
          }

          function getFilteredUsers(){
            const q = String(els.search?.value || "").trim().toLowerCase();
            if (!q) return state.users.slice();
            return state.users.filter(function(user){
              const name = String(user?.fullName || "").toLowerCase();
              const wa = String(user?.waId || "");
              return name.includes(q) || wa.includes(q);
            });
          }

          function renderUsers(){
            const filtered = getFilteredUsers();

            if (els.meta) {
              els.meta.textContent = String(filtered.length) + " exibidos • Total base: " + String(state.meta.total || 0);
            }

            if (!filtered.length) {
              setTbody('<tr><td colspan="6" class="muted">Nenhum usuário encontrado.</td></tr>');
              return;
            }

            const rows = [];
            filtered.forEach(function(user){
              const waId = String(user?.waId || "").trim();
              const expId = "user-exp-" + waId;
              rows.push(
                '<tr data-wa-id="' + esc(waId) + '">' +
                  '<td>' + esc(user?.fullName || "—") + '</td>' +
                  '<td><code>' + esc(waId) + '</code></td>' +
                  '<td>' + esc(user?.status || "—") + '</td>' +
                  '<td>' + esc(user?.plan || "—") + '</td>' +
                  '<td>' + esc(windowLabel(user)) + '</td>' +
                  '<td>' +
                    '<div class="row">' +
                      '<button type="button" data-action="toggle-user" data-wa-id="' + esc(waId) + '">Expandir</button>' +
                      '<button type="button" data-action="open-actions" data-wa-id="' + esc(waId) + '">Abrir</button>' +
                    '</div>' +
                  '</td>' +
                '</tr>'
              );
              rows.push(
                '<tr id="' + esc(expId) + '" data-expand-row="1" data-wa-id="' + esc(waId) + '" style="display:none;">' +
                  '<td colspan="6"><div class="muted">Carregando...</div></td>' +
                '</tr>'
              );
            });

            setTbody(rows.join(""));
          }

          async function reloadUsers(){
            const limit = Math.max(1, Math.min(500, Number(els.limit?.value || 200) || 200));
            setTbody('<tr><td colspan="6" class="muted">Carregando...</td></tr>');

            try {
              const out = await fetchJson("/admin/users/list?limit=" + encodeURIComponent(limit));
              if (!out.response.ok || !out.json.ok) {
                setTbody('<tr><td colspan="6" class="muted">Erro ao carregar usuários.</td></tr>');
                return;
              }

              state.users = Array.isArray(out.json.items) ? out.json.items : [];
              state.meta = {
                total: Number(out.json.total || 0),
                offset: Number(out.json.offset || 0),
                limit: Number(out.json.limit || limit)
              };
              renderUsers();
            } catch (_) {
              setTbody('<tr><td colspan="6" class="muted">Erro ao carregar usuários.</td></tr>');
            }
          }

          function buildDetailsHtml(snapshot, inWindow){
            const s = snapshot || {};
            const docLine = (s.doc && s.doc.docType) ? (s.doc.docType + " • " + (s.doc.docLast4 || "")) : "—";
            return '' +
              '<div class="row" style="justify-content:space-between; align-items:flex-start;">' +
                '<div>' +
                  '<div><b>' + esc(s.fullName || "—") + '</b> <span class="muted">(' + esc(s.waId || "") + ')</span></div>' +
                  '<div class="muted">Status: <b>' + esc(s.status || "—") + '</b> • Plano: <b>' + esc(s.plan || "—") + '</b> • Janela 24h: <b>' + esc(inWindow ? "Ativa" : "Fora") + '</b></div>' +
                '</div>' +
                '<div class="row">' +
                  '<button type="button" data-action="open-actions" data-wa-id="' + esc(s.waId || "") + '">Abrir nas ações</button>' +
                  '<button type="button" data-action="close-user" data-wa-id="' + esc(s.waId || "") + '">Fechar</button>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Dados pessoais</div>' +
                  '<div class="muted">Nome: <b>' + esc(s.fullName || "—") + '</b></div>' +
                  '<div class="muted">Documento: <b>' + esc(docLine) + '</b></div>' +
                  '<div class="muted">Cidade/UF: <b>' + esc(s.billingCityState || "—") + '</b></div>' +
                  '<div class="muted">Endereço: <b>' + esc(s.billingAddress || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Assinatura / Cobrança</div>' +
                  '<div class="muted">Status: <b>' + esc(s.status || "—") + '</b></div>' +
                  '<div class="muted">Plano: <b>' + esc(s.plan || "—") + '</b></div>' +
                  '<div class="muted">Pagamento: <b>' + esc(s.paymentMethod || "—") + '</b></div>' +
                  '<div class="muted">Asaas Customer: <code>' + esc(s.asaasCustomerId || "—") + '</code></div>' +
                  '<div class="muted">Asaas Subscription: <code>' + esc(s.asaasSubscriptionId || "—") + '</code></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<details>' +
                '<summary class="muted">Ver JSON completo (inclui perfil da empresa)</summary>' +
                '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(s, null, 2)) + '</pre>' +
              '</details>';
          }

          async function toggleUserRow(waId){
            const row = document.getElementById("user-exp-" + String(waId || ""));
            if (!row) return;

            const isHidden = row.style.display === "none";
            if (!isHidden) {
              row.style.display = "none";
              return;
            }

            row.style.display = "";
            row.querySelector("td").innerHTML = '<div class="muted">Carregando...</div>';

            try {
              const out = await fetchJson("/admin/users/details?waId=" + encodeURIComponent(waId));
              if (!out.response.ok || !out.json.ok) {
                row.querySelector("td").innerHTML = '<div class="muted">Erro ao carregar detalhes.</div>';
                return;
              }
              row.querySelector("td").innerHTML = buildDetailsHtml(out.json.snapshot || {}, !!out.json.inWindow);
            } catch (_) {
              row.querySelector("td").innerHTML = '<div class="muted">Erro ao carregar detalhes.</div>';
            }
          }

          function openActions(waId){
            window.location.href = "/admin/users-ui?waId=" + encodeURIComponent(waId);
          }

          if (els.search) {
            els.search.addEventListener("input", renderUsers);
          }
          if (els.reloadTop) {
            els.reloadTop.addEventListener("click", reloadUsers);
          }
          if (els.loadBtn) {
            els.loadBtn.addEventListener("click", reloadUsers);
          }
          if (els.tbody) {
            els.tbody.addEventListener("click", function(ev){
              const button = ev.target.closest("button[data-action]");
              if (!button) return;
              const action = button.getAttribute("data-action");
              const waId = button.getAttribute("data-wa-id") || "";
              if (!waId) return;

              if (action === "toggle-user") {
                toggleUserRow(waId);
                return;
              }
              if (action === "close-user") {
                const row = document.getElementById("user-exp-" + waId);
                if (row) row.style.display = "none";
                return;
              }
              if (action === "open-actions") {
                openActions(waId);
              }
            });
          }

          reloadUsers();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Usuários • Lista",
      activePath: "/admin/users-list-ui",
      content,
      scriptExtra,
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

  router.get("/users/snapshot", async (req, res) => {
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
      const beforeUser = await getUserSnapshot(waId);
      await setUserStatus(waId, status);
      const user = await getUserSnapshot(waId);
      await safeRecordAdminAudit(req, {
        module: "users",
        action: "SET_USER_STATUS",
        waId,
        targetId: waId,
        summary: `Alterou o status do usuário ${waId} para ${status}.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(user),
        meta: { status },
      });
      return res.json({ ok: true, waId, status, user });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/users/clear-lastprompt", async (req, res) => {
    try {
      const waId = requireWaId(req);
      const beforeUser = await getUserSnapshot(waId);
      await clearLastPrompt(waId);
      const user = await getUserSnapshot(waId);
      await safeRecordAdminAudit(req, {
        module: "users",
        action: "CLEAR_LAST_PROMPT",
        waId,
        targetId: waId,
        summary: `Limpou o último prompt salvo do usuário ${waId}.`,
        before: { lastPrompt: limitText(beforeUser?.lastPrompt || "", 500) },
        after: { lastPrompt: limitText(user?.lastPrompt || "", 500) },
      });
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
      const input = req.body || {};
      const plan = await upsertPlan(input);
      await safeRecordAdminAudit(req, {
        module: "plans",
        action: "UPSERT_PLAN",
        targetId: String(plan?.code || "").trim(),
        targetLabel: String(plan?.name || "").trim(),
        summary: `Criou ou atualizou o plano ${String(plan?.code || "").trim()}.`,
        after: plan,
        meta: { code: String(plan?.code || "").trim() },
      });
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post("/plans/:code/active", async (req, res) => {
    try {
      const active = Boolean(req.body?.active);
      const plan = await setPlanActive(req.params.code, active);
      await safeRecordAdminAudit(req, {
        module: "plans",
        action: "SET_PLAN_ACTIVE",
        targetId: String(plan?.code || req.params.code || "").trim(),
        targetLabel: String(plan?.name || "").trim(),
        summary: `${active ? "Ativou" : "Desativou"} o plano ${String(plan?.code || req.params.code || "").trim()}.`,
        after: plan,
        meta: { active },
      });
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

  router.get("/audit/list", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 100) || 100));
      const pull = Math.max(limit, Math.min(1500, Number(req.query?.pull || limit * 4) || (limit * 4)));
      const q = String(req.query?.q || "").trim().toLowerCase();
      const moduleFilter = String(req.query?.module || "ALL").trim().toUpperCase();
      const actionFilter = String(req.query?.action || "ALL").trim().toUpperCase();
      const waIdFilter = String(req.query?.waId || "").trim();
      const items = await listAdminAudit({ limit: pull });
      const totalStored = await getAdminAuditCount();

      const modules = Array.from(new Set(items.map((item) => String(item?.module || "").trim()).filter(Boolean))).sort();
      const actions = Array.from(new Set(items.map((item) => String(item?.action || "").trim()).filter(Boolean))).sort();

      const filtered = items.filter((item) => {
        const moduleValue = String(item?.module || "").trim().toUpperCase();
        const actionValue = String(item?.action || "").trim().toUpperCase();
        const waIdValue = String(item?.waId || item?.targetId || "").trim();
        if (moduleFilter !== "ALL" && moduleValue !== moduleFilter) return false;
        if (actionFilter !== "ALL" && actionValue !== actionFilter) return false;
        if (waIdFilter && waIdValue !== waIdFilter) return false;
        if (q) {
          const hay = [
            item?.id,
            item?.module,
            item?.action,
            item?.summary,
            item?.waId,
            item?.targetId,
            item?.targetLabel,
            item?.actor?.user,
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      return res.status(200).json({
        ok: true,
        totalStored,
        pulled: items.length,
        filteredCount: filtered.length,
        modules,
        actions,
        items: filtered.slice(0, limit),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/audit-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">📚 Auditoria administrativa</h3>
            <div class="muted">Rastreie alterações feitas no painel: usuário, configurações, planos, textos do bot e ações operacionais.</div>
          </div>
          <div class="row" style="gap:8px;">
            <button type="button" class="primary" id="auditRefreshBtn">Atualizar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3" style="align-items:end;">
          <div>
            <div class="muted" style="margin-bottom:6px;">Busca</div>
            <input id="auditQ" placeholder="ação, usuário, resumo ou módulo" />
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Módulo</div>
            <select id="auditModule"><option value="ALL">Todos</option></select>
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Ação</div>
            <select id="auditAction"><option value="ALL">Todas</option></select>
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">waId</div>
            <input id="auditWaId" placeholder="5511... (opcional)" />
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Itens exibidos</div>
            <input id="auditLimit" type="number" min="20" max="500" value="100" />
          </div>
          <div class="row" style="align-items:center; gap:8px;">
            <button type="button" class="primary" id="auditApplyBtn">Aplicar filtros</button>
            <button type="button" id="auditClearBtn">Limpar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <span class="pill">Eventos salvos: <b id="auditTotalStored">—</b></span>
          <span class="pill">Eventos lidos: <b id="auditPulled">—</b></span>
          <span class="pill">Filtrados: <b id="auditFiltered">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="auditTableWrap" class="muted">Carregando…</div>
      </div>

      <div id="auditModal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:60; padding:24px;">
        <div class="card" style="max-width:980px; margin:0 auto; max-height:calc(100vh - 48px); overflow:auto;">
          <div class="pad">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
              <div>
                <h3 style="margin:0 0 6px 0;">Detalhes do evento</h3>
                <div class="muted" id="auditModalSub">—</div>
              </div>
              <button type="button" id="auditModalClose">Fechar</button>
            </div>
            <div class="hr"></div>
            <pre id="auditModalPre" style="white-space:pre-wrap; overflow:auto; max-height:70vh;"></pre>
          </div>
        </div>
      </div>
    `;

    const html = layoutBase({
      title: "Auditoria administrativa",
      activePath: "/admin/audit-ui",
      content: inner,
      scriptExtra: `
        <script>
          (function(){
            const state = { items: [] };
            const els = {
              q: document.getElementById('auditQ'),
              module: document.getElementById('auditModule'),
              action: document.getElementById('auditAction'),
              waId: document.getElementById('auditWaId'),
              limit: document.getElementById('auditLimit'),
              tableWrap: document.getElementById('auditTableWrap'),
              totalStored: document.getElementById('auditTotalStored'),
              pulled: document.getElementById('auditPulled'),
              filtered: document.getElementById('auditFiltered'),
              modal: document.getElementById('auditModal'),
              modalPre: document.getElementById('auditModalPre'),
              modalSub: document.getElementById('auditModalSub'),
            };

            function esc(value){
              return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
            }

            function fillSelect(el, values, current){
              if (!el) return;
              const keep = String(current || 'ALL');
              const options = ['<option value="ALL">Todos</option>'];
              (Array.isArray(values) ? values : []).forEach(function(value){
                const v = String(value || '').trim();
                if (!v) return;
                options.push('<option value="' + esc(v) + '"' + (v === keep ? ' selected' : '') + '>' + esc(v) + '</option>');
              });
              el.innerHTML = options.join('');
            }

            function readFilters(){
              return {
                q: String(els.q?.value || '').trim(),
                module: String(els.module?.value || 'ALL').trim(),
                action: String(els.action?.value || 'ALL').trim(),
                waId: String(els.waId?.value || '').trim(),
                limit: String(els.limit?.value || '100').trim(),
              };
            }

            function buildQuery(){
              const params = new URLSearchParams();
              const filters = readFilters();
              Object.keys(filters).forEach(function(key){
                const value = filters[key];
                if (key === 'limit') { params.set('limit', value || '100'); return; }
                if (value && value !== 'ALL') params.set(key, value);
              });
              return params.toString();
            }

            async function fetchJson(url){
              const response = await fetch(url);
              const json = await response.json().catch(() => ({}));
              return { response, json };
            }

            function openModal(item){
              els.modalPre.textContent = JSON.stringify(item || {}, null, 2);
              els.modalSub.textContent = [item?.ts, item?.module, item?.action].filter(Boolean).join(' • ') || '—';
              els.modal.style.display = 'block';
            }

            function closeModal(){
              els.modal.style.display = 'none';
            }

            function renderTable(items){
              if (!Array.isArray(items) || !items.length) {
                els.tableWrap.innerHTML = '<div class="muted">Nenhum evento encontrado.</div>';
                return;
              }
              const rows = items.map(function(item, index){
                const actor = item?.actor?.user || 'admin';
                const target = item?.waId || item?.targetId || item?.targetLabel || '—';
                const summary = item?.summary || '—';
                return '<tr>' +
                  '<td><code>' + esc(item?.ts || '') + '</code></td>' +
                  '<td>' + esc(item?.module || '') + '</td>' +
                  '<td>' + esc(item?.action || '') + '</td>' +
                  '<td><code>' + esc(target) + '</code></td>' +
                  '<td style="max-width:420px; white-space:pre-wrap;">' + esc(summary) + '</td>' +
                  '<td>' + esc(actor) + '</td>' +
                  '<td><button type="button" data-action="open-audit" data-index="' + index + '">Ver detalhes</button></td>' +
                '</tr>';
              }).join('');
              els.tableWrap.innerHTML = '<div style="overflow:auto;"><table style="min-width:980px;"><thead><tr><th>Quando</th><th>Módulo</th><th>Ação</th><th>Alvo</th><th>Resumo</th><th>Responsável</th><th>Ação</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
            }

            async function loadAudit(){
              els.tableWrap.innerHTML = '<div class="muted">Carregando…</div>';
              const query = buildQuery();
              const { response, json } = await fetchJson('/admin/audit/list?' + query);
              if (!response.ok || !json.ok) {
                els.tableWrap.innerHTML = '<div class="muted">Erro ao carregar auditoria.</div>';
                return;
              }
              state.items = Array.isArray(json.items) ? json.items : [];
              els.totalStored.textContent = String(json.totalStored || 0);
              els.pulled.textContent = String(json.pulled || 0);
              els.filtered.textContent = String(json.filteredCount || 0);
              fillSelect(els.module, json.modules || [], readFilters().module);
              fillSelect(els.action, json.actions || [], readFilters().action);
              renderTable(state.items);
            }

            document.getElementById('auditRefreshBtn').addEventListener('click', loadAudit);
            document.getElementById('auditApplyBtn').addEventListener('click', loadAudit);
            document.getElementById('auditClearBtn').addEventListener('click', function(){
              els.q.value = '';
              els.module.value = 'ALL';
              els.action.value = 'ALL';
              els.waId.value = '';
              els.limit.value = '100';
              loadAudit();
            });
            els.tableWrap.addEventListener('click', function(ev){
              const btn = ev.target.closest('[data-action="open-audit"]');
              if (!btn) return;
              const idx = Number(btn.getAttribute('data-index') || -1);
              if (idx < 0 || idx >= state.items.length) return;
              openModal(state.items[idx]);
            });
            document.getElementById('auditModalClose').addEventListener('click', closeModal);
            els.modal.addEventListener('click', function(ev){ if (ev.target === els.modal) closeModal(); });
            document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape' && els.modal.style.display === 'block') closeModal(); });
            document.addEventListener('DOMContentLoaded', loadAudit);
            loadAudit();
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/crm/list", async (req, res) => {
    try {
      const q = String(req.query?.q || "").trim().toLowerCase();
      const statusFilter = String(req.query?.status || "ALL").trim().toUpperCase();
      const planFilter = String(req.query?.plan || "ALL").trim().toUpperCase();
      const paymentFilter = String(req.query?.paymentMethod || "ALL").trim().toUpperCase();
      const hasName = String(req.query?.hasName || "ALL").trim().toUpperCase();
      const hasSubscription = String(req.query?.hasSubscription || "ALL").trim().toUpperCase();
      const hasBizProfile = String(req.query?.hasBizProfile || "ALL").trim().toUpperCase();
      const hasInconsistency = String(req.query?.hasInconsistency || "ALL").trim().toUpperCase();
      const inWindowFilter = String(req.query?.inWindow || "ALL").trim().toUpperCase();
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));

      const usersRaw = await listUsers();
      const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const now = nowMs();

      const enriched = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));
      const validItems = Array.isArray(enriched) ? enriched.filter((item) => item && !item.__error) : [];
      const statusSummary = getCrmStatusCounters();

      for (const item of validItems) {
        const st = String(item?.status || "").trim().toUpperCase() || "UNKNOWN";
        if (statusSummary[st] === undefined) statusSummary.UNKNOWN++;
        else statusSummary[st]++;
      }

      const filtered = validItems.filter((item) => {
        if (!item) return false;
        if (q) {
          const hay = [item.waId, item.fullName, item.plan, item.planName, item.billingCityState].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (statusFilter !== "ALL" && String(item.status || "").toUpperCase() !== statusFilter) return false;
        if (planFilter !== "ALL" && String(item.plan || "").toUpperCase() !== planFilter) return false;
        if (paymentFilter !== "ALL" && String(item.paymentMethod || "").toUpperCase() !== paymentFilter) return false;
        if (hasName === "YES" && !String(item.fullName || "").trim()) return false;
        if (hasName === "NO" && String(item.fullName || "").trim()) return false;
        if (hasSubscription === "YES" && !String(item.asaasSubscriptionId || "").trim()) return false;
        if (hasSubscription === "NO" && String(item.asaasSubscriptionId || "").trim()) return false;
        if (hasBizProfile === "YES" && !item.hasBizProfile) return false;
        if (hasBizProfile === "NO" && item.hasBizProfile) return false;
        if (hasInconsistency === "YES" && !(Number(item.issueCount || 0) > 0)) return false;
        if (hasInconsistency === "NO" && Number(item.issueCount || 0) > 0) return false;
        if (inWindowFilter === "YES" && !item.inWindow) return false;
        if (inWindowFilter === "NO" && item.inWindow) return false;
        return true;
      });

      const planCodes = Array.from(new Set(validItems.map((item) => String(item.plan || "").trim().toUpperCase()).filter(Boolean))).sort();

      return res.status(200).json({
        ok: true,
        totalUsers: waIds.length,
        filteredCount: filtered.length,
        limit,
        availablePlans: planCodes,
        statusSummary,
        items: filtered.slice(0, limit),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/crm/user", async (req, res) => {
    try {
      const waId = String(req.query?.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "waId required" });

      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const user = await enrichUserForCrm(waId, planMap, nowMs());
      return res.status(200).json({ ok: true, user });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });


  router.get("/bulk/list", async (req, res) => {
    try {
      const q = String(req.query?.q || "").trim().toLowerCase();
      const statusFilter = String(req.query?.status || "ALL").trim().toUpperCase();
      const planFilter = String(req.query?.plan || "ALL").trim().toUpperCase();
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));

      const usersRaw = await listUsers();
      const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const now = nowMs();
      const enriched = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));
      const validItems = Array.isArray(enriched) ? enriched.filter((item) => item && !item.__error) : [];

      const filtered = validItems.filter((item) => {
        if (!item) return false;
        if (q) {
          const hay = [item.waId, item.fullName, item.plan, item.planName, item.billingCityState, item.paymentMethod].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (statusFilter !== "ALL" && String(item.status || "").toUpperCase() !== statusFilter) return false;
        if (planFilter !== "ALL" && String(item.plan || "").toUpperCase() !== planFilter) return false;
        return true;
      });

      const availablePlans = Array.from(new Set((Array.isArray(plans) ? plans : []).map((plan) => String(plan?.code || "").trim().toUpperCase()).filter(Boolean))).sort();

      return res.status(200).json({
        ok: true,
        totalUsers: waIds.length,
        filteredCount: filtered.length,
        availablePlans,
        limit,
        items: filtered.slice(0, limit),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.post("/bulk/apply", async (req, res) => {
    try {
      const operation = String(req.body?.operation || "").trim().toUpperCase();
      const waIdsRaw = Array.isArray(req.body?.waIds) ? req.body.waIds : [];
      const waIds = Array.from(new Set(waIdsRaw.map((value) => String(value || "").trim()).filter(Boolean)));
      const value = String(req.body?.value || "").trim();

      if (!operation) return res.status(400).json({ ok: false, error: "operation required" });
      if (!waIds.length) return res.status(400).json({ ok: false, error: "waIds required" });

      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const normalizedPlan = String(value || "").trim().toUpperCase();
      const allowedStatus = new Set(["TRIAL", "ACTIVE", "WAIT_PLAN", "PAYMENT_PENDING", "BLOCKED"]);
      const normalizedStatus = String(value || "").trim().toUpperCase();

      if (operation === "SET_PLAN" && normalizedPlan && !planMap.get(normalizedPlan)) {
        return res.status(400).json({ ok: false, error: "invalid plan" });
      }
      if (operation === "SET_STATUS" && !allowedStatus.has(normalizedStatus)) {
        return res.status(400).json({ ok: false, error: "invalid status" });
      }

      const results = [];

      for (const waId of waIds) {
        try {
          const beforeUser = await getUserSnapshot(waId);
          let summary = "";
          let meta = { operation };

          if (operation === "SET_STATUS") {
            await setUserStatus(waId, normalizedStatus);
            summary = `Alterou o status do usuário ${waId} para ${normalizedStatus}.`;
            meta = { operation, status: normalizedStatus };
          } else if (operation === "BLOCK_USERS") {
            await setUserStatus(waId, "BLOCKED");
            summary = `Bloqueou o usuário ${waId}.`;
          } else if (operation === "UNBLOCK_TO_TRIAL") {
            await resetUserToTrial(waId);
            summary = `Desbloqueou o usuário ${waId} retornando para TRIAL.`;
          } else if (operation === "SET_PLAN") {
            await setUserPlan(waId, normalizedPlan);
            summary = `Alterou o plano do usuário ${waId} para ${normalizedPlan}.`;
            meta = { operation, plan: normalizedPlan };
          } else if (operation === "CLEAR_PLAN") {
            await setUserPlan(waId, "");
            summary = `Removeu o plano salvo do usuário ${waId}.`;
          } else if (operation === "RESET_TRIAL") {
            await resetUserToTrial(waId);
            summary = `Resetou o usuário ${waId} para o estado de trial.`;
          } else if (operation === "CLEAR_QUOTA") {
            await setUserQuotaUsed(waId, 0);
            summary = `Zerou o uso mensal do usuário ${waId}.`;
          } else if (operation === "CLEAR_TRIAL_USED") {
            await setUserTrialUsed(waId, 0);
            summary = `Zerou o uso de trial do usuário ${waId}.`;
          } else {
            return res.status(400).json({ ok: false, error: "unsupported operation" });
          }

          const afterUser = await getUserSnapshot(waId);
          await safeRecordAdminAudit(req, {
            module: "bulk",
            action: operation,
            waId,
            targetId: waId,
            summary,
            before: buildAuditUserSnapshot(beforeUser),
            after: buildAuditUserSnapshot(afterUser),
            meta,
          });

          results.push({ ok: true, waId, before: buildAuditUserSnapshot(beforeUser), after: buildAuditUserSnapshot(afterUser) });
        } catch (err) {
          results.push({ ok: false, waId, error: String(err?.message || err) });
        }
      }

      return res.status(200).json({
        ok: true,
        operation,
        requested: waIds.length,
        successCount: results.filter((item) => item.ok).length,
        errorCount: results.filter((item) => !item.ok).length,
        results,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/bulk-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧰 Ações em massa</h3>
            <div class="muted">Selecione usuários filtrados e aplique operações em lote com segurança.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/crm-ui">CRM</a>
            <a class="pill" href="/admin/users-list-ui">Lista simples</a>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Busca</div>
            <input id="bulkQ" placeholder="Nome, waId, plano, cidade ou pagamento..." />
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Status</div>
            <select id="bulkStatus">
              <option value="ALL">Todos</option>
              <option value="TRIAL">TRIAL</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="WAIT_PLAN">WAIT_PLAN</option>
              <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
              <option value="BLOCKED">BLOCKED</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Plano</div>
            <select id="bulkPlanFilter"><option value="ALL">Todos</option></select>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <input id="bulkLimit" type="number" min="1" max="500" value="200" style="width:120px;" />
          <button class="primary" type="button" id="bulkReloadBtn">Atualizar</button>
          <button type="button" id="bulkResetBtn">Limpar filtros</button>
          <button type="button" id="bulkSelectFilteredBtn">Selecionar filtrados</button>
          <button type="button" id="bulkClearSelectionBtn">Limpar seleção</button>
          <div id="bulkMeta" class="muted" style="margin-left:auto;"></div>
        </div>

        <div class="hr"></div>

        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Operação em lote</h4>
              <div class="muted">Tudo que for executado aqui impactará todos os usuários selecionados.</div>
            </div>
            <div class="pill">Selecionados: <b id="bulkSelectedCount">0</b></div>
          </div>
          <div class="hr"></div>
          <div class="grid cols3">
            <div>
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Ação</div>
              <select id="bulkOperation">
                <option value="SET_STATUS">Alterar status</option>
                <option value="BLOCK_USERS">Bloquear usuários</option>
                <option value="UNBLOCK_TO_TRIAL">Desbloquear para trial</option>
                <option value="SET_PLAN">Alterar plano</option>
                <option value="CLEAR_PLAN">Remover plano</option>
                <option value="RESET_TRIAL">Resetar trial</option>
                <option value="CLEAR_QUOTA">Zerar uso mensal</option>
                <option value="CLEAR_TRIAL_USED">Zerar uso do teste</option>
              </select>
            </div>
            <div id="bulkStatusValueWrap">
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Novo status</div>
              <select id="bulkStatusValue">
                <option value="TRIAL">TRIAL</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="WAIT_PLAN">WAIT_PLAN</option>
                <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
                <option value="BLOCKED">BLOCKED</option>
              </select>
            </div>
            <div id="bulkPlanValueWrap" style="display:none;">
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Novo plano</div>
              <select id="bulkPlanValue"><option value="">Selecione...</option></select>
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <button class="primary" type="button" id="bulkApplyBtn">Aplicar ação</button>
            <div class="muted">As operações são registradas na auditoria administrativa.</div>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Usuários filtrados</h4>
              <div class="muted">Selecione os usuários na tabela antes de aplicar a operação.</div>
            </div>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table style="min-width:1040px;">
              <thead>
                <tr>
                  <th><input id="bulkToggleVisible" type="checkbox" /></th>
                  <th>Nome</th>
                  <th>waId</th>
                  <th>Status</th>
                  <th>Plano</th>
                  <th>Pagamento</th>
                  <th>Janela 24h</th>
                  <th>Inconsistências</th>
                </tr>
              </thead>
              <tbody id="bulkTbody"><tr><td colspan="8" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad" style="margin-top:14px;">
          <details>
            <summary class="muted">Ver JSON da última execução</summary>
            <pre id="bulkResult" style="white-space:pre-wrap; overflow:auto; max-height:360px;">{}</pre>
          </details>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            data: null,
            selected: new Set(),
          };

          const els = {
            q: document.getElementById("bulkQ"),
            status: document.getElementById("bulkStatus"),
            planFilter: document.getElementById("bulkPlanFilter"),
            limit: document.getElementById("bulkLimit"),
            reloadBtn: document.getElementById("bulkReloadBtn"),
            resetBtn: document.getElementById("bulkResetBtn"),
            selectFilteredBtn: document.getElementById("bulkSelectFilteredBtn"),
            clearSelectionBtn: document.getElementById("bulkClearSelectionBtn"),
            meta: document.getElementById("bulkMeta"),
            selectedCount: document.getElementById("bulkSelectedCount"),
            operation: document.getElementById("bulkOperation"),
            statusValueWrap: document.getElementById("bulkStatusValueWrap"),
            statusValue: document.getElementById("bulkStatusValue"),
            planValueWrap: document.getElementById("bulkPlanValueWrap"),
            planValue: document.getElementById("bulkPlanValue"),
            applyBtn: document.getElementById("bulkApplyBtn"),
            tbody: document.getElementById("bulkTbody"),
            result: document.getElementById("bulkResult"),
            toggleVisible: document.getElementById("bulkToggleVisible"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function windowLabel(user){
            if (!user || !user.lastInboundTs) return "—";
            return user.inWindow ? ("Ativa até " + fmtTs(user.windowExpiresAt)) : ("Fora (última em " + fmtTs(user.lastInboundTs) + ")");
          }

          function setResult(value){
            if (els.result) els.result.textContent = JSON.stringify(value ?? {}, null, 2);
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(function(){ return {}; });
            return { response, json };
          }

          function buildQuery(){
            const params = new URLSearchParams();
            const q = String(els.q?.value || "").trim();
            const status = String(els.status?.value || "ALL").trim();
            const plan = String(els.planFilter?.value || "ALL").trim();
            const limit = String(els.limit?.value || "200").trim();
            if (q) params.set("q", q);
            if (status) params.set("status", status);
            if (plan) params.set("plan", plan);
            if (limit) params.set("limit", limit);
            return params.toString();
          }

          function syncSelectionCounter(){
            if (els.selectedCount) els.selectedCount.textContent = String(state.selected.size);
          }

          function syncActionInputs(){
            const op = String(els.operation?.value || "").trim().toUpperCase();
            if (els.statusValueWrap) els.statusValueWrap.style.display = op === "SET_STATUS" ? "block" : "none";
            if (els.planValueWrap) els.planValueWrap.style.display = op === "SET_PLAN" ? "block" : "none";
          }

          function fillPlanOptions(plans){
            const list = Array.isArray(plans) ? plans : [];
            const options = ['<option value="ALL">Todos</option>'].concat(list.map(function(code){ return '<option value="' + esc(code) + '">' + esc(code) + '</option>'; }));
            if (els.planFilter) els.planFilter.innerHTML = options.join("");
            if (els.planValue) {
              els.planValue.innerHTML = '<option value="">Selecione...</option>' + list.map(function(code){ return '<option value="' + esc(code) + '">' + esc(code) + '</option>'; }).join("");
            }
          }

          function renderRows(items){
            if (!els.tbody) return;
            const rows = Array.isArray(items) ? items : [];
            if (!rows.length) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhum usuário encontrado.</td></tr>';
              return;
            }
            els.tbody.innerHTML = rows.map(function(user){
              const waId = String(user?.waId || "").trim();
              const checked = state.selected.has(waId) ? ' checked' : '';
              const issues = Number(user?.issueCount || 0);
              const issueBadge = issues > 0 ? '<span class="badge warn">' + esc(issues) + '</span>' : '<span class="badge ok">0</span>';
              return '<tr>' +
                '<td><input type="checkbox" data-action="toggle-user" data-waid="' + esc(waId) + '"' + checked + ' /></td>' +
                '<td><b>' + esc(user?.fullName || '—') + '</b></td>' +
                '<td><code>' + esc(waId) + '</code></td>' +
                '<td>' + esc(user?.status || '—') + '</td>' +
                '<td>' + esc(user?.plan || '—') + '</td>' +
                '<td>' + esc(user?.paymentMethod || '—') + '</td>' +
                '<td>' + esc(windowLabel(user)) + '</td>' +
                '<td>' + issueBadge + '</td>' +
              '</tr>';
            }).join("");
          }

          async function loadBulk(){
            if (els.tbody) els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Carregando...</td></tr>';
            const out = await fetchJson('/admin/bulk/list?' + buildQuery());
            setResult(out.json);
            if (!out.response.ok || !out.json.ok) {
              if (els.tbody) els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Erro ao carregar usuários.</td></tr>';
              return;
            }
            state.data = out.json;
            fillPlanOptions(out.json.availablePlans || []);
            renderRows(out.json.items || []);
            if (els.meta) els.meta.textContent = String(out.json.filteredCount || 0) + ' filtrados • Base: ' + String(out.json.totalUsers || 0);
            syncSelectionCounter();
          }

          async function applyBulk(){
            const waIds = Array.from(state.selected.values());
            if (!waIds.length) {
              alert('Selecione pelo menos um usuário.');
              return;
            }
            const operation = String(els.operation?.value || '').trim().toUpperCase();
            let value = '';
            if (operation === 'SET_STATUS') value = String(els.statusValue?.value || '').trim();
            if (operation === 'SET_PLAN') value = String(els.planValue?.value || '').trim();
            if (operation === 'SET_PLAN' && !value) {
              alert('Selecione um plano.');
              return;
            }
            const out = await fetchJson('/admin/bulk/apply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ operation, waIds, value }),
            });
            setResult(out.json);
            if (!out.response.ok || !out.json.ok) {
              alert('Falha ao executar a ação em massa.');
              return;
            }
            await loadBulk();
          }

          if (els.reloadBtn) els.reloadBtn.addEventListener('click', loadBulk);
          if (els.resetBtn) els.resetBtn.addEventListener('click', function(){
            if (els.q) els.q.value = '';
            if (els.status) els.status.value = 'ALL';
            if (els.planFilter) els.planFilter.value = 'ALL';
            if (els.limit) els.limit.value = '200';
            loadBulk();
          });
          if (els.selectFilteredBtn) els.selectFilteredBtn.addEventListener('click', function(){
            const items = Array.isArray(state.data?.items) ? state.data.items : [];
            items.forEach(function(user){
              const waId = String(user?.waId || '').trim();
              if (waId) state.selected.add(waId);
            });
            renderRows(items);
            syncSelectionCounter();
          });
          if (els.clearSelectionBtn) els.clearSelectionBtn.addEventListener('click', function(){
            state.selected.clear();
            renderRows(state.data?.items || []);
            syncSelectionCounter();
          });
          if (els.operation) els.operation.addEventListener('change', syncActionInputs);
          if (els.applyBtn) els.applyBtn.addEventListener('click', applyBulk);
          if (els.toggleVisible) els.toggleVisible.addEventListener('change', function(ev){
            const checked = !!ev.target.checked;
            const items = Array.isArray(state.data?.items) ? state.data.items : [];
            items.forEach(function(user){
              const waId = String(user?.waId || '').trim();
              if (!waId) return;
              if (checked) state.selected.add(waId);
              else state.selected.delete(waId);
            });
            renderRows(items);
            syncSelectionCounter();
          });
          if (els.tbody) els.tbody.addEventListener('change', function(ev){
            const target = ev.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.getAttribute('data-action') !== 'toggle-user') return;
            const waId = String(target.getAttribute('data-waid') || '').trim();
            if (!waId) return;
            if (target.checked) state.selected.add(waId);
            else state.selected.delete(waId);
            syncSelectionCounter();
          });

          syncActionInputs();
          loadBulk();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Ações em Massa",
      activePath: "/admin/bulk-ui",
      content: inner,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/crm-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧭 CRM de usuários</h3>
            <div class="muted">Central única para localizar usuários, filtrar contas e abrir uma ficha completa com assinatura, uso, empresa e inconsistências.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/users-list-ui">Lista simples</a>
            <a class="pill" href="/admin/users-ui">Ações por waId</a>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Busca</div>
            <input id="crmQ" placeholder="Nome, waId, plano ou cidade..." />
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Status</div>
            <select id="crmStatus">
              <option value="ALL">Todos</option>
              <option value="TRIAL">TRIAL</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="WAIT_PLAN">WAIT_PLAN</option>
              <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
              <option value="BLOCKED">BLOCKED</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Plano</div>
            <select id="crmPlan"><option value="ALL">Todos</option></select>
          </div>
        </div>

        <div class="grid cols3" style="margin-top:12px;">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Pagamento</div>
            <select id="crmPayment">
              <option value="ALL">Todos</option>
              <option value="CARD">CARD</option>
              <option value="PIX">PIX</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem nome</div>
            <select id="crmHasName">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem assinatura Asaas</div>
            <select id="crmHasSubscription">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
        </div>

        <div class="grid cols3" style="margin-top:12px;">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem perfil da empresa</div>
            <select id="crmHasBizProfile">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem inconsistência</div>
            <select id="crmHasInconsistency">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Janela 24h ativa</div>
            <select id="crmInWindow">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <input id="crmLimit" type="number" min="1" max="500" value="200" style="width:120px;" />
          <button class="primary" type="button" id="crmReloadBtn">Atualizar</button>
          <button type="button" id="crmResetBtn">Limpar filtros</button>
          <div id="crmMeta" class="muted" style="margin-left:auto;"></div>
        </div>

        <div class="hr"></div>

        <div class="row" id="crmSummary" style="gap:8px; flex-wrap:wrap;"></div>

        <div class="hr"></div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Usuários filtrados</h4>
              <div class="muted">Use os filtros para localizar a conta e abra a ficha completa em uma janela maior.</div>
            </div>
            <div class="muted">A ficha agora abre em pop-up para não cortar o conteúdo.</div>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table style="min-width:1000px;">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>waId</th>
                  <th>Status</th>
                  <th>Plano</th>
                  <th>Pagamento</th>
                  <th>Janela 24h</th>
                  <th>Inconsistências</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody id="crmTbody">
                <tr><td colspan="8" class="muted">Carregando...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="crmModal" class="crm-modal" aria-hidden="true">
          <div class="crm-modal-backdrop" data-action="close-crm-modal"></div>
          <div class="crm-modal-panel" role="dialog" aria-modal="true" aria-labelledby="crmModalTitle">
            <div class="crm-modal-header">
              <div>
                <h4 id="crmModalTitle" style="margin:0;">Ficha do usuário</h4>
                <div class="muted">Visão consolidada da conta</div>
              </div>
              <button type="button" id="crmCloseModalBtn">Fechar</button>
            </div>
            <div class="hr"></div>
            <div id="crmDetail" class="crm-modal-body muted">Selecione um usuário na tabela para abrir a ficha completa.</div>
          </div>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            lastData: null
          };

          const els = {
            q: document.getElementById("crmQ"),
            status: document.getElementById("crmStatus"),
            plan: document.getElementById("crmPlan"),
            payment: document.getElementById("crmPayment"),
            hasName: document.getElementById("crmHasName"),
            hasSubscription: document.getElementById("crmHasSubscription"),
            hasBizProfile: document.getElementById("crmHasBizProfile"),
            hasInconsistency: document.getElementById("crmHasInconsistency"),
            inWindow: document.getElementById("crmInWindow"),
            limit: document.getElementById("crmLimit"),
            reloadBtn: document.getElementById("crmReloadBtn"),
            resetBtn: document.getElementById("crmResetBtn"),
            meta: document.getElementById("crmMeta"),
            summary: document.getElementById("crmSummary"),
            tbody: document.getElementById("crmTbody"),
            detail: document.getElementById("crmDetail"),
            modal: document.getElementById("crmModal"),
            modalTitle: document.getElementById("crmModalTitle"),
            closeModalBtn: document.getElementById("crmCloseModalBtn"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function fmtIssueCount(n){
            const v = Number(n || 0);
            if (v <= 0) return '<span class="badge ok">sem pendências</span>';
            if (v === 1) return '<span class="badge warn">1 pendência</span>';
            return '<span class="badge danger">' + esc(v) + ' pendências</span>';
          }

          function openDetailModal(title){
            if (els.modalTitle) els.modalTitle.textContent = title || "Ficha do usuário";
            if (els.modal) {
              els.modal.classList.add("open");
              els.modal.setAttribute("aria-hidden", "false");
              document.body.style.overflow = "hidden";
            }
          }

          function closeDetailModal(){
            if (els.modal) {
              els.modal.classList.remove("open");
              els.modal.setAttribute("aria-hidden", "true");
              document.body.style.overflow = "";
            }
          }

          function readFilters(){
            return {
              q: String(els.q?.value || "").trim(),
              status: String(els.status?.value || "ALL").trim(),
              plan: String(els.plan?.value || "ALL").trim(),
              paymentMethod: String(els.payment?.value || "ALL").trim(),
              hasName: String(els.hasName?.value || "ALL").trim(),
              hasSubscription: String(els.hasSubscription?.value || "ALL").trim(),
              hasBizProfile: String(els.hasBizProfile?.value || "ALL").trim(),
              hasInconsistency: String(els.hasInconsistency?.value || "ALL").trim(),
              inWindow: String(els.inWindow?.value || "ALL").trim(),
              limit: String(els.limit?.value || "200").trim(),
            };
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(() => ({}));
            return { response, json };
          }

          function buildQuery(){
            const params = new URLSearchParams();
            const filters = readFilters();
            Object.keys(filters).forEach(function(key){
              const value = filters[key];
              if (key === "limit") {
                params.set(key, value || "200");
                return;
              }
              if (value && value !== "ALL") params.set(key, value);
            });
            return params.toString();
          }

          function renderSummary(data){
            const st = data?.statusSummary || {};
            const cards = [
              ["Total filtrado", data?.filteredCount ?? 0],
              ["Total base", data?.totalUsers ?? 0],
              ["TRIAL", st.TRIAL ?? 0],
              ["ACTIVE", st.ACTIVE ?? 0],
              ["WAIT_PLAN", st.WAIT_PLAN ?? 0],
              ["PAYMENT_PENDING", st.PAYMENT_PENDING ?? 0],
              ["BLOCKED", st.BLOCKED ?? 0]
            ];
            els.summary.innerHTML = cards.map(function(card){
              return '<span class="pill">' + esc(card[0]) + ': <b>' + esc(card[1]) + '</b></span>';
            }).join("");
            els.meta.textContent = String(data?.filteredCount ?? 0) + " usuário(s) exibidos";
          }

          function syncPlanOptions(plans){
            const current = String(els.plan?.value || "ALL").trim();
            const options = ['<option value="ALL">Todos</option>'];
            (Array.isArray(plans) ? plans : []).forEach(function(plan){
              options.push('<option value="' + esc(plan) + '">' + esc(plan) + '</option>');
            });
            els.plan.innerHTML = options.join("");
            const exists = Array.from(els.plan.options).some(function(opt){ return opt.value === current; });
            els.plan.value = exists ? current : "ALL";
          }

          function renderTable(items){
            const rows = Array.isArray(items) ? items : [];
            if (!rows.length) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhum usuário encontrado para os filtros aplicados.</td></tr>';
              return;
            }

            els.tbody.innerHTML = rows.map(function(user){
              const waId = String(user?.waId || "").trim();
              const planLabel = user.planName ? (String(user.plan || "") + " · " + String(user.planName || "")) : (user.plan || "—");
              const win = user.inWindow
                ? ("Ativa até " + fmtTs(user.windowExpiresAt))
                : (user.lastInboundTs ? ("Fora desde " + fmtTs(user.lastInboundTs)) : "—");

              return '' +
                '<tr data-wa-id="' + esc(waId) + '">' +
                  '<td>' + esc(user?.fullName || "—") + '</td>' +
                  '<td><code>' + esc(waId) + '</code></td>' +
                  '<td>' + esc(user?.status || "—") + '</td>' +
                  '<td>' + esc(planLabel || "—") + '</td>' +
                  '<td>' + esc(user?.paymentMethod || "—") + '</td>' +
                  '<td>' + esc(win) + '</td>' +
                  '<td>' + fmtIssueCount(user?.issueCount) + '</td>' +
                  '<td><button type="button" data-action="open-crm-user" data-wa-id="' + esc(waId) + '">Abrir ficha</button></td>' +
                '</tr>';
            }).join("");
          }

          function renderDetail(user){
            if (!user) {
              els.detail.innerHTML = '<div class="muted">Usuário não encontrado.</div>';
              openDetailModal("Ficha do usuário");
              return;
            }

            const doc = user.doc && user.doc.docType ? (user.doc.docType + " • " + (user.doc.docLast4 || "")) : "—";
            const bizProfile = user.bizProfile
              ? '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.bizProfile, null, 2)) + '</pre>'
              : '<div class="muted">Nenhum perfil salvo.</div>';
            const pendingBiz = user.pendingBizProfile
              ? '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.pendingBizProfile, null, 2)) + '</pre>'
              : '<div class="muted">Nenhum dado pendente.</div>';
            const issues = Array.isArray(user.issueKeys) && user.issueKeys.length
              ? '<div class="row" style="gap:6px; flex-wrap:wrap;">' + user.issueKeys.map(function(key){
                  return '<span class="badge warn soft">' + esc(key) + '</span>';
                }).join("") + '</div>'
              : '<span class="badge ok">Sem inconsistências</span>';

            els.detail.innerHTML = '' +
              '<div class="row" style="justify-content:space-between; align-items:flex-start;">' +
                '<div>' +
                  '<h3 style="margin:0 0 6px 0;">' + esc(user.fullName || "Sem nome") + '</h3>' +
                  '<div class="muted"><code>' + esc(user.waId || "") + '</code></div>' +
                '</div>' +
                '<div class="row">' +
                  '<a class="pill" href="/admin/users-ui?waId=' + encodeURIComponent(user.waId || "") + '">Ações</a>' +
                  '<a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Conta</div>' +
                  '<div class="muted">Status: <b>' + esc(user.status || "—") + '</b></div>' +
                  '<div class="muted">Plano: <b>' + esc(user.plan || "—") + '</b></div>' +
                  '<div class="muted">Nome do plano: <b>' + esc(user.planName || "—") + '</b></div>' +
                  '<div class="muted">Template: <b>' + esc(user.templateMode || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Uso</div>' +
                  '<div class="muted">quotaUsed: <b>' + esc(user.quotaUsed) + '</b></div>' +
                  '<div class="muted">trialUsed: <b>' + esc(user.trialUsed) + '</b></div>' +
                  '<div class="muted">Janela 24h: <b>' + esc(user.inWindow ? "Ativa" : "Fora") + '</b></div>' +
                  '<div class="muted">Última inbound: <b>' + esc(fmtTs(user.lastInboundTs)) + '</b></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Cobrança</div>' +
                  '<div class="muted">Pagamento: <b>' + esc(user.paymentMethod || "—") + '</b></div>' +
                  '<div class="muted">Asaas Customer: <code>' + esc(user.asaasCustomerId || "—") + '</code></div>' +
                  '<div class="muted">Asaas Subscription: <code>' + esc(user.asaasSubscriptionId || "—") + '</code></div>' +
                  '<div class="muted">Cancelado em: <b>' + esc(user.cardCanceledAt || "—") + '</b></div>' +
                  '<div class="muted">Válido até: <b>' + esc(user.cardValidUntil || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Cadastro</div>' +
                  '<div class="muted">Documento: <b>' + esc(doc) + '</b></div>' +
                  '<div class="muted">Cidade/UF: <b>' + esc(user.billingCityState || "—") + '</b></div>' +
                  '<div class="muted">Endereço: <b>' + esc(user.billingAddress || "—") + '</b></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div><b>Inconsistências encontradas</b></div>' +
              '<div style="margin-top:8px;">' + issues + '</div>' +
              '<div class="hr"></div>' +
              '<details open><summary><b>Perfil da empresa salvo</b></summary>' + bizProfile + '</details>' +
              '<div class="hr"></div>' +
              '<details><summary><b>Perfil da empresa pendente</b></summary>' + pendingBiz + '</details>' +
              '<div class="hr"></div>' +
              '<details><summary><b>JSON completo</b></summary><pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.snapshot || {}, null, 2)) + '</pre></details>';

            openDetailModal(user.fullName || user.waId || "Ficha do usuário");
          }

          async function loadCrm(){
            const out = await fetchJson("/admin/crm/list?" + buildQuery());
            if (!out.response.ok || !out.json.ok) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Falha ao carregar CRM.</td></tr>';
              els.detail.innerHTML = '<div class="muted">Falha ao carregar dados.</div>';
              return;
            }

            state.lastData = out.json;
            syncPlanOptions(out.json.availablePlans);
            renderSummary(out.json);
            renderTable(out.json.items);
          }

          async function loadCrmUser(waId){
            if (!waId) return;
            const out = await fetchJson("/admin/crm/user?waId=" + encodeURIComponent(waId));
            if (!out.response.ok || !out.json.ok) {
              els.detail.innerHTML = '<div class="muted">Falha ao carregar a ficha do usuário.</div>';
              openDetailModal("Ficha do usuário");
              return;
            }
            renderDetail(out.json.user);
          }

          function resetCrmFilters(){
            if (els.q) els.q.value = "";
            if (els.status) els.status.value = "ALL";
            if (els.plan) els.plan.value = "ALL";
            if (els.payment) els.payment.value = "ALL";
            if (els.hasName) els.hasName.value = "ALL";
            if (els.hasSubscription) els.hasSubscription.value = "ALL";
            if (els.hasBizProfile) els.hasBizProfile.value = "ALL";
            if (els.hasInconsistency) els.hasInconsistency.value = "ALL";
            if (els.inWindow) els.inWindow.value = "ALL";
            if (els.limit) els.limit.value = "200";
            loadCrm();
          }

          if (els.reloadBtn) {
            els.reloadBtn.addEventListener("click", loadCrm);
          }
          if (els.resetBtn) {
            els.resetBtn.addEventListener("click", resetCrmFilters);
          }
          if (els.tbody) {
            els.tbody.addEventListener("click", function(ev){
              const button = ev.target.closest("button[data-action='open-crm-user']");
              if (!button) return;
              loadCrmUser(button.getAttribute("data-wa-id") || "");
            });
          }
          if (els.modal) {
            els.modal.addEventListener("click", function(ev){
              if (ev.target.closest("[data-action='close-crm-modal']")) {
                closeDetailModal();
              }
            });
          }
          if (els.closeModalBtn) {
            els.closeModalBtn.addEventListener("click", closeDetailModal);
          }
          document.addEventListener("keydown", function(ev){
            if (ev.key === "Escape") closeDetailModal();
          });

          const params = new URLSearchParams(window.location.search);
          const waId = String(params.get("waId") || "").trim();
          if (waId && els.q) els.q.value = waId;

          loadCrm().then(function(){
            if (waId) loadCrmUser(waId);
          });
        });
      </script>
    `;

    const headExtra = `
      <style>
        .crm-modal{ position:fixed; inset:0; display:none; align-items:center; justify-content:center; padding:24px; z-index:60; }
        .crm-modal.open{ display:flex; }
        .crm-modal-backdrop{ position:absolute; inset:0; background:rgba(15,23,42,.55); }
        .crm-modal-panel{ position:relative; width:min(1120px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:0 20px 48px rgba(15,23,42,.22); padding:18px; }
        .crm-modal-header{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; position:sticky; top:0; background:#fff; padding-bottom:4px; z-index:1; }
        .crm-modal-body{ min-height:120px; }
        .crm-modal-panel .grid.cols2{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .crm-modal-panel pre{ max-width:100%; overflow:auto; background:#f8fafc; border:1px solid var(--border); border-radius:12px; padding:12px; }
        @media (max-width: 980px){
          .crm-modal{ padding:12px; }
          .crm-modal-panel{ width:calc(100vw - 24px); max-height:calc(100vh - 24px); padding:14px; }
          .crm-modal-panel .grid.cols2{ grid-template-columns:1fr; }
          .crm-modal-header{ position:static; }
        }
      </style>
    `;

    const html = layoutBase({
      title: "CRM de Usuários",
      activePath: "/admin/crm-ui",
      content: inner,
      headExtra,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/reports/data", async (req, res) => {
    try {
      const data = await buildReportsCenterData(buildExecutiveDashboardData);
      return res.status(200).json(data);
    } catch (err) {
      const message = String(err?.message || err);
      return res.status(200).json(buildReportsFallbackData(message));
    }
  });

  router.get("/export/users", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportUsersRows();
      if (format === "json") {
        return sendExport(res, "amigo_usuarios", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_usuarios", "csv", rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/inconsistencies", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportInconsistencyRows();
      if (format === "json") {
        return sendExport(res, "amigo_inconsistencias", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_inconsistencias", "csv", rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/audit", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportAuditRows();
      if (format === "json") {
        return sendExport(res, "amigo_auditoria", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_auditoria", "csv", rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/executive", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const data = await buildReportsCenterData(buildExecutiveDashboardData);
      if (format === "json") {
        return sendExport(res, "amigo_relatorio_executivo", "json", data);
      }

      const rows = [];
      const overview = data?.executive?.overview || {};
      const revenue = data?.executive?.revenue || {};
      const usage = data?.executive?.usage || {};
      const quality = data?.executive?.quality || {};
      const pushMetric = (section, metric, value) => rows.push({ section, metric, value });
      pushMetric("overview", "totalUsers", overview.totalUsers || 0);
      pushMetric("overview", "activeUsers", overview.activeUsers || 0);
      pushMetric("overview", "trialUsers", overview.trialUsers || 0);
      pushMetric("overview", "paymentPendingUsers", overview.paymentPendingUsers || 0);
      pushMetric("overview", "waitPlanUsers", overview.waitPlanUsers || 0);
      pushMetric("overview", "blockedUsers", overview.blockedUsers || 0);
      pushMetric("overview", "activeSharePct", overview.activeSharePct || 0);
      pushMetric("overview", "trialToPaidPct", overview.trialToPaidPct || 0);
      pushMetric("revenue", "mrrCents", revenue.mrrCents || 0);
      pushMetric("revenue", "mrrFormatted", formatMoneyCents(revenue.mrrCents || 0));
      pushMetric("revenue", "avgTicketCents", revenue.avgTicketCents || 0);
      pushMetric("revenue", "avgTicketFormatted", formatMoneyCents(revenue.avgTicketCents || 0));
      pushMetric("usage", "descriptionsToday", usage.descriptionsToday || 0);
      pushMetric("usage", "descriptionsMonth", usage.descriptionsMonth || 0);
      pushMetric("usage", "window24hCount", usage.window24hCount || 0);
      pushMetric("usage", "avgDescriptionsPerActive", usage.avgDescriptionsPerActive || 0);
      pushMetric("quality", "withName", quality.withName || 0);
      pushMetric("quality", "withBizProfile", quality.withBizProfile || 0);
      pushMetric("quality", "issueUsers", quality.issueUsers || 0);
      pushMetric("quality", "profileCoveragePct", quality.profileCoveragePct || 0);
      pushMetric("quality", "nameCoveragePct", quality.nameCoveragePct || 0);
      pushMetric("quality", "inconsistencyPct", quality.inconsistencyPct || 0);
      return sendExport(res, "amigo_relatorio_executivo", "csv", rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/reports-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">📑 Central de Relatórios e Exportação</h3>
            <div class="muted">Relatórios executivos, visão operacional da base e exportação de dados do sistema.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/executive-ui">Dashboard Executivo</a>
            <a class="pill" href="/admin/audit-ui">Auditoria</a>
            <a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>
            <button type="button" class="primary" id="reportsReloadBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Usuários totais</div><div class="v" id="rpTotalUsers">—</div><div class="muted" id="rpActiveShare">—</div></div>
        <div class="kpi"><div class="t">MRR estimado</div><div class="v" id="rpMrr">—</div><div class="muted" id="rpAvgTicket">—</div></div>
        <div class="kpi"><div class="t">Auditoria armazenada</div><div class="v" id="rpAuditTotal">—</div><div class="muted" id="rpAuditRecent">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Descrições no mês</div><div class="v" id="rpDescMonth">—</div><div class="muted" id="rp24hUsers">—</div></div>
        <div class="kpi"><div class="t">Perfis com empresa salva</div><div class="v" id="rpBizProfiles">—</div><div class="muted" id="rpBizCoverage">—</div></div>
        <div class="kpi"><div class="t">Usuários com inconsistência</div><div class="v" id="rpIssueUsers">—</div><div class="muted" id="rpIssuePct">—</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Exportações rápidas</h4>
            <span class="muted">CSV ou JSON</span>
          </div>
          <div class="hr"></div>
          <div class="grid cols2">
            <div class="card pad">
              <b>Usuários do CRM</b>
              <div class="muted" style="margin:6px 0 10px 0;">Base completa dos usuários com status, plano, pagamento e saúde.</div>
              <div class="row">
                <a class="pill" href="/admin/export/users?format=csv">CSV</a>
                <a class="pill" href="/admin/export/users?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Inconsistências</b>
              <div class="muted" style="margin:6px 0 10px 0;">Ocorrências operacionais detalhadas por usuário.</div>
              <div class="row">
                <a class="pill" href="/admin/export/inconsistencies?format=csv">CSV</a>
                <a class="pill" href="/admin/export/inconsistencies?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Auditoria administrativa</b>
              <div class="muted" style="margin:6px 0 10px 0;">Eventos mais recentes do painel administrativo.</div>
              <div class="row">
                <a class="pill" href="/admin/export/audit?format=csv">CSV</a>
                <a class="pill" href="/admin/export/audit?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Resumo executivo</b>
              <div class="muted" style="margin:6px 0 10px 0;">Indicadores consolidados para acompanhamento gerencial.</div>
              <div class="row">
                <a class="pill" href="/admin/export/executive?format=csv">CSV</a>
                <a class="pill" href="/admin/export/executive?format=json">JSON</a>
              </div>
            </div>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Resumo operacional</h4>
            <span class="muted">Status e cobertura</span>
          </div>
          <div class="hr"></div>
          <canvas id="reportsStatusChart" width="900" height="280" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
          <div class="hr"></div>
          <canvas id="reportsPlansChart" width="900" height="280" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Planos e MRR</h4><span class="muted">Ranking atual</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Plano</th><th>Usuários</th><th>MRR</th><th>Descrição</th></tr></thead><tbody id="reportsPlansRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Top cidades / região</h4><span class="muted">billingCityState</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Local</th><th>Usuários</th></tr></thead><tbody id="reportsCitiesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Módulos mais auditados</h4><span class="muted">Últimos eventos</span></div>
          <div class="hr"></div>
          <div id="reportsModulePills" class="muted">Carregando...</div>
          <div class="hr"></div>
          <div id="reportsActionPills" class="muted">Carregando...</div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Resumo de inconsistências</h4><span class="muted">Painel consolidado</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Indicador</th><th>Nível</th><th>Qtd.</th></tr></thead><tbody id="reportsIssuesRows"><tr><td colspan="3" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Últimos eventos de auditoria</h4><span class="muted">Leitura rápida</span></div>
        <div class="hr"></div>
        <div style="overflow:auto;"><table><thead><tr><th>Quando</th><th>Módulo</th><th>Ação</th><th>Alvo</th><th>Resumo</th><th>Responsável</th></tr></thead><tbody id="reportsAuditRows"><tr><td colspan="6" class="muted">Carregando...</td></tr></tbody></table></div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="reportsRaw" style="white-space:pre-wrap; overflow:auto; max-height:360px;"></pre>
        </details>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value ?? "—");
          }
          function fmtBRL(cents){
            const value = (Number(cents) || 0) / 100;
            try { return value.toLocaleString("pt-BR", { style:"currency", currency:"BRL" }); }
            catch (_) { return "R$ " + value.toFixed(2); }
          }
          function fmtPct(value){
            const n = Number(value || 0);
            return n.toFixed(1).replace(".", ",") + "%";
          }
          function fmtTs(value){
            if (!value) return "—";
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return String(value);
            return d.toLocaleString("pt-BR");
          }
          function severityBadge(severity){
            const s = String(severity || "soft").toLowerCase();
            const cls = ["danger","warn","info","ok"].includes(s) ? s : "soft";
            const label = cls === "danger" ? "Crítico" : cls === "warn" ? "Atenção" : cls === "info" ? "Info" : "OK";
            return '<span class="badge ' + cls + '">' + label + '</span>';
          }
          function renderPills(containerId, items, formatter){
            const el = document.getElementById(containerId);
            if (!el) return;
            if (!Array.isArray(items) || !items.length) {
              el.innerHTML = '<span class="muted">Sem dados.</span>';
              return;
            }
            el.innerHTML = items.map(function(item){ return formatter(item); }).join(' ');
          }
          function drawBarChart(canvasId, labels, values){
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            if (!labels.length) {
              ctx.fillStyle = "#64748b";
              ctx.font = "14px system-ui";
              ctx.fillText("Sem dados", 12, 22);
              return;
            }
            const max = Math.max(1, ...values.map(function(v){ return Number(v || 0); }));
            const pad = { top: 20, right: 12, bottom: 56, left: 40 };
            const innerW = w - pad.left - pad.right;
            const innerH = h - pad.top - pad.bottom;
            const step = innerW / labels.length;
            const barW = Math.max(24, Math.min(84, step * 0.62));
            ctx.strokeStyle = "#cbd5e1";
            ctx.beginPath();
            ctx.moveTo(pad.left, pad.top);
            ctx.lineTo(pad.left, pad.top + innerH);
            ctx.lineTo(pad.left + innerW, pad.top + innerH);
            ctx.stroke();
            labels.forEach(function(label, index){
              const value = Number(values[index] || 0);
              const x = pad.left + step * index + (step - barW) / 2;
              const barH = innerH * (value / max);
              const y = pad.top + innerH - barH;
              ctx.fillStyle = "rgba(37,99,235,.28)";
              ctx.strokeStyle = "rgba(37,99,235,.60)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              if (typeof ctx.roundRect === "function") {
                ctx.roundRect(x, y, barW, barH, 10);
              } else {
                ctx.rect(x, y, barW, barH);
              }
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = "#0f172a";
              ctx.font = "12px system-ui";
              const valLabel = String(value);
              const valW = ctx.measureText(valLabel).width;
              ctx.fillText(valLabel, x + (barW - valW) / 2, Math.max(14, y - 6));
              const shortLabel = String(label || "").length > 14 ? String(label).slice(0, 14) + "…" : String(label || "");
              const labelW = ctx.measureText(shortLabel).width;
              ctx.fillText(shortLabel, x + (barW - labelW) / 2, pad.top + innerH + 18);
            });
          }
          async function loadReports(){
            const response = await fetch("/admin/reports/data");
            const data = await response.json().catch(function(){ return {}; });
            document.getElementById("reportsRaw").textContent = JSON.stringify(data, null, 2);
            if (!response.ok || !data.ok) {
              document.getElementById("reportsModulePills").innerHTML = '<span class="muted">Falha ao carregar os dados.</span>';
              document.getElementById("reportsActionPills").innerHTML = '<span class="muted">Falha ao carregar os dados.</span>';
              document.getElementById("reportsPlansRows").innerHTML = '<tr><td colspan="4" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsCitiesRows").innerHTML = '<tr><td colspan="2" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsIssuesRows").innerHTML = '<tr><td colspan="3" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsAuditRows").innerHTML = '<tr><td colspan="6" class="muted">Falha ao carregar os dados.</td></tr>';
              return;
            }
            const executive = data.executive || {};
            const overview = executive.overview || {};
            const revenue = executive.revenue || {};
            const usage = executive.usage || {};
            const quality = executive.quality || {};
            const plans = Array.isArray(executive.plans) ? executive.plans : [];
            const cities = Array.isArray(executive.cities) ? executive.cities : [];
            const issues = Array.isArray(executive?.inconsistencies?.summary) ? executive.inconsistencies.summary : [];
            const audit = data.audit || {};
            const auditItems = Array.isArray(audit.items) ? audit.items : [];
            if (data.warning) {
              document.getElementById("reportsModulePills").innerHTML = '<span class="badge warn">Modo contingência</span> <span class="muted">' + esc(data.warning) + '</span>';
            }
            const modules = Array.isArray(audit.modules) ? audit.modules : [];
            const actions = Array.isArray(audit.actions) ? audit.actions : [];

            setText("rpTotalUsers", overview.totalUsers || 0);
            setText("rpActiveShare", "Ativação da base: " + fmtPct(overview.activeSharePct || 0));
            setText("rpMrr", fmtBRL(revenue.mrrCents || 0));
            setText("rpAvgTicket", "Ticket médio: " + fmtBRL(revenue.avgTicketCents || 0));
            setText("rpAuditTotal", audit.totalStored || 0);
            setText("rpAuditRecent", "Últimos eventos carregados: " + (audit.recentCount || 0));
            setText("rpDescMonth", usage.descriptionsMonth || 0);
            setText("rp24hUsers", "Usuários ativos 24h: " + String(usage.window24hCount || 0));
            setText("rpBizProfiles", quality.withBizProfile || 0);
            setText("rpBizCoverage", "Cobertura: " + fmtPct(quality.profileCoveragePct || 0));
            setText("rpIssueUsers", quality.issueUsers || 0);
            setText("rpIssuePct", "Impacto: " + fmtPct(quality.inconsistencyPct || 0));

            drawBarChart("reportsStatusChart", Object.keys(executive.statusCounts || {}), Object.values(executive.statusCounts || {}));
            drawBarChart("reportsPlansChart", plans.slice(0, 6).map(function(plan){ return plan.name || plan.code || "Plano"; }), plans.slice(0, 6).map(function(plan){ return plan.count || 0; }));

            const plansRows = plans.map(function(plan){
              return '<tr>' +
                '<td><b>' + esc(plan.name || plan.code || "—") + '</b><div class="muted"><code>' + esc(plan.code || "") + '</code></div></td>' +
                '<td>' + esc(plan.count || 0) + '</td>' +
                '<td>' + esc(fmtBRL(plan.mrrCents || 0)) + '</td>' +
                '<td>' + esc(plan.description || "—") + '</td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsPlansRows").innerHTML = plansRows || '<tr><td colspan="4" class="muted">Sem dados.</td></tr>';

            const citiesRows = cities.map(function(item){
              return '<tr><td>' + esc(item.city || "—") + '</td><td>' + esc(item.count || 0) + '</td></tr>';
            }).join('');
            document.getElementById("reportsCitiesRows").innerHTML = citiesRows || '<tr><td colspan="2" class="muted">Sem dados.</td></tr>';

            renderPills("reportsModulePills", modules, function(item){
              return '<span class="pill">' + esc(item.name || "—") + ': <b>' + esc(item.count || 0) + '</b></span>';
            });
            renderPills("reportsActionPills", actions, function(item){
              return '<span class="pill">' + esc(item.name || "—") + ': <b>' + esc(item.count || 0) + '</b></span>';
            });

            const issueRows = issues.map(function(issue){
              return '<tr>' +
                '<td><b>' + esc(issue.label || "—") + '</b></td>' +
                '<td>' + severityBadge(issue.severity) + '</td>' +
                '<td><b>' + esc(issue.count || 0) + '</b></td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsIssuesRows").innerHTML = issueRows || '<tr><td colspan="3" class="muted">Sem inconsistências.</td></tr>';

            const auditRows = auditItems.map(function(item){
              return '<tr>' +
                '<td><code>' + esc(fmtTs(item.ts)) + '</code></td>' +
                '<td>' + esc(item.module || "—") + '</td>' +
                '<td>' + esc(item.action || "—") + '</td>' +
                '<td><code>' + esc(item.waId || item.targetId || "—") + '</code></td>' +
                '<td style="max-width:420px; white-space:pre-wrap;">' + esc(item.summary || "—") + '</td>' +
                '<td>' + esc(item?.actor?.user || "admin") + '</td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsAuditRows").innerHTML = auditRows || '<tr><td colspan="6" class="muted">Sem eventos recentes.</td></tr>';
          }

          const reloadBtn = document.getElementById("reportsReloadBtn");
          if (reloadBtn) reloadBtn.addEventListener("click", loadReports);
          loadReports();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Relatórios e Exportação",
      activePath: "/admin/reports-ui",
      content: inner,
      scriptExtra,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/inconsistencies", async (req, res) => {
    try {
      const data = await collectInconsistencies();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/inconsistencies-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🩺 Painel de Inconsistências</h3>
            <div class="muted">Diagnóstico operacional dos usuários e assinaturas. O painel apenas lê dados; não corrige nada automaticamente.</div>
          </div>
          <button class="primary" onclick="load()">Atualizar</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <span class="pill">👥 Usuários analisados: <b id="usersCount">—</b></span>
          <span class="pill">⚠️ Total de ocorrências: <b id="issuesCount">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="summary" class="muted">Carregando…</div>

        <div class="hr"></div>

        <div id="details" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
        }

        function sevClass(sev){
          const v = String(sev || '').toLowerCase();
          if(v === 'danger') return 'danger';
          if(v === 'warn') return 'warn';
          if(v === 'ok') return 'ok';
          return 'info';
        }

        function renderSummary(summary){
          const root = document.getElementById('summary');
          if(!Array.isArray(summary) || !summary.length){
            root.innerHTML = '<div class="muted">Nenhuma regra configurada.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Item</th><th>Descrição</th><th>Nível</th><th>Quantidade</th></tr></thead><tbody>' +
            summary.map(item => {
              return '<tr>' +
                '<td><b>' + esc(item.label || item.key || '') + '</b></td>' +
                '<td class="muted" style="max-width:520px; white-space:pre-wrap;">' + esc(item.description || '—') + '</td>' +
                '<td><span class="badge ' + sevClass(item.severity) + '">' + esc(item.severity || 'info') + '</span></td>' +
                '<td><b>' + esc(item.count || 0) + '</b></td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          root.innerHTML = html;
        }

        function renderDetails(data){
          const root = document.getElementById('details');
          const summary = Array.isArray(data?.summary) ? data.summary : [];
          const items = data?.items && typeof data.items === 'object' ? data.items : {};
          const visible = summary.filter(item => Number(item.count || 0) > 0);

          if(!visible.length){
            root.innerHTML = '<div class="muted">Nenhuma inconsistência encontrada no momento.</div>';
            return;
          }

          const sections = visible.map(item => {
            const bucket = items[item.key] || {};
            const list = Array.isArray(bucket.items) ? bucket.items : [];
            const rows = list.map(row => {
              const href = '/admin/users-ui?waId=' + encodeURIComponent(row.waId || '');
              const extraParts = [];
              if(row.plan) extraParts.push('plano: ' + row.plan);
              if(row.paymentMethod) extraParts.push('payment: ' + row.paymentMethod);
              if(row.asaasCustomerId) extraParts.push('customer: ' + row.asaasCustomerId);
              if(row.asaasSubscriptionId) extraParts.push('subscription: ' + row.asaasSubscriptionId);
              if(typeof row.lastInboundTs === 'number' && row.lastInboundTs > 0) extraParts.push('lastInboundTs: ' + row.lastInboundTs);
              if(row.cardCanceledAt) extraParts.push('cancelado em: ' + row.cardCanceledAt);
              if(row.cardValidUntil) extraParts.push('válido até: ' + row.cardValidUntil);
              if(Array.isArray(row.pendingKeys) && row.pendingKeys.length) extraParts.push('pendingKeys: ' + row.pendingKeys.join(', '));
              return '<tr>' +
                '<td><a href="' + href + '"><code>' + esc(row.waId || '') + '</code></a></td>' +
                '<td>' + esc(row.fullName || '—') + '</td>' +
                '<td>' + esc(row.status || '—') + '</td>' +
                '<td>' + esc(row.plan || '—') + '</td>' +
                '<td style="max-width:520px; white-space:pre-wrap;">' + esc(extraParts.join(' • ') || '—') + '</td>' +
              '</tr>';
            }).join('');

            return '<div class="card pad" style="margin-bottom:12px;">' +
              '<div class="row" style="justify-content:space-between;">' +
                '<div><b>' + esc(item.label || item.key || '') + '</b></div>' +
                '<span class="badge ' + sevClass(item.severity) + '">' + esc(item.count || 0) + '</span>' +
              '</div>' +
              '<div class="muted" style="margin-top:6px;">' + esc(item.description || '—') + '</div>' +
              '<div class="muted" style="margin-top:6px;">Nível: <b>' + esc(item.severity || 'info') + '</b></div>' +
              '<div class="hr"></div>' +
              '<div style="overflow:auto;">' +
                '<table style="min-width:760px;"><thead><tr><th>waId</th><th>Nome</th><th>Status</th><th>Plano</th><th>Detalhes</th></tr></thead><tbody>' + rows + '</tbody></table>' +
              '</div>' +
            '</div>';
          }).join('');

          root.innerHTML = sections;
        }

        async function load(){
          const r = await fetch('/admin/inconsistencies');
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          document.getElementById('usersCount').textContent = String(j?.usersCount ?? '0');
          document.getElementById('issuesCount').textContent = String(j?.totalIssues ?? '0');

          if(!j?.ok){
            document.getElementById('summary').innerHTML = '<div class="muted">Falha ao carregar inconsistências.</div>';
            document.getElementById('details').innerHTML = '<div class="muted">' + esc(j?.error || 'Erro desconhecido.') + '</div>';
            return;
          }

          renderSummary(j.summary);
          renderDetails(j);
        }

        load();
      </script>
    `;
    const html = layoutBase({ title: "Painel de Inconsistências", activePath: "/admin/inconsistencies-ui", content: inner });
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
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "SET_COPY_GLOBAL",
      targetId: key,
      summary: `Atualizou o texto global ${key}.`,
      after: { key, valueLength: value.length },
    });
    res.redirect("/admin/copy-ui");
  });

  router.post("/copy/del-global", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    await delCopyGlobal(key);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "DEL_COPY_GLOBAL",
      targetId: key,
      summary: `Resetou o texto global ${key}.`,
      after: { key, reset: true },
    });
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
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "SET_COPY_USER",
      waId,
      targetId: key,
      summary: `Atualizou o texto ${key} para o usuário ${waId}.`,
      after: { key, waId, valueLength: value.length },
    });
    res.redirect(`/admin/copy-ui?waId=${encodeURIComponent(waId)}`);
  });

  router.post("/copy/del-user", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const waId = String(req.body?.waId || "").trim();
    if (!key || !waId) {
      return res.status(400).json({ ok: false, error: "key and waId required" });
    }
    await delCopyUser(waId, key);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "DEL_COPY_USER",
      waId,
      targetId: key,
      summary: `Resetou o texto ${key} do usuário ${waId}.`,
      after: { key, waId, reset: true },
    });
    res.redirect(`/admin/copy-ui?waId=${encodeURIComponent(waId)}`);
  });



  // -----------------------------
  // Janela 24h (UI já existente)
  // -----------------------------
  
  // ===================== Financeiro • Asaas (UI + APIs) =====================
  // Página: Reconciliação + Histórico (Ledger de webhooks)
  router.get("/finance-asaas-ui", async (req, res) => {
    const inner = `
      <div class="row" style="justify-content:space-between; align-items:flex-end; gap:16px;">
        <div>
          <h2 style="margin:0 0 6px 0;">💰 Financeiro — Asaas</h2>
          <div class="muted">Reconciliação rápida por usuário + histórico dos eventos recebidos via webhook (ledger).</div>
        </div>
        <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <a class="pill" href="/admin/asaas-test-ui">🧪 Asaas Teste</a>
        </div>
      </div>

      <div class="grid" style="margin-top:14px; grid-template-columns: 1.2fr 0.8fr; gap:14px;">
        <div class="card pad">
          <h3 style="margin:0 0 8px 0;">🔎 Reconciliação por usuário</h3>
          <div class="muted" style="margin-bottom:10px;">Informe o waId (55DDXXXXXXXXX) para consultar status/plano + dados do Asaas.</div>

          <div class="row" style="gap:8px; flex-wrap:wrap;">
            <input id="waId" class="input" placeholder="Ex: 5511980000000" style="min-width:260px; flex:1;" />
            <button class="primary" onclick="loadUser()">Buscar</button>
          </div>

          <div class="hr"></div>

          <div id="userOut" class="muted">Nenhuma consulta ainda.</div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="userRaw" style="white-space:pre-wrap;"></pre>
          </details>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; align-items:flex-end; gap:12px;">
            <div>
              <h3 style="margin:0 0 8px 0;">📜 Histórico (Ledger)</h3>
              <div class="muted">Eventos recentes recebidos do Asaas.</div>
            </div>
            <button class="ghost" onclick="loadEvents()">Atualizar</button>
          </div>

          <div class="hr"></div>
          <div id="eventsOut" class="muted">Carregando…</div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="eventsRaw" style="white-space:pre-wrap;"></pre>
          </details>
        </div>
      </div>

      <div id="modal" class="modal" style="display:none;">
        <div class="modal__backdrop" onclick="hideModal()"></div>
        <div class="modal__card">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <h3 id="modalTitle" style="margin:0;">Aviso</h3>
            <button class="ghost" onclick="hideModal()">Fechar</button>
          </div>
          <div class="hr"></div>
          <pre id="modalBody" style="white-space:pre-wrap; margin:0;"></pre>
        </div>
      </div>

      <style>
        .modal { position:fixed; inset:0; z-index:9999; }
        .modal__backdrop { position:absolute; inset:0; background:rgba(0,0,0,.35); }
        .modal__card { position:relative; width:min(920px, calc(100% - 24px)); margin:42px auto; background:#fff; border-radius:14px; padding:14px; box-shadow:0 14px 40px rgba(0,0,0,.22); }
        pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; }
      </style>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        function showModal(title, obj){
          document.getElementById('modalTitle').textContent = title || 'Aviso';
          document.getElementById('modalBody').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
          document.getElementById('modal').style.display = 'block';
        }
        function hideModal(){
          document.getElementById('modal').style.display = 'none';
        }

        async function loadEvents(){
          const r = await fetch('/admin/api/finance/asaas/events?limit=50&offset=0');
          const j = await r.json().catch(()=>({}));
          document.getElementById('eventsRaw').textContent = JSON.stringify(j, null, 2);

          const items = Array.isArray(j.items) ? j.items : [];
          if(!items.length){
            document.getElementById('eventsOut').innerHTML = '<div class="muted">Nenhum evento registrado.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Quando</th><th>Evento</th><th>Ref</th></tr></thead><tbody>' +
            items.map(it => {
              const when = it.receivedAt || it.ts || it.dateCreated || it.createdAt || '';
              const ev = it.event || it.type || it.kind || '';
              const ref = it.paymentId || it.subscriptionId || it.invoiceId || it.id || it.externalReference || '';
              return '<tr>' +
                '<td><code>'+esc(when)+'</code></td>' +
                '<td>'+esc(ev)+'</td>' +
                '<td><code>'+esc(ref)+'</code></td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('eventsOut').innerHTML = html;
        }

        async function loadUser(){
          const waId = String(document.getElementById('waId').value || '').trim();
          if(!waId){
            showModal('Atenção', 'Informe o waId.');
            return;
          }
          const r = await fetch('/admin/api/finance/asaas/user?waId=' + encodeURIComponent(waId));
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta'}));
          document.getElementById('userRaw').textContent = JSON.stringify(j, null, 2);

          if(!j.ok){
            document.getElementById('userOut').innerHTML = '<div class="muted">Erro: '+esc(j.error||'')+'</div>';
            return;
          }

          const u = j.user || {};
          const sub = j.subscription || null;
          const pays = Array.isArray(j.payments?.data) ? j.payments.data : (Array.isArray(j.payments?.items) ? j.payments.items : []);
          const subStatus = sub && sub.status ? sub.status : (u.asaasSubscriptionId ? '(não encontrado)' : '—');

          const cancelBtn = (sub && sub.id) ? '<button class="danger" style="margin-left:8px;" onclick="cancelSub(\\''+esc(sub.id)+'\\', \\''+esc(u.waId)+'\\')">Cancelar assinatura</button>' : '';

          const html =
            '<div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">' +
              '<div>' +
                '<div><b>Nome:</b> '+esc(u.fullName||'—')+'</div>' +
                '<div><b>waId:</b> <code>'+esc(u.waId||'')+'</code></div>' +
                '<div><b>Status:</b> '+esc(u.status||'')+'</div>' +
                '<div><b>Plano:</b> '+esc(u.plan||'')+'</div>' +
                '<div><b>Forma de pagamento:</b> '+esc(u.paymentMethod||'—')+'</div>' +
                '<div><b>Documento:</b> '+esc(u.doc?.docType ? (u.doc.docType+' • ****'+(u.doc.docLast4||'')) : '—')+'</div>' +
              '</div>' +
              '<div>' +
                '<div><b>Asaas Customer:</b> <code>'+esc(u.asaasCustomerId||'—')+'</code></div>' +
                '<div><b>Asaas Subscription:</b> <code>'+esc(u.asaasSubscriptionId||'—')+'</code></div>' +
                '<div><b>Status assinatura:</b> '+esc(subStatus) + cancelBtn + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="hr"></div>' +
            '<div><b>Pagamentos (recentes)</b></div>' +
            (pays.length
              ? ('<table><thead><tr><th>Data</th><th>Status</th><th>Valor</th><th>Id</th></tr></thead><tbody>' +
                 pays.slice(0, 12).map(p => {
                   const d = p.dateCreated || p.createdAt || '';
                   const st = p.status || '';
                   const v = (p.value !== undefined && p.value !== null) ? String(p.value) : '';
                   const id = p.id || '';
                   return '<tr><td><code>'+esc(d)+'</code></td><td>'+esc(st)+'</td><td>'+esc(v)+'</td><td><code>'+esc(id)+'</code></td></tr>';
                 }).join('') +
               '</tbody></table>')
              : '<div class="muted">Nenhum pagamento encontrado para este usuário.</div>'
            );

          document.getElementById('userOut').innerHTML = html;
        }

        async function cancelSub(subId, waId){
          if(!confirm('Cancelar a assinatura no Asaas?')){
            return;
          }
          const r = await fetch('/admin/api/finance/asaas/cancel-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptionId: subId, waId })
          });
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta'}));
          showModal('Resultado', j);
          if(j.ok){
            await loadUser();
          }
        }

        loadEvents();
      </script>
    `;

    const html = layoutBase({ title: "Financeiro — Asaas", activePath: "/admin/finance-asaas-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // APIs (JSON)
  router.get("/api/finance/asaas/events", async (req, res) => {
    const waId = String(req.query?.waId || "").trim() || null;
    const limit = Number(req.query?.limit || 50);
    const offset = Number(req.query?.offset || 0);
    const data = await listAsaasEvents({ waId, limit, offset });
    return res.json(data);
  });

  router.get("/api/finance/asaas/user", async (req, res) => {
    try {
      const waId = requireWaId(req);
      const user = await getUserSnapshot(waId);

      let subscription = null;
      if (user.asaasSubscriptionId) {
        try {
          subscription = await getSubscription(user.asaasSubscriptionId);
        } catch (e) {
          // não falha a página se o Asaas não encontrar a assinatura
          subscription = null;
        }
      }

      const payments = user.asaasCustomerId
        ? await listPayments({ customerId: user.asaasCustomerId, limit: 20, offset: 0 })
        : (user.asaasSubscriptionId ? await listPayments({ subscriptionId: user.asaasSubscriptionId, limit: 20, offset: 0 }) : { data: [] });

      return res.json({ ok: true, user, subscription, payments });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: msg });
    }
  });

  router.post("/api/finance/asaas/cancel-subscription", async (req, res) => {
    try {
      const subscriptionId = String(req.body?.subscriptionId || "").trim();
      const waId = String(req.body?.waId || "").trim();

      let subId = subscriptionId;
      if (!subId && waId) {
        const u = await getUserSnapshot(waId);
        subId = String(u.asaasSubscriptionId || "").trim();
      }

      if (!subId) {
        return res.status(400).json({ ok: false, error: "subscriptionId ausente." });
      }

      const out = await cancelSubscription(subId);
      await safeRecordAdminAudit(req, {
        module: "finance",
        action: "CANCEL_ASAAS_SUBSCRIPTION",
        waId: waId || "",
        targetId: subId,
        summary: `Solicitou o cancelamento da assinatura ${subId}.`,
        after: { canceled: true, response: out },
        meta: { waId: waId || "" },
      });
      return res.json({ ok: true, canceled: out });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // ===================== Asaas Teste (UI + API) =====================
  router.get("/asaas-test-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">🧪 Asaas Teste</h2>
            <div class="muted">Teste de conectividade usando a mesma chave/ambiente do backend (sem expor dados sensíveis).</div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="primary" onclick="run()">Testar agora</button>
          </div>
        </div>

        <div class="hr"></div>
        <div id="out" class="muted">Clique em “Testar agora”.</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <div id="modal" class="modal" style="display:none;">
        <div class="modal__backdrop" onclick="hideModal()"></div>
        <div class="modal__card">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <h3 style="margin:0;">Resultado</h3>
            <button class="ghost" onclick="hideModal()">Fechar</button>
          </div>
          <div class="hr"></div>
          <pre id="modalBody" style="white-space:pre-wrap; margin:0;"></pre>
        </div>
      </div>

      <style>
        .modal { position:fixed; inset:0; z-index:9999; }
        .modal__backdrop { position:absolute; inset:0; background:rgba(0,0,0,.35); }
        .modal__card { position:relative; width:min(820px, calc(100% - 24px)); margin:42px auto; background:#fff; border-radius:14px; padding:14px; box-shadow:0 14px 40px rgba(0,0,0,.22); }
      </style>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        function showModal(obj){
          document.getElementById('modalBody').textContent = JSON.stringify(obj, null, 2);
          document.getElementById('modal').style.display = 'block';
        }
        function hideModal(){
          document.getElementById('modal').style.display = 'none';
        }
        async function run(){
          const r = await fetch('/admin/api/asaas/test');
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta' }));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          document.getElementById('out').innerHTML = j.ok
            ? '<div><b>✅ OK</b> — Consegui falar com o Asaas.</div>'
            : '<div><b>❌ Falha</b> — '+esc(j.error||'')+'</div>';
          showModal(j);
        }
      </script>
    `;
    const html = layoutBase({ title: "Asaas Teste", activePath: "/admin/asaas-test-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/api/asaas/test", async (req, res) => {
    try {
      const out = await listPayments({ limit: 1, offset: 0 });
      return res.json({ ok: true, sampleCount: Array.isArray(out?.data) ? out.data.length : 0 });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(500).json({ ok: false, error: msg });
    }
  });


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
      const beforeUser = await getUserSnapshot(waId);
      await setUserStatus(waId, "TRIAL");
      await setUserPlan(waId, "");
      await setUserQuotaUsed(waId, 0);
      await setUserTrialUsed(waId, 0);

      // ✅ V16.4.6: Upstash REST não aceita SET com valor vazio de forma confiável
      await clearLastPrompt(waId);

      const user = await getUserSnapshot(waId);
      await safeRecordAdminAudit(req, {
        module: "state",
        action: "RESET_USER_TRIAL",
        waId,
        targetId: waId,
        summary: `Resetou o usuário ${waId} para TRIAL.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(user),
      });
      return res.json({ ok: true, action: "reset-trial", waId, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  // 🧹 Reset TOTAL (número de teste): remove estado, métricas, janela 24h e overrides de copy
  router.get('/state-test/reset-user', async (req, res) => {
    try {
      const waId = requireWaId(req);
      const beforeUser = await getUserSnapshot(waId);

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

      const afterUser = await getUserSnapshot(waId);
      await safeRecordAdminAudit(req, {
        module: "state",
        action: "RESET_USER_TOTAL",
        waId,
        targetId: waId,
        summary: `Executou reset total do usuário ${waId}.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(afterUser),
        meta: {
          state: st,
          window24h: w,
          metrics: m,
          copyDeleted,
        },
      });
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

// --- safety init for users list UI ---
if (typeof reloadUsers === 'function') {
  window.reloadUsers = reloadUsers;
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => { try { reloadUsers(); } catch(e) {} });
  }
}
