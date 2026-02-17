// src/server.js
import express from "express";
import crypto from "crypto";

import { asaasRouter } from "./routes/asaas.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.3-modular-onboarding-doc-asaas";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// ===================== ENV =====================
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();

const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_ENV = (process.env.ASAAS_ENV || "production").trim(); // production | sandbox

// ===================== Plans (inicial) =====================
// Por enquanto fixo aqui (16.3). Depois a gente leva para Admin "Planos".
const PLANS = {
  DE_VEZ_EM_QUANDO: { label: "De Vez em Quando", price: 24.9, quota: 20 },
  SEMPRE_POR_PERTO: { label: "Sempre por Perto", price: 34.9, quota: 60 },
  MELHOR_AMIGO: { label: "Melhor Amigo", price: 49.9, quota: 200 },
};

// ===================== Helpers =====================
function basicAuth(req, res, next) {
  if (!ADMIN_SECRET) return res.status(500).send("ADMIN_SECRET missing");

  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }
  const b64 = h.slice("Basic ".length);
  let decoded = "";
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid auth");
  }
  const [user, pass] = decoded.split(":");
  if (!pass || pass !== ADMIN_SECRET) return res.status(403).send("Forbidden");
  next();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nowMs() {
  return Date.now();
}

function normalizeDoc(doc) {
  return String(doc || "").replace(/\D/g, "");
}

// ===================== CPF/CNPJ validation (DV real) =====================
function isValidCPF(raw) {
  const cpf = normalizeDoc(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;

  const calcDV = (base, factor) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (factor - i);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const dv1 = calcDV(cpf.slice(0, 9), 10);
  const dv2 = calcDV(cpf.slice(0, 9) + String(dv1), 11);

  return cpf === cpf.slice(0, 9) + String(dv1) + String(dv2);
}

function isValidCNPJ(raw) {
  const cnpj = normalizeDoc(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1+$/.test(cnpj)) return false;

  const calcDV = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * weights[i];
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const dv1 = calcDV(cnpj.slice(0, 12), w1);
  const dv2 = calcDV(cnpj.slice(0, 12) + String(dv1), w2);

  return cnpj === cnpj.slice(0, 12) + String(dv1) + String(dv2);
}

function validateDoc(raw) {
  const doc = normalizeDoc(raw);
  if (doc.length === 11) return { ok: isValidCPF(doc), type: "CPF", doc };
  if (doc.length === 14) return { ok: isValidCNPJ(doc), type: "CNPJ", doc };
  return { ok: false, type: "UNKNOWN", doc };
}

// ===================== Redis (Upstash REST) =====================
async function upstash(path, { method = "GET", body = null } = {}) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Missing Upstash env (UPSTASH_REDIS_REST_URL / TOKEN)");
  }
  const url = `${UPSTASH_REDIS_REST_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Upstash HTTP ${res.status}`;
    throw new Error(`Redis error: ${msg}`);
  }
  if (data?.error) throw new Error(`Upstash: ${data.error}`);
  return data?.result;
}

