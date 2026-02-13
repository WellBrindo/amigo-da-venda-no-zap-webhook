import express from "express";
import crypto from "crypto";

// ===================== APP =====================
const app = express();
app.use(express.json());

// ===================== ENV (sempre trim) =====================
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();

const USE_UPSTASH = String(process.env.USE_UPSTASH || "true").trim().toLowerCase() === "true";
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_BASE_URL = (process.env.ASAAS_BASE_URL || "https://api.asaas.com").trim();
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// ===================== CONFIG PRODUTO =====================
const FREE_DESCRIPTIONS_LIMIT = 5; // trial por usos

const PLANS = {
  P1: { code: "P1", name: "De Vez em Quando", price: 24.9, monthlyLimit: 20 },
  P2: { code: "P2", name: "Sempre por Perto", price: 34.9, monthlyLimit: 60 },
  P3: { code: "P3", name: "Melhor Amigo", price: 49.9, monthlyLimit: 200 },
};

// Pix = 30 dias após ativação
const PIX_ACTIVE_DAYS = 30;

// Refinamento: até 2 (depois disso vira “nova descrição”)
const MAX_REFINES_PER_DESCRIPTION = 2;

// TTLs
const TTL_WEEK_SECONDS = 60 * 60 * 24 * 7;
const TTL_MONTH_SECONDS = 60 * 60 * 24 * 31;
const TTL_DRAFT_SECONDS = 60 * 60; // 1 hora (limpeza automática de rascunho)

// ===================== HELPERS (SEGURANÇA / LOG) =====================
function safeLogError(label, err) {
  const msg = String(err?.message || err || "").slice(0, 180);
  console.error(label, { message: msg });
}

function nowMs() {
  return Date.now();
}

function sha256(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

// ===================== REDIS (UPSTASH REST) =====================
async function redisFetch(path, { method = "GET", body = null } = {}) {
  if (!USE_UPSTASH) throw new Error("USE_UPSTASH desativado.");
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) throw new Error("Upstash não configurado.");

  const resp = await fetch(`${UPSTASH_REDIS_REST_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Upstash ${resp.status}: ${JSON.stringify(data).slice(0, 240)}`);
  }
  return data;
}

async function redisGet(key) {
  if (!USE_UPSTASH) return null;
  const data = await redisFetch(`/get/${encodeURIComponent(key)}`);
  return data?.result ?? null;
}

async function redisSet(key, value) {
  if (!USE_UPSTASH) return;
  await redisFetch(`/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`);
}

async function redisSetEx(key, value, ttlSeconds) {
  if (!USE_UPSTASH) return;
  await redisFetch(`/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}?EX=${ttlSeconds}`);
}

async function redisDel(key) {
  if (!USE_UPSTASH) return;
  await redisFetch(`/del/${encodeURIComponent(key)}`);
}

async function redisExists(key) {
  if (!USE_UPSTASH) return 0;
  const data = await redisFetch(`/exists/${encodeURIComponent(key)}`);
  return Number(data?.result || 0);
}

async function redisIncr(key) {
  if (!USE_UPSTASH) return 0;
  const data = await redisFetch(`/incr/${encodeURIComponent(key)}`);
  return Number(data?.result || 0);
}

// ===================== KEYS =====================
function kStatus(waId) { return `status:${waId}`; }
function kFullName(waId) { return `fullName:${waId}`; }
function kDoc(waId) { return `doc:${waId}`; }
function kPlan(waId) { return `plan:${waId}`; }
function kPayMethod(waId) { return `paymethod:${waId}`; } // "CARD" | "PIX"
function kActiveUntil(waId) { return `active_until:${waId}`; } // ms timestamp (pix)
function kDraft(waId) { return `draft:${waId}`; }
function kRefineCount(waId) { return `refines:${waId}`; }
function kLastDescription(waId) { return `lastdesc:${waId}`; }

function kPrevStatus(waId) { return `prev_status:${waId}`; }
function kSeenMsg(msgId) { return `msg_seen:${msgId}`; }

function kTrialUses(waId) { return `trial_uses:${waId}`; }
function kMonthlyUsage(waId, yyyymm) { return `usage:${waId}:${yyyymm}`; }

function currentYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

