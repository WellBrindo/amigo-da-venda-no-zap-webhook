// src/server.js
import express from "express";
import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.8-modular-openai-on-template-toggle";

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
const ASAAS_ENV = (process.env.ASAAS_ENV || "production").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// ===================== Plans (inicial) =====================
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
  const [_user, pass] = decoded.split(":");
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

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeDoc(doc) {
  return String(doc || "").replace(/\D/g, "");
}

function safeLower(s) {
  return String(s || "").toLowerCase();
}

// ===================== CPF/CNPJ validation (DV real) =====================
function isValidCPF(raw) {
  const cpf = normalizeDoc(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;

  const calcDV = (base, factor) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * factor--;
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
    for (let i = 0; i < weights.length; i++) sum += Number(base[i]) * weights[i];
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

// ===================== Name validation =====================
function looksLikeRealFullName(text) {
  const t = normalizeSpaces(text);
  if (t.length < 8) return false;
  const parts = t.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  if (/\d/.test(t)) return false;

  const lower = t.toLowerCase();
  const blockedStarts = ["vendo", "faço", "trabalho", "sou", "promoção", "preço", "valor"];
  if (blockedStarts.some((s) => lower.startsWith(s))) return false;

  const blockedContains = ["r$", "reais", "entrego", "entrega", "por ", "apenas", "cupom", "frete"];
  if (blockedContains.some((c) => lower.includes(c))) return false;

  return true;
}

// ===================== Redis (Upstash REST) =====================
async function upstashFetch(path, { method = "GET", body = null } = {}) {
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
  return data;
}

async function redisGet(key) {
  const data = await upstashFetch(`/get/${encodeURIComponent(key)}`);
  return data?.result ?? null;
}

async function redisPipeline(commands) {
  const data = await upstashFetch(`/pipeline`, { method: "POST", body: commands });
  return data?.result ?? [];
}

async function redisSet(key, value) {
  await redisPipeline([["SET", key, String(value)]]);
  return "OK";
}

async function redisPing() {
  const data = await upstashFetch(`/ping`);
  return data?.result ?? "PONG";
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

// ===================== OpenAI (Chat Completions) =====================
async function openaiChat({ system, user, maxTokens = 420 }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const url = "https://api.openai.com/v1/chat/completions";
  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `OpenAI HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  const txt = data?.choices?.[0]?.message?.content || "";
  return String(txt).trim();
}

function buildSystemPrompt(formatMode) {
  const base =
    "Você é um assistente especialista em criar anúncios curtos e de alta conversão para WhatsApp. " +
    "Você deve devolver um texto pronto para copiar e colar. " +
    "Seja claro, objetivo e persuasivo. Não invente dados (ex: endereço, horário) se o usuário não informou. " +
    "Se faltar algo importante, use 'Sob consulta'.";
  if (formatMode === "LIVRE") return base + " Formatação livre (sem template fixo).";
  return base + " Use um template fixo com emojis, bullets e chamada para ação (CTA).";
}

async function generateAdText({ productDesc, formatMode }) {
  const system = buildSystemPrompt(formatMode);
  const user =
    "Crie um anúncio pronto para WhatsApp com base na descrição abaixo.\n\n" +
    `Descrição do usuário: ${productDesc}\n\n` +
    "Regras:\n" +
    "- Não diga que é IA.\n" +
    "- Não peça para o usuário mandar mais dados.\n" +
    "- Se faltar local/horário, use 'Sob consulta'.\n" +
    "- Mantenha em até ~900 caracteres.\n";

  return openaiChat({ system, user, maxTokens: 450 });
}

// ===================== Copy (mensagens) =====================
function plansMenuText() {
  return (
    "😄 Seu trial gratuito foi concluído!\n\n" +
    "Para continuar, escolha um plano:\n\n" +
    "1) De Vez em Quando — R$ 24.90\n" +
    "   • 20 descrições/mês\n\n" +
    "2) Sempre por Perto — R$ 34.90\n" +
    "   • 60 descrições/mês\n\n" +
    "3) Melhor Amigo — R$ 49.90\n" +
    "   • 200 descrições/mês\n\n" +
    "Responda com 1, 2 ou 3."
  );
}

function payMethodText() {
  return (
    "Perfeito 😄\n\n" +
    "Como você prefere pagar?\n\n" +
    "1) Cartão (assinatura recorrente)\n" +
    "2) PIX (mensal avulso)\n\n" +
    "Responda com 1 ou 2."
  );
}

function askDocText() {
  return (
    "Nossa, quase esqueci 😄\n" +
    "Pra eu conseguir gerar e registrar o pagamento, preciso do seu CPF ou CNPJ (somente números).\n\n" +
    "Pode me enviar, por favor?\n" +
    "Fica tranquilo(a): eu uso só pra isso e não aparece em mensagens nem em logs."
  );
}

function invalidDocText() {
  return (
    "Uhmm… acho que algum dígito ficou diferente aí 🥺😄\n" +
    "Dá uma olhadinha e me envia de novo, por favor, somente números:\n\n" +
    "CPF: 11 dígitos\n\n" +
    "CNPJ: 14 dígitos"
  );
}

function askFormatChoiceText() {
  return (
    "Quer manter o template? 😄\n\n" +
    "1) Sim (recomendado — geralmente converte mais)\n" +
    "2) Não, quero formatação livre\n\n" +
    "Você também pode digitar: TEMPLATE ou LIVRE quando quiser."
  );
}

// ===================== User state (via Redis JSON string) =====================
function kUser(waId) {
  return `user:${waId}`;
}

async function ensureUser(waId) {
  const raw = await redisGet(kUser(waId));
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // cai pro default
    }
  }
  const u = {
    waId,
    status: "ASK_NAME",
    fullName: "",
    plan: "",
    payMethod: "",
    doc: "",
    trialUsed: 0,
    quotaUsed: 0,
    formatMode: "TEMPLATE",
    askFormatChoicePending: false,
    lastInboundAtMs: 0,
    windowEndsAtMs: 0,
  };
  await redisSet(kUser(waId), JSON.stringify(u));
  return u;
}

async function saveUser(u) {
  await redisSet(kUser(u.waId), JSON.stringify(u));
  return u;
}

// ===================== Health =====================
app.get("/", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/health", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

// ===================== Admin (Linha A) =====================
// Tudo em /admin agora é o router modular + Basic Auth
app.use("/admin", basicAuth, adminRouter());

// Mantém o redis ping que você já usava (não depende do services/redis.js)
app.get("/admin/redis-ping", basicAuth, async (req, res) => {
  try {
    const r = await redisPing();
    return res.json({ ok: true, redis: r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===================== Meta verify =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.status(403).send("Forbidden");
});

// ===================== Meta receive =====================
app.post("/webhook", async (req, res) => {
  try {
    res.json({ ok: true });

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};
    const msg = value?.messages?.[0];
    if (!msg) return;

    const waId = String(msg.from || "").trim();
    if (!waId) return;

    const text = (msg.type === "text" ? msg.text?.body : "") || "";
    const body = normalizeSpaces(text);
    const lower = safeLower(body);

    const u = await ensureUser(waId);
    u.lastInboundAtMs = nowMs();
    u.windowEndsAtMs = u.lastInboundAtMs + 24 * 60 * 60 * 1000;
    await saveUser(u);

    // ===== Global commands (qualquer estado, se já tiver nome) =====
    if (u.fullName) {
      if (lower === "template") {
        u.formatMode = "TEMPLATE";
        u.askFormatChoicePending = false;
        await saveUser(u);
        await sendWhatsAppText(waId, "Fechado 😄 Vou manter o *template* daqui pra frente.");
        return;
      }
      if (lower === "livre") {
        u.formatMode = "LIVRE";
        u.askFormatChoicePending = false;
        await saveUser(u);
        await sendWhatsAppText(waId, "Boa 😄 Vou usar *formatação livre* daqui pra frente.");
        return;
      }
    }

    // ===== ASK_NAME =====
    if (u.status === "ASK_NAME") {
      if (!looksLikeRealFullName(body)) {
        await sendWhatsAppText(
          waId,
          "Antes que eu esqueça 😄\nQual é o seu *NOME COMPLETO*?"
        );
        return;
      }
      u.fullName = body;
      u.status = "ASK_PRODUCT";
      await saveUser(u);
      await sendWhatsAppText(
        waId,
        `Prazer, ${u.fullName.split(" ")[0]}! 😄\n\nAgora me diga: o que você vende ou qual serviço você presta?`
      );
      return;
    }

    // ===== ASK_PRODUCT (TRIAL) =====
    if (u.status === "ASK_PRODUCT") {
      if (!body) return;

      // Se acabou o trial, vai direto pro menu de planos
      if ((u.trialUsed || 0) >= 5) {
        u.status = "WAIT_PLAN";
        await saveUser(u);
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // Consome 1 do trial e gera anúncio
      u.trialUsed = (u.trialUsed || 0) + 1;
      await saveUser(u);

      let ad = "";
      try {
        ad = await generateAdText({ productDesc: body, formatMode: u.formatMode });
      } catch {
        await sendWhatsAppText(
          waId,
          `Tive uma instabilidade ao gerar sua descrição 😅\n\nPode tentar de novo?`
        );
        return;
      }

      await sendWhatsAppText(waId, ad);

      // pergunta template/livre pós-geração
      u.askFormatChoicePending = true;
      await saveUser(u);
      await sendWhatsAppText(waId, askFormatChoiceText());
      return;
    }

    // ===== Pergunta template/livre pendente =====
    if (u.askFormatChoicePending) {
      if (body === "1") {
        u.formatMode = "TEMPLATE";
        u.askFormatChoicePending = false;
        await saveUser(u);
        await sendWhatsAppText(waId, "Perfeito 😄 Vou manter o *template*.");
        return;
      }
      if (body === "2") {
        u.formatMode = "LIVRE";
        u.askFormatChoicePending = false;
        await saveUser(u);
        await sendWhatsAppText(waId, "Fechado 😄 Vou usar *formatação livre*.");
        return;
      }
      await sendWhatsAppText(waId, askFormatChoiceText());
      return;
    }

    // ===== WAIT_PLAN =====
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

    // ===== WAIT_PAYMENT_METHOD =====
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

    // ===== WAIT_DOC =====
    if (u.status === "WAIT_DOC") {
      const v = validateDoc(body);
      if (!v.ok) {
        await sendWhatsAppText(waId, invalidDocText());
        return;
      }

      u.doc = v.doc; // ⚠️ não logar
      u.status = "PAYMENT_PENDING";
      await saveUser(u);

      await sendWhatsAppText(
        waId,
        `✅ Documento confirmado (${v.type}).\n\nPerfeito! Próximo passo: gerar sua cobrança/assinatura no Asaas.`
      );
      return;
    }

    // ===== ACTIVE (OpenAI ON também) =====
    if (u.status === "ACTIVE") {
      let ad = "";
      try {
        ad = await generateAdText({ productDesc: body, formatMode: u.formatMode });
      } catch {
        await sendWhatsAppText(waId, `Tive uma instabilidade ao gerar sua descrição 😅\n\nPode tentar de novo?`);
        return;
      }
      await sendWhatsAppText(waId, ad);

      u.askFormatChoicePending = true;
      await saveUser(u);
      await sendWhatsAppText(waId, askFormatChoiceText());
      return;
    }

    await sendWhatsAppText(waId, `✅ Recebi sua mensagem!`);
  } catch (err) {
    console.error("Webhook error:", err?.message || err);
  }
});

// ===================== ASAAS routes =====================
app.use("/asaas", asaasRouter());
app.get("/asaas/test", basicAuth, (req, res) => {
  return res.json({
    ok: true,
    asaasWebhookRoute: "/asaas/webhook",
    env: ASAAS_ENV,
    hasApiKey: !!ASAAS_API_KEY,
  });
});

// ===================== Start =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
