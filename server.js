import express from "express";
import crypto from "crypto";

// Se você usa Upstash via REST, mantém fetch global (Node 18+).
// Render Node 22 tem fetch global.

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * =========================
 * CONFIG / ENVs
 * =========================
 */
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();

const USE_UPSTASH = String(process.env.USE_UPSTASH || "").trim().toLowerCase() === "true";

// Upstash REST
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

// Asaas
const ASAAS_BASE_URL = (process.env.ASAAS_BASE_URL || "https://api.asaas.com/v3").trim();
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim();

// OpenAI
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(); // exemplo

/**
 * =========================
 * REGRAS DO PRODUTO
 * =========================
 */
const TRIAL_FREE_USES = 5; // trial por uso (5)
const MAX_REFINES_PER_DESCRIPTION = 2; // 2 refinamentos (depois conta como nova descrição)
const PIX_ACTIVE_DAYS = 30;

// Planos (mensal / por quota)
const PLANS = {
  P1: {
    code: "P1",
    name: "De Vez em Quando",
    price: 24.9,
    monthlyLimit: 20,
    buttonLabel: "Ficar de vez em quando",
  },
  P2: {
    code: "P2",
    name: "Sempre por Perto",
    price: 34.9,
    monthlyLimit: 60,
    buttonLabel: "Quero o Amigo comigo",
  },
  P3: {
    code: "P3",
    name: "Melhor Amigo",
    price: 49.9,
    monthlyLimit: 200,
    buttonLabel: "Virar Melhor Amigo",
  },
};

const HELP_URL = "https://amigodasvendas.com.br";

/**
 * =========================
 * ESTADOS
 * =========================
 * TRIAL: pode usar até 5 sem pagar (mas ainda pedimos nome/doc conforme fluxo)
 * WAIT_NAME: pede nome inicial
 * WAIT_DOC: pede CPF/CNPJ para pagamento
 * WAIT_PLAN: escolhe plano
 * WAIT_PAYMETHOD: escolhe forma pagamento
 * PENDING: aguardando confirmação
 * ACTIVE: usuário com plano ativo (PIX com activeUntil ou CARD com assinatura)
 * BLOCKED: bloqueado por falta de plano ou quota
 *
 * MENU: modo menu
 * MENU_WAIT_NAME: alterar nome
 * MENU_WAIT_DOC: alterar doc
 */
const DEFAULT_STATUS = "TRIAL";

/**
 * =========================
 * CHAVES REDIS
 * =========================
 */
function kStatus(waId) { return `status:${waId}`; }
function kFullName(waId) { return `fullName:${waId}`; }
function kDoc(waId) { return `doc:${waId}`; }
function kPlan(waId) { return `plan:${waId}`; }
function kPayMethod(waId) { return `payMethod:${waId}`; } // "PIX" | "CARD"
function kActiveUntil(waId) { return `activeUntil:${waId}`; } // ms timestamp
function kTrialCount(waId) { return `trialCount:${waId}`; } // quantos usos já consumiu
function kMonthlyUsage(waId, yyyymm) { return `usage:${waId}:${yyyymm}`; } // contador mensal
function kDraft(waId) { return `draft:${waId}`; } // JSON rascunho
function kLastDesc(waId) { return `lastDesc:${waId}`; } // string
function kRefineCount(waId) { return `refines:${waId}`; } // int
function kPrevStatus(waId) { return `prevStatus:${waId}`; } // para voltar do menu

// Asaas
function kAsaasCustomer(waId) { return `asaasCustomer:${waId}`; }
function kAsaasSubscription(waId) { return `asaasSub:${waId}`; } // assinatura (cartão)
function kSubscriptionToWa(subId) { return `asaasSubToWa:${subId}`; } // reverse mapping

/**
 * =========================
 * UTILS
 * =========================
 */