// Asaas mappings
function kAsaasCustomer(waId) { return `asaas_customer:${waId}`; }
function kAsaasSubscription(waId) { return `asaas_subscription:${waId}`; }
function kSubscriptionToWa(subscriptionId) { return `subscription_to_wa:${subscriptionId}`; }
function kAsaasPayment(waId) { return `asaas_payment:${waId}`; }
function kPaymentToWa(paymentId) { return `payment_to_wa:${paymentId}`; }
function kAsaasEvt(hash) { return `asaas_evt:${hash}`; }

// ===================== STATUS =====================
// TRIAL / BLOCKED / WAIT_NAME / WAIT_DOC / WAIT_PLAN / WAIT_PAYMETHOD / PENDING / ACTIVE
// MENU / MENU_WAIT_NAME / MENU_WAIT_DOC
async function getStatus(waId) {
  const s = await redisGet(kStatus(waId));
  return s || "TRIAL";
}
async function setStatus(waId, status) { await redisSet(kStatus(waId), status); }

async function getFullName(waId) { return (await redisGet(kFullName(waId))) || ""; }
async function setFullName(waId, name) { await redisSet(kFullName(waId), name); }

async function getDoc(waId) { return (await redisGet(kDoc(waId))) || ""; }
async function setDoc(waId, docDigits) { await redisSet(kDoc(waId), docDigits); }

async function getPlan(waId) { return (await redisGet(kPlan(waId))) || ""; }
async function setPlan(waId, planCode) { await redisSet(kPlan(waId), planCode); }

async function getPayMethod(waId) { return (await redisGet(kPayMethod(waId))) || ""; }
async function setPayMethod(waId, method) { await redisSet(kPayMethod(waId), method); }

async function getActiveUntil(waId) {
  const v = await redisGet(kActiveUntil(waId));
  return v ? Number(v) : 0;
}
async function setActiveUntil(waId, tsMs) { await redisSet(kActiveUntil(waId), String(tsMs)); }
async function clearActiveUntil(waId) { await redisDel(kActiveUntil(waId)); }

// Draft/refine/lastdesc (com TTL 1 hora)
async function getDraft(waId) {
  const raw = await redisGet(kDraft(waId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function setDraft(waId, draft) { await redisSetEx(kDraft(waId), JSON.stringify(draft), TTL_DRAFT_SECONDS); }
async function clearDraft(waId) { await redisDel(kDraft(waId)); }

async function getRefineCount(waId) {
  const v = await redisGet(kRefineCount(waId));
  return v ? Number(v) : 0;
}
async function setRefineCount(waId, n) { await redisSetEx(kRefineCount(waId), String(n), TTL_DRAFT_SECONDS); }
async function clearRefineCount(waId) { await redisDel(kRefineCount(waId)); }

async function getLastDescription(waId) { return (await redisGet(kLastDescription(waId))) || ""; }
async function setLastDescription(waId, txt) { await redisSetEx(kLastDescription(waId), txt, TTL_DRAFT_SECONDS); }
async function clearLastDescription(waId) { await redisDel(kLastDescription(waId)); }

// Trial
async function getTrialUses(waId) {
  const v = await redisGet(kTrialUses(waId));
  return v ? Number(v) : 0;
}
async function incrTrialUses(waId) {
  const key = kTrialUses(waId);
  const next = await redisIncr(key);
  await redisSetEx(key, String(next), TTL_MONTH_SECONDS);
  return next;
}

// Monthly usage
async function getMonthlyUsage(waId) {
  const key = kMonthlyUsage(waId, currentYYYYMM());
  const v = await redisGet(key);
  return v ? Number(v) : 0;
}
async function incrMonthlyUsage(waId) {
  const key = kMonthlyUsage(waId, currentYYYYMM());
  const next = await redisIncr(key);
  await redisSetEx(key, String(next), TTL_MONTH_SECONDS);
  return next;
}

// ===================== TEXTO / UX =====================
function firstNameOf(fullName) {
  const t = String(fullName || "").trim();
  if (!t) return "";
  return t.split(/\s+/)[0] || "";
}

function normalizeDocOnlyDigits(text) {
  return String(text || "").replace(/\D+/g, "");
}

function isValidCPFOrCNPJ(digits) {
  const d = String(digits || "").replace(/\D+/g, "");
  return d.length === 11 || d.length === 14;
}

function looksLikeGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"].includes(t);
}

// ✅ finaliza com OK (determinante)
function isOkToFinish(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "ok" || t === "ok!" || t === "ok ✅" || t === "ok✅";
}

// IMPORTANTE: não pode considerar "não gostei" como positivo só porque tem "gostei"
function isPositiveFeedbackLegacy(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.includes("não gostei") || t.includes("nao gostei")) return false;

  return (
    t === "sim" ||
    t === "gostei" ||
    (t.includes("gostei") && !t.includes("não gostei") && !t.includes("nao gostei"))
  );
}

// Extrai instruções do usuário para refinamento
function extractImprovementInstruction(text) {
  let t = String(text || "").trim();
  if (!t) return "";

  const lower = t.toLowerCase();
  const idx1 = lower.indexOf("não gostei");
  const idx2 = lower.indexOf("nao gostei");

  let instr = "";
  if (idx1 >= 0) instr = t.slice(idx1 + "não gostei".length).trim();
  else if (idx2 >= 0) instr = t.slice(idx2 + "nao gostei".length).trim();

  if (!instr) instr = t;

  instr = instr.replace(/^do\s+/i, "").trim();
  return instr;
}

function askFeedbackText() {
  return (
    "💬 *Quer melhorar algo?*\n\n" +
    "Me diga *o que você quer que eu melhore* (ex.: “mais emoji”, “muda o título”, “mais emocional”, “mais curto”, “mais direto”).\n\n" +
    "Se estiver tudo certo, responda *OK* ✅"
  );
}

function helpUrl() {
  return "https://amigodasvendas.com.br";
}

function isMenuCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "menu" || t === "cardápio" || t === "cardapio";
}