async function redisGet(key) {
  return upstash(`/get/${encodeURIComponent(key)}`);
}
async function redisSet(key, value) {
  // SET key value
  return upstash(`/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
}
async function redisDel(key) {
  return upstash(`/del/${encodeURIComponent(key)}`);
}
async function redisPing() {
  return upstash(`/ping`);
}

// ===================== WhatsApp send =====================
async function sendWhatsAppText(to, text) {
  const waId = String(to || "").trim();
  if (!waId) throw new Error("Missing recipient 'to'");
  if (!ACCESS_TOKEN) throw new Error("ACCESS_TOKEN missing");
  if (!PHONE_NUMBER_ID) throw new Error("PHONE_NUMBER_ID missing");

  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: waId,
    type: "text",
    text: { body: String(text || "") },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `WhatsApp HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

// ===================== User State =====================
function userKey(waId) {
  return `user:${waId}`;
}
function usersIndexKey() {
  return `users:index`; // JSON array simples (por enquanto)
}

async function loadUser(waId) {
  const raw = await redisGet(userKey(waId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveUser(user) {
  user.updatedAtMs = nowMs();
  await redisSet(userKey(user.waId), JSON.stringify(user));

  // index simples (sem ZSET) para 16.3 (barato e suficiente p/ ~1k users)
  const idxRaw = (await redisGet(usersIndexKey())) || "[]";
  let idx = [];
  try {
    idx = JSON.parse(idxRaw) || [];
  } catch {
    idx = [];
  }
  if (!idx.includes(user.waId)) idx.push(user.waId);
  await redisSet(usersIndexKey(), JSON.stringify(idx));

  return user;
}

async function ensureUser(waId) {
  let u = await loadUser(waId);
  if (!u) {
    u = {
      waId,
      status: "TRIAL", // TRIAL | WAIT_PLAN | WAIT_PAYMENT_METHOD | WAIT_DOC | PAYMENT_PENDING | ACTIVE
      plan: "",
      trialUsed: 0,
      quotaUsed: 0,
      fullName: "",
      doc: "",
      payMethod: "", // CARD | PIX
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      lastInboundAtMs: 0,
      windowEndsAtMs: 0,
      asaasCustomerId: "",
      asaasRef: "", // subscriptionId or paymentId
    };
    await saveUser(u);
  }
  return u;
}

function getUserWindowEndsAtMs(u) {
  const last = Number(u.lastInboundAtMs || 0);
  if (!last) return 0;
  return last + 24 * 60 * 60 * 1000;
}

// ===================== Asaas helpers =====================
function asaasBaseUrl() {
  // Se você usa sandbox, ajuste aqui conforme sua conta
  // Em geral Asaas usa o mesmo host, mudando chave / ambiente. Mantemos padrão.
  return "https://api.asaas.com/v3";
}

async function asaasFetch(path, { method = "GET", body = null } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY missing");
  const url = `${asaasBaseUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      access_token: ASAAS_API_KEY,
    },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.errors?.[0]?.description || data?.message || `Asaas HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function asaasFindOrCreateCustomer(user) {
  // Se já tiver customerId, reaproveita
  if (user.asaasCustomerId) return user.asaasCustomerId;

  // Criar customer com nome e CPF/CNPJ
  const name = user.fullName?.trim() || "Cliente Amigo das Vendas";
  const cpfCnpj = user.doc;

  const customer = await asaasFetch("/customers", {
    method: "POST",
    body: {
      name,
      cpfCnpj,
      // Você pode colocar email/phone depois quando tiver
    },
  });

  user.asaasCustomerId = customer.id || "";
  await saveUser(user);
  return user.asaasCustomerId;
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function asaasCreateCardSubscription(user, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plano inválido");

  const customerId = await asaasFindOrCreateCustomer(user);

  // assinatura (cartão) — sem capturar cartão no WhatsApp:
  // a prática aqui é gerar "checkout" / invoiceUrl do Asaas (depende do plano/conta).
  // Vamos usar pagamentos recorrentes via subscription e devolver um link quando disponível.
  // Caso a sua conta não devolva invoiceUrl, a gente ajusta para Checkout.
  const nextDueDate = formatDateYYYYMMDD(new Date(Date.now() + 1 * 24 * 60 * 60 * 1000)); // amanhã

  const sub = await asaasFetch("/subscriptions", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "CREDIT_CARD",
      cycle: "MONTHLY",
      value: plan.price,
      nextDueDate,
      description: `Amigo das Vendas - ${plan.label}`,
    },
  });

  // Alguns cenários retornam links no próprio objeto; se não vier, a gente envia só confirmação.
  const subId = sub.id || "";
  user.status = "PAYMENT_PENDING";
  user.plan = planKey;
  user.payMethod = "CARD";
  user.asaasRef = subId;
  await saveUser(user);

  const link =
    sub?.invoiceUrl ||
    sub?.bankSlipUrl ||
    sub?.paymentLink ||
    sub?.checkoutUrl ||
    "";

  return { subId, link, raw: sub };
}

async function asaasCreatePixMonthlyPayment(user, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plano inválido");

  const customerId = await asaasFindOrCreateCustomer(user);

  // Cobrança avulsa mensal (PIX): cria 1 payment. A renovação mensal você dispara no vencimento.
  const dueDate = formatDateYYYYMMDD(new Date(Date.now() + 1 * 24 * 60 * 60 * 1000)); // amanhã

  const p = await asaasFetch("/payments", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "PIX",
      value: plan.price,
      dueDate,
      description: `Amigo das Vendas - ${plan.label} (mensal PIX)`,
    },
  });

  const paymentId = p.id || "";
  user.status = "PAYMENT_PENDING";
  user.plan = planKey;
  user.payMethod = "PIX";
  user.asaasRef = paymentId;
  await saveUser(user);

  // PIX costuma vir com invoiceUrl; QR pode exigir uma chamada extra dependendo do Asaas.
  const link = p?.invoiceUrl || p?.bankSlipUrl || "";
  return { paymentId, link, raw: p };
}

// ===================== Copy texts =====================
function plansMenuText() {
  return (
    `Perfeito! 😄\n\n` +
    `Escolha um plano:\n\n` +
    `1) ${PLANS.DE_VEZ_EM_QUANDO.label} — R$ ${PLANS.DE_VEZ_EM_QUANDO.price.toFixed(2)}\n   • ${PLANS.DE_VEZ_EM_QUANDO.quota} descrições/mês\n\n` +
    `2) ${PLANS.SEMPRE_POR_PERTO.label} — R$ ${PLANS.SEMPRE_POR_PERTO.price.toFixed(2)}\n   • ${PLANS.SEMPRE_POR_PERTO.quota} descrições/mês\n\n` +
    `3) ${PLANS.MELHOR_AMIGO.label} — R$ ${PLANS.MELHOR_AMIGO.price.toFixed(2)}\n   • ${PLANS.MELHOR_AMIGO.quota} descrições/mês\n\n` +
    `Responda com 1, 2 ou 3.`
  );
}

function payMethodText() {
  return (
    `Show! ✅\n\n` +
    `Agora escolha a forma de pagamento:\n\n` +
    `1) Cartão (assinatura mensal) 💳  *(recomendado)*\n` +
    `2) PIX (cobrança mensal avulsa) 🧾\n\n` +
    `Responda com 1 ou 2.`
  );
}

function askDocText() {
  return (
    `Nossa, quase esqueci 😄\n` +
    `Pra eu conseguir gerar e registrar o pagamento, preciso do seu CPF ou CNPJ (somente números).\n\n` +
    `Pode me enviar, por favor?\n` +
    `Fica tranquilo(a): eu uso só pra isso e não exibo em logs.`
  );
}

function invalidDocText() {
  return (
    `Uhmm… acho que algum dígito ficou diferente aí 🥺😄\n` +
    `Dá uma olhadinha e me envia de novo, por favor, somente números:\n\n` +
    `CPF: 11 dígitos\n\n` +
    `CNPJ: 14 dígitos`
  );
}

function welcomeAskNameText() {
  return (
    `Oi! 👋😊\n` +
    `Eu sou o Amigo das Vendas — pode me chamar de Amigo.\n\n` +
    `Você me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.\n\n` +
    `Antes que eu esqueça 😄 qual é o seu NOME COMPLETO?`
  );
}

// ===================== Health =====================
app.get("/", (req, res) => res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION }));
app.get("/health", (req, res) => res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION }));