function nowMs() { return Date.now(); }
function yyyymmNow() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}${mm}`;
}

function safeLog(...args) {
  // logs curtos e seguros
  console.log(...args);
}
function safeLogError(prefix, err) {
  const msg = err?.message || err?.toString?.() || "erro";
  console.error(prefix, { message: msg });
}

function firstNameOf(full) {
  const p = String(full || "").trim().split(/\s+/);
  return p[0] || "";
}

function helpUrl() { return HELP_URL; }

function normalizeDocOnlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function isValidCPFOrCNPJ(docDigits) {
  const s = normalizeDocOnlyDigits(docDigits);
  return s.length === 11 || s.length === 14;
}

function looksLikeGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "menu"].includes(t);
}

function isOkToFinish(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "ok";
}

function isPositiveFeedbackLegacy(text) {
  const t = String(text || "").trim().toLowerCase();
  // Aceita apenas respostas curtas (evita confundir “não gostei...” com “gostei”)
  return ["ok", "sim", "gostei", "perfeito", "ótimo", "otimo"].includes(t);
}

/**
 * Sanitiza a formatação do WhatsApp:
 * - remove "**" duplicado
 * - troca "**texto**" por "*texto*"
 * - remove "* *" (com espaço) que gera bug visual
 */
function sanitizeWhatsAppFormatting(s) {
  let out = String(s || "");

  // **texto** -> *texto*
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // remove "* *" (asteriscos separados por espaço)
  out = out.replace(/\*\s+\*/g, "");

  // colapsa múltiplos asteriscos
  out = out.replace(/\*{3,}/g, "**");
  // se ficar "**" solto, remove
  out = out.replace(/\*\*(\s|$)/g, "$1");
  out = out.replace(/(^|\s)\*\*/g, "$1");

  return out;
}

/**
 * =========================
 * REDIS (Upstash REST)
 * =========================
 */
async function upstashFetch(path, bodyObj) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash não configurado");
  }
  const url = `${UPSTASH_REDIS_REST_URL}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj || []),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Upstash erro ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function redisGet(key) {
  if (!USE_UPSTASH) return null;
  const data = await upstashFetch(`/get/${encodeURIComponent(key)}`, []);
  return data?.result ?? null;
}
async function redisSet(key, value) {
  if (!USE_UPSTASH) return;
  await upstashFetch(`/set/${encodeURIComponent(key)}`, [String(value)]);
}
async function redisDel(key) {
  if (!USE_UPSTASH) return;
  await upstashFetch(`/del/${encodeURIComponent(key)}`, []);
}
async function redisIncr(key) {
  if (!USE_UPSTASH) return 0;
  const data = await upstashFetch(`/incr/${encodeURIComponent(key)}`, []);
  return Number(data?.result ?? 0);
}

async function redisSetEx(key, seconds, value) {
  if (!USE_UPSTASH) return;
  await upstashFetch(`/set/${encodeURIComponent(key)}`, [String(value), "EX", String(seconds)]);
}

/**
 * =========================
 * GETTERS/SETTERS DE ESTADO
 * =========================
 */
async function getStatus(waId) {
  const s = await redisGet(kStatus(waId));
  return s || DEFAULT_STATUS;
}
async function setStatus(waId, status) {
  await redisSet(kStatus(waId), status);
}
async function getFullName(waId) {
  return (await redisGet(kFullName(waId))) || "";
}
async function setFullName(waId, name) {
  await redisSet(kFullName(waId), name);
}
async function getDoc(waId) {
  return (await redisGet(kDoc(waId))) || "";
}
async function setDoc(waId, docDigits) {
  await redisSet(kDoc(waId), docDigits);
}
async function getPlan(waId) {
  return (await redisGet(kPlan(waId))) || "";
}
async function setPlan(waId, planCode) {
  await redisSet(kPlan(waId), planCode);
}
async function getPayMethod(waId) {
  return (await redisGet(kPayMethod(waId))) || "";
}
async function setPayMethod(waId, pm) {
  await redisSet(kPayMethod(waId), pm);
}
async function getActiveUntil(waId) {
  const v = await redisGet(kActiveUntil(waId));
  return v ? Number(v) : 0;
}
async function setActiveUntil(waId, ms) {
  await redisSet(kActiveUntil(waId), String(ms));
}
async function clearActiveUntil(waId) {
  await redisDel(kActiveUntil(waId));
}

async function getTrialCount(waId) {
  const v = await redisGet(kTrialCount(waId));
  return v ? Number(v) : 0;
}
async function incrTrialCount(waId) {
  return await redisIncr(kTrialCount(waId));
}

async function getMonthlyUsage(waId) {
  const v = await redisGet(kMonthlyUsage(waId, yyyymmNow()));
  return v ? Number(v) : 0;
}
async function incrMonthlyUsage(waId) {
  return await redisIncr(kMonthlyUsage(waId, yyyymmNow()));
}