function isExitMenuText(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "sair" || t === "voltar" || t === "cancelar";
}

function menuText() {
  return (
    "📌 *MENU*\n\n" +
    "1) Minha assinatura\n" +
    "2) Alterar nome\n" +
    "3) Alterar CPF/CNPJ\n" +
    "4) Mudar plano\n" +
    "5) Cancelar plano\n" +
    "6) Ajuda\n\n" +
    "Responda com *1–6*."
  );
}

async function pushPrevStatus(waId, status) {
  await redisSetEx(kPrevStatus(waId), status, 60 * 10); // 10 min
}

async function popPrevStatus(waId) {
  const s = await redisGet(kPrevStatus(waId));
  await redisDel(kPrevStatus(waId));
  return s || "TRIAL";
}

async function buildMySubscriptionText(waId) {
  const status = await getStatus(waId);

  if (status !== "ACTIVE") {
    const used = await getTrialUses(waId);
    const left = Math.max(0, FREE_DESCRIPTIONS_LIMIT - used);
    return (
      "📄 *Minha assinatura*\n\n" +
      "Status: *Trial*\n" +
      `Grátis restantes: *${left}* de *${FREE_DESCRIPTIONS_LIMIT}*\n\n" +
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

function plansMenuText() {
  return (
    "Escolha um plano para continuar:\n\n" +
    "🤝 1. *De Vez em Quando* — R$ 24,90/mês\n" +
    "• 20 descrições/mês\n\n" +
    "💬 2. *Sempre por Perto* ⭐ — R$ 34,90/mês\n" +
    "• 60 descrições/mês\n\n" +
    "🚀 3. *Melhor Amigo* — R$ 49,90/mês\n" +
    "• 200 descrições/mês\n\n" +
    "Responda *1*, *2* ou *3*."
  );
}

function payMethodText() {
  return (
    "Como você quer pagar?\n\n" +
    "1) Cartão\n" +
    "2) Pix\n\n" +
    "Responda *1* ou *2*."
  );
}

// ===================== SANITIZADOR (WhatsApp markdown) =====================
function sanitizeWhatsAppMarkdown(s) {
  let out = String(s || "");

  // **bold** -> *bold* (WhatsApp)
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // remove casos de * * quebrado
  out = out.replace(/\*\s+\*/g, "");

  // colapsa múltiplos asteriscos
  out = out.replace(/\*{3,}/g, "**");

  // evita linhas com "Preço" duplicando negrito de forma estranha
  out = out.replace(/\*Preço\*\s*:\s*\*/gi, "*Preço:* ");
  out = out.replace(/\*Preço\*\s*:/gi, "*Preço:*");

  // limpa espaços extras
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.trim();

  return out;
}

// ===================== WHATSAPP SEND =====================
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID.");
    return;
  }

  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: String(text || "") },
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
      console.error("Erro ao enviar mensagem:", resp.status, { message: data?.error?.message || "send_failed" });
    } else {
      console.log("Mensagem enviada OK:", data?.messages?.[0]?.id || "ok");
    }
  } catch (err) {
    safeLogError("Erro de rede ao enviar mensagem:", err);
  }
}

// ===================== OPENAI (Responses API) =====================
async function openaiGenerateDescription({ userText, instruction = "", fullName = "" }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente.");

  const system = `
Você é o "Amigo das Vendas": cria descrições de venda curtas e chamativas para WhatsApp.

Regras IMPORTANTES:
- O título deve estar em negrito no padrão WhatsApp: *TÍTULO*
- Use emojis moderados (não exagerar).
- Destaque APENAS 2 a 4 trechos importantes em negrito (WhatsApp: *...*). Não deixe tudo em negrito.
- Estrutura sugerida:
  1) *TÍTULO*
  2) 2–4 linhas com benefícios e apelo
  3) Linha com preço/valor (se houver) ou "Consulte valores"
  4) Linha com entrega/retirada (se houver) ou "Entrega/retirada a combinar"
  5) CTA curto (ex.: "Chama no WhatsApp para pedir!").