app.get("/admin", basicAuth, (req, res) => {
  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Admin - ${escapeHtml(APP_NAME)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; }
        .card { max-width: 920px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
        a { display: inline-block; margin: 6px 0; }
        .muted { color: #666; }
        code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
        .row { display:flex; gap: 14px; flex-wrap: wrap; }
        .pill { border:1px solid #eee; border-radius: 10px; padding: 10px 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Admin (V16.3)</h2>
        <p class="muted">Menu:</p>
        <div class="row">
          <div class="pill"><a href="/health">✅ Health</a></div>
          <div class="pill"><a href="/admin/redis-ping">🧠 Redis Ping</a></div>
          <div class="pill"><a href="/admin/users">👥 Users (JSON)</a></div>
          <div class="pill"><a href="/admin/validate-doc?doc=52998224725">🧾 Validate Doc (teste)</a></div>
          <div class="pill"><a href="/asaas/test">💳 Asaas Test</a></div>
        </div>
        <hr/>
        <p class="muted">Rotas principais:</p>
        <div>
          <div><code>GET /webhook</code> (verificação Meta)</div>
          <div><code>POST /webhook</code> (eventos WhatsApp)</div>
          <div><code>POST /asaas/webhook</code> (webhook Asaas)</div>
        </div>
      </div>
    </body>
  </html>
  `;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
});

app.get("/admin/redis-ping", basicAuth, async (req, res) => {
  try {
    const r = await redisPing();
    return res.json({ ok: true, redis: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin/users", basicAuth, async (req, res) => {
  try {
    const idxRaw = (await redisGet(usersIndexKey())) || "[]";
    let idx = [];
    try {
      idx = JSON.parse(idxRaw) || [];
    } catch {
      idx = [];
    }
    const users = [];
    for (const waId of idx) {
      const u = await loadUser(waId);
      if (u) users.push({ waId: u.waId, status: u.status, plan: u.plan, trialUsed: u.trialUsed, quotaUsed: u.quotaUsed });
    }
    return res.json({ ok: true, total: users.length, users });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin/validate-doc", basicAuth, (req, res) => {
  const doc = req.query.doc || "";
  const v = validateDoc(doc);
  return res.json({ ok: true, input: String(doc), normalized: v.doc, type: v.type, valid: v.ok });
});

// ===================== WhatsApp Cloud API webhook =====================
// Teste A (GET) - verificação do Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.status(403).send("Forbidden");
});

// POST - recebimento WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    // responde rápido
    res.json({ ok: true });

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};
    const msg = value?.messages?.[0];

    if (!msg) return;

    const waId = String(msg.from || "").trim();
    if (!waId) return;

    const text = (msg.type === "text" ? msg.text?.body : "") || "";
    const body = String(text || "").trim();

    // Atualiza janela 24h
    const u = await ensureUser(waId);
    u.lastInboundAtMs = nowMs();
    u.windowEndsAtMs = getUserWindowEndsAtMs(u);
    await saveUser(u);

    // ======== Onboarding / Conversa ========

    // 0) se não tem nome, sempre pede (isso vale inclusive se ele mandar "oi")
    if (!u.fullName) {
      // Se ele mandou algo que parece nome (mais de 2 palavras), já salva
      const maybeName = body;
      const parts = maybeName.split(/\s+/).filter(Boolean);
      if (parts.length >= 2 && maybeName.length >= 8 && !/^\d+$/.test(maybeName)) {
        u.fullName = maybeName;
        await saveUser(u);
        await sendWhatsAppText(waId, `Perfeito, ${u.fullName.split(" ")[0]}! ✅\n\nAgora me diga o que você vende ou o serviço que presta (pode ser simples, tipo: "vendo bolo R$30").`);
        return;
      }

      await sendWhatsAppText(waId, welcomeAskNameText());
      return;
    }

    // 1) Trial: até 5 descrições (aqui ainda não gera com OpenAI; só simula consumo e empurra para planos)
    if (u.status === "TRIAL") {
      // comandos
      if (/^planos$/i.test(body)) {
        u.status = "WAIT_PLAN";
        await saveUser(u);
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // se já concluiu trial
      if ((u.trialUsed || 0) >= 5) {
        u.status = "WAIT_PLAN";
        await saveUser(u);
        await sendWhatsAppText(
          waId,
          `😄 Seu trial gratuito foi concluído!\n\nPara continuar, escolha um plano.\n\n💳 Responda com a palavra PLANOS para ver as opções.`
        );
        return;
      }

      // qualquer mensagem conta como "1 descrição" no trial (por enquanto)
      u.trialUsed = Number(u.trialUsed || 0) + 1;
      await saveUser(u);

      if (u.trialUsed >= 5) {
        u.status = "WAIT_PLAN";
        await saveUser(u);
        await sendWhatsAppText(
          waId,
          `✅ Recebi sua solicitação.\n\n` +
            `🎁 Trial: ${u.trialUsed}/5\n\n` +
            `😄 Seu trial gratuito foi concluído!\n\n` +
            `Para continuar, escolha um plano.\n\n` +
            `💳 Responda com a palavra PLANOS para ver as opções.`
        );
        return;
      }

      await sendWhatsAppText(
        waId,
        `✅ Recebi sua solicitação.\n\n🎁 Trial: ${u.trialUsed}/5\n\nEm breve vamos ligar o gerador completo (OpenAI) no modular.`
      );
      return;
    }

    // 2) Escolha do plano
    if (u.status === "WAIT_PLAN") {
      let planKey = "";
      if (body === "1") planKey = "DE_VEZ_EM_QUANDO";
      if (body === "2") planKey = "SEMPRE_POR_PERTO";
      if (body === "3") planKey = "MELHOR_AMIGO";

      if (!planKey) {
        await sendWhatsAppText(waId, `Não entendi 😅\n\n${plansMenuText()}`);
        return;
      }

      u.plan = planKey;
      u.status = "WAIT_PAYMENT_METHOD";
      await saveUser(u);

      await sendWhatsAppText(waId, payMethodText());
      return;
    }

    // 3) Forma de pagamento
    if (u.status === "WAIT_PAYMENT_METHOD") {
      if (body !== "1" && body !== "2") {
        await sendWhatsAppText(waId, `Só pra eu registrar certinho 😄\n\n${payMethodText()}`);
        return;
      }
      u.payMethod = body === "1" ? "CARD" : "PIX";
      u.status = "WAIT_DOC";
      await saveUser(u);

      await sendWhatsAppText(waId, askDocText());
      return;
    }

    // 4) Documento + validação real DV antes de Asaas
    if (u.status === "WAIT_DOC") {
      const v = validateDoc(body);
      if (!v.ok) {
        await sendWhatsAppText(waId, invalidDocText());
        return;
      }

      u.doc = v.doc;
      await saveUser(u);

      // cria no Asaas (CARD assinatura | PIX cobrança avulsa mensal)
      const planKey = u.plan;
      const plan = PLANS[planKey];

      if (!plan) {
        u.status = "WAIT_PLAN";
        await saveUser(u);
        await sendWhatsAppText(waId, `Deu um pequeno desencontro aqui 😅\n\nVamos escolher o plano novamente.\n\n${plansMenuText()}`);
        return;
      }

      await sendWhatsAppText(
        waId,
        `Perfeito! ✅\n\n` +
          `📦 Plano: ${plan.label}\n` +
          `💳 Pagamento: ${u.payMethod === "CARD" ? "Cartão (assinatura)" : "PIX (mensal)"}\n\n` +
          `Gerando seu pagamento agora...`
      );

      if (u.payMethod === "CARD") {
        const r = await asaasCreateCardSubscription(u, planKey);
        if (r.link) {
          await sendWhatsAppText(
            waId,
            `Pronto! 💳✅\n\nPara ativar sua assinatura no cartão, finalize por este link:\n${r.link}\n\nAssim que o pagamento confirmar, eu libero seu plano automaticamente.`
          );
        } else {
          await sendWhatsAppText(
            waId,
            `Assinatura criada! 💳✅\n\nAssim que o pagamento confirmar, eu libero seu plano automaticamente.\n\n(Se você quiser, eu também posso te mandar o link de checkout assim que estiver disponível na conta Asaas.)`
          );
        }
        return;
      }

      // PIX
      const p = await asaasCreatePixMonthlyPayment(u, planKey);
      if (p.link) {
        await sendWhatsAppText(
          waId,
          `Pronto! 🧾✅\n\nPara pagar por PIX, use este link:\n${p.link}\n\nAssim que confirmar, eu libero seu plano automaticamente.`
        );
      } else {
        await sendWhatsAppText(
          waId,
          `Cobrança PIX criada! 🧾✅\n\nAssim que confirmar, eu libero seu plano automaticamente.`
        );
      }
      return;
    }

    // 5) Payment pending
    if (u.status === "PAYMENT_PENDING") {
      await sendWhatsAppText(
        waId,
        `✅ Eu vi sua mensagem!\n\nNo momento seu pagamento ainda está pendente.\n` +
          `Assim que o Asaas confirmar, eu libero o plano automaticamente.`
      );
      return;
    }

    // 6) Active
    if (u.status === "ACTIVE") {
      const plan = PLANS[u.plan] || null;
      await sendWhatsAppText(
        waId,
        `✅ Recebi!\n\n📦 Plano: ${plan ? plan.label : u.plan}\n` +
          `Em breve vamos ligar o gerador completo (OpenAI) no modular e entregar o anúncio prontinho.`
      );
      return;
    }

    // fallback
    await sendWhatsAppText(waId, `✅ Recebi sua mensagem!`);
  } catch (err) {
    console.error("Webhook error:", err?.message || err);
    // webhook já respondeu ok
  }
});

// ===================== ASAAS webhook =====================
app.use("/asaas", asaasRouter());

// Teste simples interno (não é webhook)
app.get("/asaas/test", basicAuth, (req, res) => {
  return res.json({ ok: true, asaasWebhookRoute: "/asaas/webhook", env: ASAAS_ENV });
});

// ===================== Start =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