async function getDraft(waId) {
  const s = await redisGet(kDraft(waId));
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
async function setDraft(waId, draftObj) {
  await redisSet(kDraft(waId), JSON.stringify(draftObj || {}));
}
async function clearDraft(waId) {
  await redisDel(kDraft(waId));
}

async function getLastDescription(waId) {
  return (await redisGet(kLastDesc(waId))) || "";
}
async function setLastDescription(waId, desc) {
  await redisSet(kLastDesc(waId), desc);
}
async function clearLastDescription(waId) {
  await redisDel(kLastDesc(waId));
}

async function getRefineCount(waId) {
  const v = await redisGet(kRefineCount(waId));
  return v ? Number(v) : 0;
}
async function setRefineCount(waId, n) {
  await redisSet(kRefineCount(waId), String(n));
}
async function clearRefineCount(waId) {
  await redisDel(kRefineCount(waId));
}

async function pushPrevStatus(waId, prev) {
  await redisSet(kPrevStatus(waId), prev);
}
async function popPrevStatus(waId) {
  const prev = (await redisGet(kPrevStatus(waId))) || "TRIAL";
  await redisDel(kPrevStatus(waId));
  return prev;
}

/**
 * =========================
 * WHATSAPP API
 * =========================
 */
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    safeLogError("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID", new Error("ENV missing"));
    return;
  }

  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: sanitizeWhatsAppFormatting(text) },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      safeLogError("Erro ao enviar WhatsApp", new Error(`HTTP ${resp.status}`));
    } else {
      safeLog("Mensagem enviada OK:", data?.messages?.[0]?.id || "ok");
    }
  } catch (e) {
    safeLogError("Erro rede WhatsApp", e);
  }
}

/**
 * =========================
 * ASAAS
 * =========================
 */
async function asaasFetch(path, { method = "GET", body } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY ausente");
  const url = `${ASAAS_BASE_URL}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      access_token: ASAAS_API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findOrCreateAsaasCustomer(waId, name, docDigits) {
  const cached = await redisGet(kAsaasCustomer(waId));
  if (cached) return cached;

  // Cria customer
  const body = {
    name,
    cpfCnpj: docDigits, // obrigatorio para cobrança
    // email opcional
  };

  const created = await asaasFetch(`/customers`, { method: "POST", body });
  const customerId = created?.id;
  if (customerId) await redisSet(kAsaasCustomer(waId), customerId);
  return customerId;
}

async function updateAsaasCustomerDoc(customerId, docDigits) {
  if (!customerId) return;
  await asaasFetch(`/customers/${customerId}`, {
    method: "POST",
    body: { cpfCnpj: docDigits },
  });
}

async function createPixPayment(customerId, planCode, waId) {
  const plan = PLANS[planCode];
  const body = {
    customer: customerId,
    billingType: "PIX",
    value: plan.price,
    description: `Plano ${plan.name} - Amigo das Vendas`,
    externalReference: `wa:${waId}|plan:${planCode}|pm:PIX`,
  };
  const created = await asaasFetch(`/payments`, { method: "POST", body });
  return created;
}

async function createCardSubscription(customerId, planCode, waId) {
  const plan = PLANS[planCode];
  // assinatura recorrente
  const body = {
    customer: customerId,
    billingType: "CREDIT_CARD",
    value: plan.price,
    cycle: "MONTHLY",
    description: `Plano ${plan.name} - Amigo das Vendas`,
    externalReference: `wa:${waId}|plan:${planCode}|pm:CARD`,
  };
  const created = await asaasFetch(`/subscriptions`, { method: "POST", body });
  return created;
}

async function cancelAsaasSubscription(subId) {
  await asaasFetch(`/subscriptions/${subId}`, { method: "DELETE" });
}

/**
 * =========================
 * OPENAI
 * =========================
 */
async function openaiGenerateDescription({ userText, instruction, fullName }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente");

  const prompt = buildPrompt({ userText, instruction, fullName });

  // OpenAI Responses API (sem temperature se seu modelo/rota não suportar)
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `OpenAI HTTP ${resp.status}`);
  }

  // extrai texto
  const out =
    data?.output?.[0]?.content?.[0]?.text ||
    data?.output_text ||
    "";

  return sanitizeWhatsAppFormatting(String(out || "").trim());
}

function buildPrompt({ userText, instruction, fullName }) {
  const first = firstNameOf(fullName);

  return `
Você é um especialista em marketing e copywriting para vendas no WhatsApp.

Objetivo: gerar uma descrição chamativa e vendável para ser enviada em grupos de WhatsApp.

Regras IMPORTANTES:
- O primeiro título DEVE estar em *negrito* (use *texto*).
- Destaques importantes também podem estar em *negrito*, mas sem exagero.
- Use emojis de forma moderada (não poluir).
- Texto curto, fácil de copiar/encaminhar.
- Se faltar informação (preço, sabores, entrega, etc.), preencha com chamadas do tipo:
  "📌 Consulte sabores disponíveis", "💰 Consulte valores", "🚚 Consulte entrega/retirada".

Estrutura:
1) Título chamativo em negrito
2) 2 a 4 linhas curtas de descrição
3) Linha de preço (ou "consulte valores")
4) Linha de entrega/retirada (ou "consulte entrega/retirada")
5) CTA final curto (ex.: "Chama no WhatsApp!")