- Se faltarem dados (sabores, preço, entrega), não invente. Use texto neutro tipo "Consulte sabores disponíveis" / "Consulte valores".
- Seja humano e vendedor, porém sem parecer spam.
`;

  const user = `
Produto / mensagem do cliente:
${userText}

Nome do cliente (para personalização leve, se útil): ${fullName || "-"}

Pedido de melhoria (se houver):
${instruction || "(nenhum)"} 
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || "openai_failed";
    throw new Error(msg);
  }

  // responses api: tenta extrair texto
  const out =
    data?.output_text ||
    data?.output?.[0]?.content?.[0]?.text ||
    "";

  return sanitizeWhatsAppMarkdown(out);
}

// ===================== DRAFT PARSER =====================
function mergeDraftFromMessage(draft, messageText) {
  const text = String(messageText || "").trim();

  const next = draft ? { ...draft } : { raw: "" };
  next.raw = [next.raw, text].filter(Boolean).join(" ").trim();

  // tenta detectar preço tipo "R$ 10" / "10,00" / "10"
  const priceMatch = next.raw.match(/R\$\s*([\d.,]+)/i) || next.raw.match(/\b(\d{1,4}[.,]\d{2})\b/);
  if (priceMatch && !next.price) {
    next.price = priceMatch[0].toUpperCase().includes("R$")
      ? `R$ ${priceMatch[1]}`
      : `R$ ${priceMatch[1]}`;
  }

  // tentativa simples de produto: primeira frase
  if (!next.product) {
    next.product = text;
  }

  return next;
}

function draftToUserText(draft) {
  const product = draft?.product || "";
  const price = draft?.price || "";
  const raw = draft?.raw || "";

  let base = raw || product;

  if (!price) {
    base += "\n(Obs: cliente não informou preço.)";
  }

  return base.trim();
}

// ===================== CONSUMO =====================
async function consumeOneDescriptionOrBlock(waId) {
  const status = await getStatus(waId);

  if (status === "ACTIVE") {
    const planCode = await getPlan(waId);
    const plan = PLANS[planCode];
    const used = await getMonthlyUsage(waId);
    if (!plan) return false;

    if (used >= plan.monthlyLimit) {
      await setStatus(waId, "BLOCKED");
      return false;
    }

    await incrMonthlyUsage(waId);
    return true;
  }

  // Trial
  if (status === "TRIAL") {
    const used = await getTrialUses(waId);
    if (used >= FREE_DESCRIPTIONS_LIMIT) {
      await setStatus(waId, "BLOCKED");
      return false;
    }
    await incrTrialUses(waId);
    return true;
  }

  return false;
}

// ===================== ASAAS =====================
async function asaasFetch(path, { method = "GET", body = null, headers = {} } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY ausente.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      access_token: ASAAS_API_KEY,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function nextDueDateISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function updateAsaasCustomerDoc(customerId, cpfCnpj) {
  if (!customerId) return;
  const doc = String(cpfCnpj || "").replace(/\D+/g, "");
  if (!doc) return;
  await asaasFetch(`/v3/customers/${customerId}`, {
    method: "POST",
    body: { cpfCnpj: doc },
  });
}

async function getOrCreateAsaasCustomer(waId, fullName, cpfCnpj) {
  const key = kAsaasCustomer(waId);
  const saved = await redisGet(key);

  if (saved) {
    await updateAsaasCustomerDoc(saved, cpfCnpj);
    return saved;
  }

  const created = await asaasFetch("/v3/customers", {
    method: "POST",
    body: {
      name: fullName || "Cliente WhatsApp",
      cpfCnpj,
      mobilePhone: waId,
    },
  });

  if (!created?.id) throw new Error("Asaas customer id ausente.");
  await redisSet(key, created.id);
  return created.id;
}

// CARTÃO: assinatura recorrente
async function createCardSubscriptionAndGetPayLink(waId, planCode) {
  const plan = PLANS[planCode];
  if (!plan) throw new Error("Plano inválido.");

  const doc = await getDoc(waId);
  const fullName = await getFullName(waId);
  if (!doc) throw new Error("DOC_REQUIRED");

  const customerId = await getOrCreateAsaasCustomer(waId, fullName, doc);

  const sub = await asaasFetch("/v3/subscriptions", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "CREDIT_CARD",
      nextDueDate: nextDueDateISO(),
      value: plan.price,
      cycle: "MONTHLY",
      description: `Amigo das Vendas no Zap - ${plan.name}`,
    },
  });

  if (!sub?.id) throw new Error("Asaas subscription id ausente.");

  await redisSet(kSubscriptionToWa(sub.id), waId);
  await redisSet(kAsaasSubscription(waId), sub.id);

  const payments = await asaasFetch(`/v3/subscriptions/${sub.id}/payments`, { method: "GET" });
  const first = payments?.data?.[0] || null;

  return { subscriptionId: sub.id, invoiceUrl: first?.invoiceUrl || null };
}

// PIX: pagamento avulso (30 dias)
async function createPixPaymentAndGetPayLink(waId, planCode) {
  const plan = PLANS[planCode];
  if (!plan) throw new Error("Plano inválido.");

  const doc = await getDoc(waId);
  const fullName = await getFullName(waId);
  if (!doc) throw new Error("DOC_REQUIRED");

  const customerId = await getOrCreateAsaasCustomer(waId, fullName, doc);

  const pay = await asaasFetch("/v3/payments", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "PIX",
      value: plan.price,
      dueDate: nextDueDateISO(),
      description: `Amigo das Vendas no Zap - ${plan.name} (Pix)`,
    },
  });

  if (!pay?.id) throw new Error("Asaas payment id ausente.");

  await redisSet(kAsaasPayment(waId), pay.id);
  await redisSet(kPaymentToWa(pay.id), waId);

  return { paymentId: pay.id, invoiceUrl: pay.invoiceUrl || null };
}

async function cancelAsaasSubscription(subscriptionId) {
  if (!subscriptionId) return;
  await asaasFetch(`/v3/subscriptions/${subscriptionId}`, { method: "DELETE" });
}

// ===================== HEALTH =====================
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap webhook rodando");
});

// ===================== WEBHOOK VERIFY (Meta GET) =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== ASAAS WEBHOOK =====================
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    // token opcional
    if (ASAAS_WEBHOOK_TOKEN) {
      const token = String(req.headers["asaas-access-token"] || req.headers["x-asaas-token"] || "").trim();
      if (token && token !== ASAAS_WEBHOOK_TOKEN) {
        return;
      }
    }

    const evt = req.body || {};
    const evtHash = sha256(JSON.stringify(evt).slice(0, 5000));

    const seen = await redisExists(kAsaasEvt(evtHash));
    if (seen) return;

    await redisSetEx(kAsaasEvt(evtHash), "1", TTL_WEEK_SECONDS);

    const event = String(evt.event || "");
    const payment = evt.payment || null;

    if (!payment?.id) return;

    const paymentId = String(payment.id);
    const subscriptionId = payment.subscription ? String(payment.subscription) : "";

    // Descobre waId
    let waId = null;
    if (subscriptionId) {
      waId = await redisGet(kSubscriptionToWa(subscriptionId));
    }
    if (!waId) {
      waId = await redisGet(kPaymentToWa(paymentId));
    }
    if (!waId) return;

    // Ativa quando recebido/confirmado
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
      await setStatus(waId, "ACTIVE");

      // PIX: validade 30 dias
      if (!subscriptionId) {
        const until = nowMs() + PIX_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
        await setActiveUntil(waId, until);
      }

      await sendWhatsAppText(waId, "✅ Pagamento confirmado! Seu plano está ativo.\n\nAgora me mande o produto que você quer vender 🙂");
    }
  } catch (e) {
    safeLogError("Erro Asaas webhook:", e);
  }
});