Personalização:
- Se eu tiver o nome, use o primeiro nome 1 vez de forma natural.

Dados do vendedor:
- Nome (primeiro nome): ${first || "não informado"}

Produto / informações do usuário:
${userText}

Pedido de melhoria (se houver):
${instruction || "Nenhum. Gere a versão inicial."}

Gere APENAS a descrição final, sem explicações.
`.trim();
}

/**
 * =========================
 * DRAFT / EXTRAÇÃO
 * =========================
 */
function mergeDraftFromMessage(draft, userMsg) {
  const d = draft || {
    raw: "",
  };
  const text = String(userMsg || "").trim();
  // Mantém apenas um campo raw (simples), e a IA lida com ausências.
  d.raw = (d.raw ? d.raw + " | " : "") + text;
  return d;
}

function draftToUserText(draft) {
  if (!draft?.raw) return "";
  return draft.raw;
}

function extractImprovementInstruction(text) {
  const t = String(text || "").trim();
  // Se vier "Não gostei..." ou "Quero..." etc, usamos tudo como instrução
  return t;
}

/**
 * =========================
 * CONSUMO / BLOQUEIO
 * =========================
 */
async function consumeOneDescriptionOrBlock(waId) {
  const status = await getStatus(waId);

  // Se está em TRIAL: conta usos até 5
  if (status === "TRIAL") {
    const used = await getTrialCount(waId);
    if (used >= TRIAL_FREE_USES) return false;
    await incrTrialCount(waId);
    return true;
  }

  // Se ACTIVE: controla quota mensal
  if (status === "ACTIVE") {
    const planCode = await getPlan(waId);
    const plan = PLANS[planCode];
    if (!plan) return false;

    const used = await getMonthlyUsage(waId);
    if (used >= plan.monthlyLimit) return false;

    await incrMonthlyUsage(waId);
    return true;
  }

  // Se PENDING/BLOCKED etc não consome
  return false;
}

/**
 * =========================
 * TEXTOS
 * =========================
 */
function plansMenuText() {
  return (
    "Escolha seu plano:\n\n" +
    `1) 🤝 *${PLANS.P1.name}* — R$ ${PLANS.P1.price.toFixed(2).replace(".", ",")}/mês\n` +
    `   ✔ ${PLANS.P1.monthlyLimit} descrições por mês\n\n` +
    `2) 💬 *${PLANS.P2.name}* ⭐ — R$ ${PLANS.P2.price.toFixed(2).replace(".", ",")}/mês\n` +
    `   ✔ ${PLANS.P2.monthlyLimit} descrições por mês\n\n` +
    `3) 🚀 *${PLANS.P3.name}* — R$ ${PLANS.P3.price.toFixed(2).replace(".", ",")}/mês\n` +
    `   ✔ ${PLANS.P3.monthlyLimit} descrições por mês\n\n` +
    "Responda *1*, *2* ou *3*."
  );
}

function payMethodText() {
  return (
    "Perfeito! Agora escolha a forma de pagamento:\n\n" +
    "1) *Cartão de crédito*\n" +
    "2) *Pix*\n\n" +
    "Responda *1* ou *2*."
  );
}

function askFeedbackText() {
  return (
    "Quer ajustar algo?\n\n" +
    "Me diga *o que você quer que eu melhore* (ex.: “mais emoji”, “muda o título”, “mais emocional”, “mais curto”, “mais direto”).\n\n" +
    "✅ Se estiver tudo certo com a descrição, me envie *OK*."
  );
}

function menuText() {
  return (
    "📌 *MENU*\n\n" +
    "1) Minha assinatura\n" +
    "2) Alterar nome\n" +
    "3) Alterar CPF/CNPJ\n" +
    "4) Mudar plano\n" +
    "5) Cancelar plano\n" +
    `6) Ajuda (${helpUrl()})\n\n` +
    "Responda com *1* a *6*.\n\n" +
    "Dica: Você pode escrever *MENU* a qualquer momento."
  );
}

async function buildMySubscriptionText(waId) {
  const status = await getStatus(waId);

  if (status === "TRIAL") {
    const used = await getTrialCount(waId);
    return (
      "📄 *Minha assinatura*\n\n" +
      "Status: *Grátis (trial)*\n" +
      `Grátis restantes: *${Math.max(0, TRIAL_FREE_USES - used)}/${TRIAL_FREE_USES}*\n\n` +
      "Digite *MENU* para ver as opções."
    );
  }

  if (status !== "ACTIVE") {
    return (
      "📄 *Minha assinatura*\n\n" +
      `Status: *${status}*\n\n` +
      "Digite *MENU* para ver as opções."
    );
  }

  const planCode = await getPlan(waId);
  const plan = PLANS[planCode];
  const used = await getMonthlyUsage(waId);
  const limit = plan?.monthlyLimit ?? 0;

  const payMethod = await getPayMethod(waId);

  let extra = "";
  if (payMethod === "PIX") {
    const until = await getActiveUntil(waId);
    if (until) {
      const msLeft = until - nowMs();
      const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
      extra = `Validade (Pix): *${daysLeft} dia(s)* restantes\n`;
    } else {
      extra = "Validade (Pix): *expirado*\n";
    }
  } else if (payMethod === "CARD") {
    extra = "Pagamento: *Cartão*\n";
  }

  return (
    "📄 *Minha assinatura*\n\n" +
    "Status: *Ativo*\n" +
    `Plano: *${plan?.name || "-"}*\n` +
    `Uso do mês: *${used}/${limit}*\n` +
    extra +
    "\nDigite *MENU* para ver as opções."
  );
}

/**
 * =========================
 * WEBHOOKS
 * =========================
 */
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap rodando");
});

// Verificação do webhook Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Webhook WhatsApp (mensagens e status)
 */
app.post("/webhook", async (req, res) => {
  // responde rápido
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();

    // ignora mock do painel
    if (metaPhoneId === "123456123") return;

    // valida seu número
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    // status (sent, delivered, read)
    if (value?.statuses?.length) {
      const st = value.statuses[0];
      safeLog("Status recebido:", { status: st.status, recipient_id: st.recipient_id });
      return;
    }

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const waId = msg.from; // cliente

    if (!waId) return;

    // texto normalizado
    const text = (msg.text?.body || "").trim();

    // Comando MENU
    if (text.toLowerCase() === "menu") {
      const current = await getStatus(waId);
      await pushPrevStatus(waId, current);
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    let status = await getStatus(waId);
    const fullName = await getFullName(waId);
    const doc = await getDoc(waId);

    // ===== MENU FLOW =====
    if (status === "MENU") {
      // Se a pessoa não responder 1–6, a gente sai do menu e trata como “mensagem normal”
      if (!["1","2","3","4","5","6"].includes(text)) {
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        status = prev; // continua o fluxo normal com a mensagem atual
      } else if (text === "1") {
        await sendWhatsAppText(waId, await buildMySubscriptionText(waId));
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev); // não prende no menu
        return;
      } else if (text === "2") {
        await setStatus(waId, "MENU_WAIT_NAME");
        await sendWhatsAppText(waId, "Me envie seu *nome completo* 🙂");
        return;
      } else if (text === "3") {
        await setStatus(waId, "MENU_WAIT_DOC");
        await sendWhatsAppText(waId, "Me envie seu *CPF ou CNPJ* (somente números).");
        return;
      } else if (text === "4") {
        // Mudar plano: se tiver assinatura de cartão, cancela a atual antes
        const payMethod = await getPayMethod(waId);
        if (payMethod === "CARD") {
          const subId = await redisGet(kAsaasSubscription(waId));
          if (subId) {
            try {
              await cancelAsaasSubscription(subId);
              await redisDel(kAsaasSubscription(waId));
              await redisDel(kSubscriptionToWa(subId));
            } catch (e) {
              safeLogError("Erro ao mudar plano (cancelar assinatura):", e);
              await sendWhatsAppText(waId, "Tive um problema para mudar seu plano agora. Tente novamente em instantes.");
              return;
            }
          }
        }
        // Sai do menu e vai para escolha de plano
        await redisDel(kPrevStatus(waId));
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      } else if (text === "5") {
        // Cancelar plano
        const payMethod = await getPayMethod(waId);
        if (payMethod === "CARD") {
          const subId = await redisGet(kAsaasSubscription(waId));
          if (subId) {
            try {
              await cancelAsaasSubscription(subId);
              await redisDel(kAsaasSubscription(waId));
              await redisDel(kSubscriptionToWa(subId));
            } catch (e) {
              safeLogError("Erro ao cancelar assinatura:", e);
              await sendWhatsAppText(waId, "Não consegui cancelar agora. Tente novamente em instantes.");
              return;
            }
          }
        }
        // PIX: não há recorrência; só desativa
        await clearActiveUntil(waId);
        await redisDel(kPrevStatus(waId));
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, "✅ Plano cancelado.\n\nSe quiser voltar, digite *MENU* e escolha um plano.");
        return;
      } else if (text === "6") {
        await sendWhatsAppText(waId, `❓ Ajuda: ${helpUrl()}`);
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev); // não prende no menu
        return;
      }
      // Se caiu aqui, foi saída do menu por texto livre, então NÃO retorna.
    }

    if (status === "MENU_WAIT_NAME") {
      const name = String(text || "").trim();
      if (name.length < 5) {
        await sendWhatsAppText(waId, "Me envie seu *nome completo*, por favor 🙂");
        return;
      }
      await setFullName(waId, name);
      const prev = await popPrevStatus(waId);
      await setStatus(waId, prev);
      await sendWhatsAppText(waId, "✅ Nome atualizado.\n\nDigite *MENU* para ver as opções.");
      return;
    }

    if (status === "MENU_WAIT_DOC") {
      const docDigits = normalizeDocOnlyDigits(text);
      if (!isValidCPFOrCNPJ(docDigits)) {
        await sendWhatsAppText(waId, "CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números* 🙂");
        return;
      }
      await setDoc(waId, docDigits);

      const customerId = await redisGet(kAsaasCustomer(waId));
      if (customerId) {
        try { await updateAsaasCustomerDoc(customerId, docDigits); } catch { /* silencioso */ }
      }

      const prev = await popPrevStatus(waId);
      await setStatus(waId, prev);
      await sendWhatsAppText(waId, "✅ CPF/CNPJ atualizado.\n\nDigite *MENU* para ver as opções.");
      return;
    }

    // Fluxo inicial de nome (primeiro contato)
    if (!fullName && status === "TRIAL" && looksLikeGreeting(text)) {
      await setStatus(waId, "WAIT_NAME");
      await sendWhatsAppText(waId, "Olá! 😊 Antes de começar, me diga seu *nome completo*.");
      return;
    }

    if (status === "WAIT_NAME") {
      const name = String(text || "").trim();
      if (name.length < 5) {
        await sendWhatsAppText(waId, "Me envie seu *nome completo*, por favor 🙂");
        return;
      }
      await setFullName(waId, name);
      await setStatus(waId, "TRIAL");
      await sendWhatsAppText(waId, `Perfeito, ${firstNameOf(name)}! ✅\nAgora me diga o que você quer vender (ex.: “brigadeiro gourmet R$ 10”).`);
      return;
    }

    // ===================== FINALIZAÇÃO: OK =====================
    if (isOkToFinish(text)) {
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);

      await sendWhatsAppText(waId, "Fechado! ✅\nMe mande o próximo produto que você quer vender 🙂");
      return;
    }

    // ===================== FLUXO DE PAGAMENTO =====================
    status = await getStatus(waId);

    const needsPaymentFlow =
      status === "BLOCKED" ||
      status === "PENDING" ||
      status === "WAIT_DOC" ||
      status === "WAIT_PLAN" ||
      status === "WAIT_PAYMETHOD";

    if (needsPaymentFlow) {
      if (status === "BLOCKED") {
        // inicia fluxo pagamento
        await setStatus(waId, "WAIT_DOC");
        await sendWhatsAppText(
          waId,
          "Para ativar seu plano 🙂\n\nMe envie seu *CPF ou CNPJ* (somente números).\nÉ só para registrar o pagamento."
        );
        return;
      }

      if (status === "WAIT_DOC") {
        const docDigits = normalizeDocOnlyDigits(text);
        if (!isValidCPFOrCNPJ(docDigits)) {
          await sendWhatsAppText(waId, "CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números* 🙂");
          return;
        }
        await setDoc(waId, docDigits);

        // cria/acha customer (precisa do nome)
        const name = (await getFullName(waId)) || "Cliente";
        try {
          await findOrCreateAsaasCustomer(waId, name, docDigits);
        } catch (e) {
          safeLogError("Erro Asaas customer", e);
          await sendWhatsAppText(waId, "Tive um problema ao preparar o pagamento agora. Tente novamente em instantes.");
          return;
        }

        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      if (status === "WAIT_PLAN") {
        const choice = String(text || "").trim();
        const planCode = choice === "1" ? "P1" : choice === "2" ? "P2" : choice === "3" ? "P3" : "";
        if (!planCode) {
          await sendWhatsAppText(waId, "Responda *1*, *2* ou *3* para escolher o plano 🙂");
          return;
        }
        await setPlan(waId, planCode);
        await setStatus(waId, "WAIT_PAYMETHOD");
        await sendWhatsAppText(waId, payMethodText());
        return;
      }

      if (status === "WAIT_PAYMETHOD") {
        const choice = String(text || "").trim();
        const pm = choice === "1" ? "CARD" : choice === "2" ? "PIX" : "";
        if (!pm) {
          await sendWhatsAppText(waId, "Responda *1* (cartão) ou *2* (pix) 🙂");
          return;
        }

        await setPayMethod(waId, pm);

        const planCode = await getPlan(waId);
        const plan = PLANS[planCode];
        const customerId = await redisGet(kAsaasCustomer(waId));
        const name = await getFullName(waId);

        if (!customerId) {
          await setStatus(waId, "WAIT_DOC");
          await sendWhatsAppText(waId, "Preciso do seu *CPF/CNPJ* para registrar o pagamento. Me envie somente números 🙂");
          return;
        }

        try {
          if (pm === "PIX") {
            const payment = await createPixPayment(customerId, planCode, waId);
            const payUrl = payment?.invoiceUrl || payment?.paymentLink || payment?.invoiceUrl;
            await setStatus(waId, "PENDING");
            await sendWhatsAppText(
              waId,
              `Perfeito, ${firstNameOf(name)}! Agora vamos ativar seu plano 🙂`
            );
            await sendWhatsAppText(
              waId,
              `✅ Aqui está seu link para pagamento via *Pix*:\n${payUrl}\n\nAssim que confirmar, eu libero automaticamente.`
            );
            return;
          } else {
            // CARD recorrente
            const sub = await createCardSubscription(customerId, planCode, waId);
            const subId = sub?.id;
            const payUrl = sub?.invoiceUrl || sub?.paymentLink || sub?.url || sub?.checkoutUrl;

            if (subId) {
              await redisSet(kAsaasSubscription(waId), subId);
              await redisSet(kSubscriptionToWa(subId), waId);
            }

            await setStatus(waId, "PENDING");
            await sendWhatsAppText(
              waId,
              `Perfeito, ${firstNameOf(name)}! Agora vamos ativar seu plano 🙂`
            );
            await sendWhatsAppText(
              waId,
              `✅ Aqui está seu link para pagamento no *Cartão*:\n${payUrl}\n\nAssim que confirmar, eu libero automaticamente.`
            );
            return;
          }
        } catch (e) {
          safeLogError("Erro criando pagamento Asaas", e);
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
          // volta para plano
          await setStatus(waId, "WAIT_PLAN");
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }
      }

      if (status === "PENDING") {
        await sendWhatsAppText(waId, "⏳ Estou aguardando a confirmação do pagamento.\nAssim que confirmar, eu libero automaticamente ✅");
        return;
      }
    }

    // ===================== SE ATIVO (PIX) CHECA EXPIRAÇÃO =====================
    if (status === "ACTIVE") {
      const pm = await getPayMethod(waId);
      if (pm === "PIX") {
        const until = await getActiveUntil(waId);
        if (until && nowMs() > until) {
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Seu plano expirou. Digite *MENU* ou escolha um plano para renovar 🙂");
          await setStatus(waId, "WAIT_PLAN");
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }
      }
    }

    // ===================== CRIA / ATUALIZA DRAFT =====================
    const draft = mergeDraftFromMessage(await getDraft(waId), text);
    await setDraft(waId, draft);

    // ===================== REFINAMENTO OU NOVA DESCRIÇÃO =====================
    const lastDesc = await getLastDescription(waId);
    const refineCount = await getRefineCount(waId);

    // Se existe uma descrição anterior e usuário pediu melhorias (e não é OK)
    if (lastDesc && !isOkToFinish(text)) {
      const instruction = extractImprovementInstruction(text);

      // Se o usuário respondeu "sim/gostei" (legacy), encerra
      if (isPositiveFeedbackLegacy(text)) {
        await sendWhatsAppText(waId, "Boa! ✅\nSe quiser fazer outra descrição, é só me mandar o próximo produto 🙂");
        await clearDraft(waId);
        await clearRefineCount(waId);
        await clearLastDescription(waId);
        return;
      }

      // Se já estourou limite de refinamentos, conta como nova descrição
      if (refineCount >= MAX_REFINES_PER_DESCRIPTION) {
        const okConsume = await consumeOneDescriptionOrBlock(waId);
        if (!okConsume) {
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Você atingiu o limite do seu plano.\nDigite *MENU* para ver opções.");
          return;
        }
        await clearRefineCount(waId);
      } else {
        await setRefineCount(waId, refineCount + 1);
      }

      try {
        const gen = await openaiGenerateDescription({
          userText: draftToUserText(draft),
          instruction,
          fullName: await getFullName(waId),
        });

        await setLastDescription(waId, gen);
        await sendWhatsAppText(waId, gen);
        await sendWhatsAppText(waId, askFeedbackText());
      } catch (e) {
        safeLogError("Erro OpenAI (refino):", e);
        await sendWhatsAppText(waId, "Tive um problema ao melhorar a descrição agora. Tente novamente em instantes.");
      }
      return;
    }

    // ===================== GERA PRIMEIRA DESCRIÇÃO =====================
    const okConsume = await consumeOneDescriptionOrBlock(waId);
    if (!okConsume) {
      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(
        waId,
        "Você atingiu o limite do seu plano (ou terminou o trial).\nDigite *MENU* para ver as opções."
      );
      return;
    }

    // Se estava no TRIAL e acabou agora, ainda gera (porque consumiu com sucesso)
    try {
      const gen = await openaiGenerateDescription({
        userText: draftToUserText(draft),
        instruction: "",
        fullName: await getFullName(waId),
      });

      await setLastDescription(waId, gen);
      await sendWhatsAppText(waId, gen);
      await sendWhatsAppText(waId, askFeedbackText());
    } catch (e) {
      safeLogError("Erro OpenAI (geração):", e);
      await sendWhatsAppText(waId, "Tive um problema ao gerar a descrição agora. Tente novamente em instantes.");
    }
  } catch (err) {
    safeLogError("Erro no webhook:", err);
  }
});

/**
 * =========================
 * WEBHOOK ASAAS (opcional)
 * =========================
 * Se você já tem /asaas/webhook configurado, mantenha.
 * Aqui deixo um endpoint simples para receber confirmações e ativar plano automaticamente.
 */
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    // valida token opcional
    if (ASAAS_WEBHOOK_TOKEN) {
      const token = (req.headers["asaas-access-token"] || req.headers["x-asaas-token"] || "").toString();
      if (token && token !== ASAAS_WEBHOOK_TOKEN) return;
    }

    const event = req.body?.event;
    const payment = req.body?.payment;
    const subscription = req.body?.subscription;

    // CONFIRMAÇÃO PIX (payment)
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
      const ext = payment?.externalReference || "";
      const waMatch = String(ext).match(/wa:([^|]+)/);
      const planMatch = String(ext).match(/plan:(P\d)/);
      const pmMatch = String(ext).match(/pm:(PIX|CARD)/);

      const waId = waMatch?.[1];
      const planCode = planMatch?.[1];
      const pm = pmMatch?.[1];

      if (waId && planCode) {
        await setPlan(waId, planCode);
        await setPayMethod(waId, pm || "PIX");

        if ((pm || "PIX") === "PIX") {
          await setActiveUntil(waId, nowMs() + PIX_ACTIVE_DAYS * 24 * 60 * 60 * 1000);
        }

        await setStatus(waId, "ACTIVE");
        await sendWhatsAppText(waId, "✅ Pagamento confirmado! Seu plano está ativo.\nAgora me mande o produto que você quer vender 🙂");
      }
      return;
    }

    // ASSINATURA CARTÃO: quando confirmar primeira cobrança, ativar
    if (event && String(event).includes("SUBSCRIPTION")) {
      // (depende do payload do Asaas; aqui deixamos simples)
      // você pode mapear subscription.id -> waId usando kSubscriptionToWa
      const subId = subscription?.id;
      if (subId) {
        const waId = await redisGet(kSubscriptionToWa(subId));
        if (waId) {
          await setPayMethod(waId, "CARD");
          await setStatus(waId, "ACTIVE");
          await sendWhatsAppText(waId, "✅ Assinatura confirmada! Seu plano está ativo.\nAgora me mande o produto que você quer vender 🙂");
        }
      }
      return;
    }
  } catch (e) {
    safeLogError("Erro Asaas webhook", e);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  safeLog(`Servidor rodando na porta ${PORT}`);
});