// ===================== WHATSAPP WEBHOOK (POST) =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();
    if (metaPhoneId === "123456123") return;
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    // Status events: ignorar silenciosamente
    const statuses = value?.statuses;
    if (statuses?.length) return;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const waId = msg.from;
    const text = (msg.text?.body || "").trim();

    // Anti-loop / idempotência: evita processar a mesma mensagem 2x
    if (msg.id) {
      const seenKey = kSeenMsg(msg.id);
      const already = await redisExists(seenKey);
      if (already) return;
      await redisSetEx(seenKey, "1", 60 * 60 * 24); // 24h
    }

    // ===================== INICIALIZAÇÃO (nome) =====================
    let status = await getStatus(waId);
    let fullName = await getFullName(waId);

    // ===== MENU (pode chamar a qualquer momento) =====
    if (isMenuCommand(text)) {
      await pushPrevStatus(waId, status);
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    // ===== MENU FLOW (CORRIGIDO PARA NÃO PRENDER) =====
    if (status === "MENU") {
      if (text === "1") {
        await sendWhatsAppText(waId, await buildMySubscriptionText(waId));
        // sai do menu automaticamente
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        return;
      }
      if (text === "2") {
        await setStatus(waId, "MENU_WAIT_NAME");
        await sendWhatsAppText(waId, "Me envie seu *nome completo* 🙂\n\nSe quiser sair, digite *sair*.");
        return;
      }
      if (text === "3") {
        await setStatus(waId, "MENU_WAIT_DOC");
        await sendWhatsAppText(waId, "Me envie seu *CPF ou CNPJ* (somente números).\n\nSe quiser sair, digite *sair*.");
        return;
      }
      if (text === "4") {
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
        // sai do menu e entra no fluxo de plano
        await popPrevStatus(waId);
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }
      if (text === "5") {
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
        await popPrevStatus(waId);
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, "✅ Plano cancelado.\n\nSe quiser voltar, digite *MENU* e escolha um plano.");
        return;
      }
      if (text === "6") {
        await sendWhatsAppText(waId, `❓ Ajuda: ${helpUrl()}`);
        // sai do menu automaticamente
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        return;
      }

      // ✅ IMPORTANTE: se não for 1–6, sai do menu e continua o fluxo normal (trata como nova descrição)
      const prev = await popPrevStatus(waId);
      await setStatus(waId, prev);
      status = prev; // atualiza variável local para seguir fluxo normal
      // (não retorna — segue abaixo como descrição)
    }

    if (status === "MENU_WAIT_NAME") {
      if (isExitMenuText(text) || isMenuCommand(text)) {
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        status = prev; // volta ao fluxo normal
      } else {
        const name = String(text || "").trim();
        if (name.length < 5) {
          await sendWhatsAppText(waId, "Me envie seu *nome completo*, por favor 🙂\n\nSe quiser sair, digite *sair*.");
          return;
        }
        await setFullName(waId, name);
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        await sendWhatsAppText(waId, "✅ Nome atualizado.\n\nAgora é só me mandar o produto 🙂");
        return;
      }
    }

    if (status === "MENU_WAIT_DOC") {
      if (isExitMenuText(text) || isMenuCommand(text)) {
        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        status = prev; // volta ao fluxo normal
      } else {
        const doc = normalizeDocOnlyDigits(text);
        if (!isValidCPFOrCNPJ(doc)) {
          await sendWhatsAppText(waId, "CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números* 🙂\n\nSe quiser sair, digite *sair*.");
          return;
        }
        await setDoc(waId, doc);

        const customerId = await redisGet(kAsaasCustomer(waId));
        if (customerId) {
          try { await updateAsaasCustomerDoc(customerId, doc); } catch { /* silencioso */ }
        }

        const prev = await popPrevStatus(waId);
        await setStatus(waId, prev);
        await sendWhatsAppText(waId, "✅ CPF/CNPJ atualizado.\n\nAgora é só me mandar o produto 🙂");
        return;
      }
    }

    // recarrega nome se foi alterado no menu
    fullName = await getFullName(waId);

    // Fluxo inicial de nome
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
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      if (status === "WAIT_PLAN") {
        const chosen = text === "1" ? "P1" : text === "2" ? "P2" : text === "3" ? "P3" : null;
        if (!chosen) {
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }
        await setPlan(waId, chosen);
        await setStatus(waId, "WAIT_PAYMETHOD");
        await sendWhatsAppText(waId, payMethodText());
        return;
      }

      if (status === "WAIT_PAYMETHOD") {
        const method = text === "1" ? "CARD" : text === "2" ? "PIX" : "";
        if (!method) {
          await sendWhatsAppText(waId, payMethodText());
          return;
        }
        await setPayMethod(waId, method);

        const existingDoc = await getDoc(waId);
        if (!existingDoc) {
          await setStatus(waId, "WAIT_DOC");
          const fn = firstNameOf(await getFullName(waId));
          await sendWhatsAppText(waId, `Perfeito${fn ? `, ${fn}` : ""}! Agora vamos ativar seu plano 🙂`);
          await sendWhatsAppText(waId, "Me envie seu CPF ou CNPJ (somente números).\nÉ só para registrar o pagamento.");
          return;
        }

        await setStatus(waId, "PENDING");
        const planCode = (await getPlan(waId)) || "P1";

        try {
          const pay = method === "CARD"
            ? await createCardSubscriptionAndGetPayLink(waId, planCode)
            : await createPixPaymentAndGetPayLink(waId, planCode);

          if (pay?.invoiceUrl) {
            await sendWhatsAppText(
              waId,
              `✅ Aqui está o link para ativar seu plano:\n${pay.invoiceUrl}\n\nAssim que o pagamento for confirmado, eu libero automaticamente ✅`
            );
          } else {
            await sendWhatsAppText(waId, "Criei o pagamento, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico 🙂");
          }
        } catch (e) {
          safeLogError("Erro criando pagamento/assinatura:", e);
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
          await setStatus(waId, "WAIT_PLAN");
        }
        return;
      }

      if (status === "WAIT_DOC") {
        const doc = normalizeDocOnlyDigits(text);
        if (!isValidCPFOrCNPJ(doc)) {
          await sendWhatsAppText(waId, "CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números* 🙂");
          return;
        }

        await setDoc(waId, doc);
        await setStatus(waId, "PENDING");

        const planCode = (await getPlan(waId)) || "P1";
        const method = (await getPayMethod(waId)) || "PIX";

        try {
          const pay = method === "CARD"
            ? await createCardSubscriptionAndGetPayLink(waId, planCode)
            : await createPixPaymentAndGetPayLink(waId, planCode);

          if (pay?.invoiceUrl) {
            await sendWhatsAppText(
              waId,
              `✅ Aqui está o link para ativar seu plano:\n${pay.invoiceUrl}\n\nAssim que o pagamento for confirmado, eu libero automaticamente ✅`
            );
          } else {
            await sendWhatsAppText(waId, "Criei o pagamento, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico 🙂");
          }
        } catch (e) {
          safeLogError("Erro criando pagamento/assinatura:", e);
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
          await setStatus(waId, "WAIT_PLAN");
        }

        return;
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
      await sendWhatsAppText(waId, "Você atingiu o limite do trial/plano.\nDigite *MENU* para ver opções.");
      return;
    }

    try {
      console.log("USE_UPSTASH =", USE_UPSTASH);

      const gen = await openaiGenerateDescription({
        userText: draftToUserText(draft),
        instruction: "",
        fullName: await getFullName(waId),
      });

      await setLastDescription(waId, gen);
      await setRefineCount(waId, 0);

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

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
