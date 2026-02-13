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
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim();
const ASAAS_BASE_URL = (process.env.ASAAS_BASE_URL || "https://api.asaas.com").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(); // você já está usando gpt-4o-mini

// ===================== LIMITES / PLANOS =====================
const FREE_DESCRIPTIONS_LIMIT = 5; // trial por usos

const PLANS = {
  P1: {
    code: "P1",
    name: "De Vez em Quando",
    price: 24.9,
    monthlyLimit: 20,
  },
  P2: {
    code: "P2",
    name: "Sempre por Perto",
    price: 34.9,
    monthlyLimit: 60,
  },
  P3: {
    code: "P3",
    name: "Melhor Amigo",
    price: 49.9,
    monthlyLimit: 200,
  },
};

// Pix = 30 dias após ativação
const PIX_ACTIVE_DAYS = 30;

// Refinamento: até 3 (após isso vira “nova descrição”)
const MAX_REFINES_PER_DESCRIPTION = 3;

// TTLs
const TTL_WEEK_SECONDS = 60 * 60 * 24 * 7;
const TTL_MONTH_SECONDS = 60 * 60 * 24 * 31;

// ===================== HELPERS (SEGURANÇA / LOG) =====================
function safeLogError(label, err) {
  // Nunca logar doc/CPF/CNPJ. Nunca logar envs.
  const msg = String(err?.message || err || "").slice(0, 180);
  console.error(label, { message: msg });
}

function nowMs() {
  return Date.now();
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
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upstash ${resp.status}`);
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
  await redisFetch(`/del/${encodeURIComponent(key)}`, { method: "POST" });
}

async function redisIncr(key) {
  if (!USE_UPSTASH) return 0;
  const data = await redisFetch(`/incr/${encodeURIComponent(key)}`, { method: "POST" });
  return Number(data?.result || 0);
}

async function redisExists(key) {
  if (!USE_UPSTASH) return false;
  const data = await redisFetch(`/exists/${encodeURIComponent(key)}`);
  return Number(data?.result || 0) > 0;
}

// ===================== STORAGE KEYS =====================
function kStatus(waId) { return `status:${waId}`; }
function kFullName(waId) { return `fullName:${waId}`; }
function kDoc(waId) { return `doc:${waId}`; }
function kPlan(waId) { return `plan:${waId}`; }
function kPayMethod(waId) { return `paymethod:${waId}`; } // "CARD" | "PIX"
function kActiveUntil(waId) { return `active_until:${waId}`; } // ms timestamp (pix)
function kDraft(waId) { return `draft:${waId}`; }
function kRefineCount(waId) { return `refines:${waId}`; }
function kLastDescription(waId) { return `lastdesc:${waId}`; }

function kTrialUses(waId) { return `trial_uses:${waId}`; }

function kMonthlyUsage(waId, yyyymm) { return `usage:${waId}:${yyyymm}`; }
function kMonthlyUsageLimit(waId, yyyymm) { return `usage_limit:${waId}:${yyyymm}`; } // opcional

function currentYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

// Asaas mappings
function kAsaasCustomer(waId) { return `asaas_customer:${waId}`; }
function kAsaasSubscription(waId) { return `asaas_subscription:${waId}`; }
function kSubscriptionToWa(subId) { return `subscription_to_wa:${subId}`; }

function kAsaasPayment(waId) { return `asaas_payment:${waId}`; } // pix payment id atual
function kPaymentToWa(paymentId) { return `payment_to_wa:${paymentId}`; }

// ===================== STATUS =====================
// TRIAL / BLOCKED / WAIT_NAME / WAIT_DOC / WAIT_PLAN / WAIT_PAYMETHOD / PENDING / ACTIVE
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

// Draft/refine/lastdesc
async function getDraft(waId) {
  const raw = await redisGet(kDraft(waId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function setDraft(waId, draft) { await redisSet(kDraft(waId), JSON.stringify(draft)); }
async function clearDraft(waId) { await redisDel(kDraft(waId)); }

async function getRefineCount(waId) {
  const v = await redisGet(kRefineCount(waId));
  return v ? Number(v) : 0;
}
async function setRefineCount(waId, n) { await redisSet(kRefineCount(waId), String(n)); }
async function clearRefineCount(waId) { await redisDel(kRefineCount(waId)); }

async function getLastDescription(waId) { return (await redisGet(kLastDescription(waId))) || ""; }
async function setLastDescription(waId, txt) { await redisSet(kLastDescription(waId), txt); }
async function clearLastDescription(waId) { await redisDel(kLastDescription(waId)); }

// Trial
async function getTrialUses(waId) {
  const v = await redisGet(kTrialUses(waId));
  return v ? Number(v) : 0;
}
async function incrTrialUses(waId) {
  const key = kTrialUses(waId);
  // mantém no máximo por 6 meses (pra não crescer infinito)
  const next = await redisIncr(key);
  await redisSetEx(key, String(next), 60 * 60 * 24 * 180);
  return next;
}

// Monthly usage
async function getMonthlyUsage(waId) {
  const ym = currentYYYYMM();
  const v = await redisGet(kMonthlyUsage(waId, ym));
  return v ? Number(v) : 0;
}
async function incrMonthlyUsage(waId) {
  const ym = currentYYYYMM();
  const key = kMonthlyUsage(waId, ym);
  const next = await redisIncr(key);
  await redisSetEx(key, String(next), TTL_MONTH_SECONDS);
  return next;
}

// ===================== TEXT HELPERS =====================
function firstNameOf(fullName) {
  if (!fullName) return "";
  return String(fullName).trim().split(/\s+/)[0] || "";
}

function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeDocOnlyDigits(s) {
  return onlyDigits(s);
}

function isValidCPFOrCNPJ(digits) {
  const d = onlyDigits(digits);
  return d.length === 11 || d.length === 14;
}

function looksLikeGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"].includes(t);
}

function isPositiveFeedback(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t === "sim" ||
    t === "gostei" ||
    t.includes("gostei") ||
    t.includes("perfeito") ||
    t.includes("ótimo") ||
    t.includes("otimo") ||
    t.includes("am ei") ||
    t.includes("amei") ||
    t.includes("ficou bom") ||
    t.includes("ficou ótimo") ||
    t.includes("ficou otimo")
  );
}

function isNegativeFeedback(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t.startsWith("não gostei") ||
    t.startsWith("nao gostei") ||
    t.includes("não gostei") ||
    t.includes("nao gostei") ||
    t.includes("não curti") ||
    t.includes("nao curti") ||
    t.includes("muda") ||
    t.includes("troca") ||
    t.includes("melhora") ||
    t.includes("pouco emoji") ||
    t.includes("mais emoji") ||
    t.includes("título") ||
    t.includes("titulo")
  );
}

function extractFeedbackInstruction(text) {
  const t = String(text || "").trim();
  // Se a pessoa falou "não gostei", use o que vier depois como instrução
  // e se não tiver, use o texto todo como instrução.
  const lower = t.toLowerCase();
  const idx1 = lower.indexOf("não gostei");
  const idx2 = lower.indexOf("nao gostei");

  let instr = t;
  if (idx1 >= 0) instr = t.slice(idx1 + "não gostei".length).trim();
  else if (idx2 >= 0) instr = t.slice(idx2 + "nao gostei".length).trim();

  if (!instr) instr = t;

  // Normaliza instruções comuns
  return instr;
}

function askFeedbackText() {
  return (
    "💬 *Gostou da descrição?*\n\n" +
    "Se quiser melhorar, me diga *o que você não gostou* (ex.: “mais emoji”, “muda o título”, “deixa mais curto”, “mais emocional”).\n\n" +
    "Se estiver ok, pode responder *sim* ✅"
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
    "Como você prefere pagar?\n\n" +
    "1) Cartão\n" +
    "2) Pix\n\n" +
    "Responda *1* ou *2*."
  );
}

// ===================== DRAFT LOGIC =====================
function emptyDraft() {
  return {
    product: "",
    price: "",
    flavors: "",
    delivery: "",
    extras: "",
  };
}

function updateDraftFromUserMessage(draft, text) {
  const t = String(text || "").trim();

  // Heurísticas simples:
  // - preço: captura R$ e números
  // - entrega: palavras-chave
  // - sabores: "sabores", "opções", "tem de", "tem sabor"
  // - extras: "gourmet", "caseiro", etc.
  const lower = t.toLowerCase();

  // preço (bem simples)
  const priceMatch = t.match(/(r\$\s*\d+[.,]?\d*)|(\d+[.,]?\d*\s*reais)/i);
  if (priceMatch && !draft.price) draft.price = priceMatch[0].trim();

  // entrega
  if (!draft.delivery && (lower.includes("entrego") || lower.includes("entrega") || lower.includes("retira") || lower.includes("retirada") || lower.includes("buscar"))) {
    draft.delivery = t;
  }

  // sabores/opções
  if (!draft.flavors && (lower.includes("sabor") || lower.includes("sabores") || lower.includes("opção") || lower.includes("opcoes") || lower.includes("opções"))) {
    draft.flavors = t;
  }

  // produto
  // Se ainda não tem produto, usa a mensagem como produto (se não for só saudação)
  if (!draft.product && !looksLikeGreeting(t)) {
    // Remove números soltos de escolha (1/2/3) e doc
    if (!["1", "2", "3"].includes(t) && onlyDigits(t).length < 11) {
      draft.product = t;
    }
  } else if (draft.product && !looksLikeGreeting(t)) {
    // Se já tem produto, use texto como extra
    if (t.length >= 3 && onlyDigits(t).length < 11) {
      // Evita duplicar
      if (!draft.extras) draft.extras = t;
      else if (!draft.extras.includes(t)) draft.extras = `${draft.extras} • ${t}`;
    }
  }

  return draft;
}

// Decide se “vira novo rascunho” após 3 refinamentos
function shouldResetAfterRefines(refinesCount) {
  return refinesCount >= MAX_REFINES_PER_DESCRIPTION;
}

// ===================== FORMATAÇÃO WHATSAPP (SANITIZER) =====================
function sanitizeWhatsAppFormatting(text) {
  let out = String(text || "");

  // 1) Troca **negrito** (markdown) por *negrito* (WhatsApp)
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // 2) Remove casos de "* *" ou "** *" etc
  out = out.replace(/\*\s+\*/g, ""); // remove “* *”
  out = out.replace(/\*{3,}/g, "*"); // *** -> *

  // 3) Evitar label “Preço” em negrito com asterisco sobrando
  // remove asteriscos ao redor de "Preço" quando for label
  out = out.replace(/\*Preço\*\s*:/gi, "Preço:");
  out = out.replace(/\*Preco\*\s*:/gi, "Preco:");
  out = out.replace(/\*Preço\*/gi, "Preço");
  out = out.replace(/\*Preco\*/gi, "Preco");

  // 4) Garante título em negrito na primeira linha (se não estiver)
  const lines = out.split("\n");
  if (lines.length > 0) {
    const first = lines[0].trim();
    if (first && !(first.startsWith("*") && first.endsWith("*"))) {
      lines[0] = `*${first}*`;
      out = lines.join("\n");
    }
  }

  // 5) Remove excesso de espaços em branco
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{4,}/g, "\n\n\n");

  return out.trim();
}

// ===================== IA (PROMPT) =====================
function buildUserBrief(draft) {
  const parts = [];
  if (draft.product) parts.push(`Produto: ${draft.product}`);
  if (draft.price) parts.push(`Preço informado: ${draft.price}`);
  if (draft.flavors) parts.push(`Sabores/opções informados: ${draft.flavors}`);
  if (draft.delivery) parts.push(`Entrega/retirada informada: ${draft.delivery}`);
  if (draft.extras) parts.push(`Detalhes extras: ${draft.extras}`);
  return parts.join("\n");
}

function buildMissingHints(draft) {
  const hints = [];
  if (!draft.price) hints.push("Não foi informado o preço: inclua algo neutro como “Consulte valores”.");
  if (!draft.flavors) hints.push("Não foram informados sabores/opções: inclua “Consulte sabores disponíveis”.");
  if (!draft.delivery) hints.push("Não foi informado entrega/retirada: inclua “Entrega/retirada a combinar”.");
  return hints.join("\n");
}

function buildPrompt({ draft, feedbackInstruction, previousDescription }) {
  // Regras:
  // - 1 único texto pronto para encaminhar
  // - Título chamativo em negrito (WhatsApp = *texto*)
  // - destacar poucas infos importantes em negrito (sem exagero)
  // - emojis moderados
  // - não inventar info; quando faltar, usar frases neutras
  // - se feedbackInstruction existir, reescreva considerando o pedido (ex.: mais emoji, mudar título etc.)
  return `
Você é um especialista em copywriting para vendas no WhatsApp.

Sua tarefa é gerar UMA ÚNICA descrição de venda pronta para a cliente COPIAR e ENCAMINHAR no WhatsApp.

Regras de formatação:
- Use negrito no padrão do WhatsApp: *texto*
- O TÍTULO (primeira linha) deve ser em negrito.
- Destaque em negrito APENAS 2 a 4 trechos importantes no total (inclui o título). Não deixe tudo em negrito.
- Emojis: moderados (nem zero, nem exagerado).
- Estrutura clara, com quebras de linha.
- Não use ** (markdown), use *.
- Não coloque o label “Preço” em negrito. Se mencionar preço, destaque o VALOR, não a palavra “Preço”.

========================
DADOS DO PRODUTO (pode estar incompleto)
${buildUserBrief(draft) || "(o usuário escreveu pouco; use apenas o que foi dito e complete com frases neutras sem inventar)"}
========================

${previousDescription ? `DESCRIÇÃO ANTERIOR (para refinamento):
${previousDescription}
========================
` : ""}

${feedbackInstruction ? `AJUSTE SOLICITADO PELO USUÁRIO:
${feedbackInstruction}
========================
` : ""}

Se o texto do usuário estiver incompleto, complete com frases neutras SEM INVENTAR dados.
Use estas sugestões neutras (se faltar algo):
${buildMissingHints(draft) || "(nenhuma)"}

Saída final:
- Deve ter título curto e chamativo (1 linha, em negrito)
- Depois 3 a 6 linhas bem organizadas
- Se fizer sentido, inclua uma linha de chamada para ação (ex.: “Me chama no WhatsApp para pedir”)
- Não inclua explicações sobre regras, apenas o texto final.
`.trim();
}

async function generateSalesDescription({ draft, feedbackInstruction, previousDescription }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

  const prompt = buildPrompt({ draft, feedbackInstruction, previousDescription });

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      // não usar temperature (você recebeu erro com alguns modelos)
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `OpenAI ${resp.status}`;
    throw new Error(msg);
  }

  // responses API: pega texto
  const out =
    data?.output?.[0]?.content?.[0]?.text ||
    data?.output_text ||
    "";

  if (!out) throw new Error("OpenAI retornou vazio.");
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
    text: { body: text },
  };

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
    // não vazar detalhes
    safeLogError("Erro ao enviar WhatsApp:", new Error(data?.error?.message || `HTTP ${resp.status}`));
  } else {
    console.log("Mensagem enviada OK:", data?.messages?.[0]?.id || "(sem id)");
  }
}

// ===================== ASAAS =====================
async function asaasFetch(path, { method = "GET", body = null } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY não configurada.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      access_token: ASAAS_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // não retornar payload (pode conter info)
    throw new Error(`Asaas ${resp.status}`);
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
  await asaasFetch(`/v3/customers/${customerId}`, {
    method: "PUT",
    body: { cpfCnpj },
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

  // billingType CREDIT_CARD para ser recorrente no cartão
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

  // pega o 1º pagamento para obter invoiceUrl
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
      dueDate: nextDueDateISO(),
      value: plan.price,
      description: `Amigo das Vendas no Zap - ${plan.name}`,
    },
  });

  if (!pay?.id) throw new Error("Asaas payment id ausente.");

  await redisSet(kAsaasPayment(waId), pay.id);
  await redisSet(kPaymentToWa(pay.id), waId);

  return { paymentId: pay.id, invoiceUrl: pay?.invoiceUrl || null };
}

// ===================== COTA / BLOQUEIO =====================
async function canConsumeDescription(waId) {
  const status = await getStatus(waId);

  if (status === "ACTIVE") {
    const payMethod = await getPayMethod(waId);

    // PIX: precisa estar dentro do período
    if (payMethod === "PIX") {
      const until = await getActiveUntil(waId);
      if (!until || nowMs() > until) {
        await setStatus(waId, "BLOCKED");
        return { ok: false, reason: "pix_expired" };
      }
    }

    const planCode = await getPlan(waId);
    const plan = PLANS[planCode];
    if (!plan) return { ok: false, reason: "no_plan" };

    const used = await getMonthlyUsage(waId);
    const limit = plan.monthlyLimit;
    if (used >= limit) return { ok: false, reason: "plan_limit", used, limit };
    const next = await incrMonthlyUsage(waId);
    return { ok: true, used: next, limit };
  }

  // TRIAL
  const used = await getTrialUses(waId);
  if (used >= FREE_DESCRIPTIONS_LIMIT) return { ok: false, reason: "trial_limit", used, limit: FREE_DESCRIPTIONS_LIMIT };
  const next = await incrTrialUses(waId);
  return { ok: true, used: next, limit: FREE_DESCRIPTIONS_LIMIT };
}

function limitMessage(status, planCode, used, limit) {
  if (status === "ACTIVE") {
    const plan = PLANS[planCode];
    return (
      `✅ Você atingiu o limite do mês do plano *${plan?.name || ""}*.\n` +
      `Uso: ${used}/${limit}\n\n` +
      `Se quiser, posso te mostrar os planos novamente.`
    );
  }
  return `✅ Você atingiu o limite do trial.\nUso: ${used}/${limit}\n\n${plansMenuText()}`;
}

// ===================== ROUTES =====================
// Health
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap rodando");
});

// Webhook verify (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== WHATSAPP WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();

    // Ignora mock do painel (alguns testes usam phone_number_id fictício)
    if (metaPhoneId === "123456123") return;

    // Valida se evento é do seu número
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    // Status events
    const statuses = value?.statuses;
    if (statuses?.length) {
      // se quiser, só log mínimo
      return;
    }

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const waId = msg.from; // cliente

    // ===================== INICIALIZAÇÃO (nome) =====================
    let status = await getStatus(waId);
    let fullName = await getFullName(waId);

    // Se nunca teve nome, inicia fluxo de nome (mas sem travar quem já está usando)
    if (!fullName && status === "TRIAL" && looksLikeGreeting(msg.text?.body || "")) {
      await setStatus(waId, "WAIT_NAME");
      await sendWhatsAppText(waId, "Olá! 😊 Antes de começar, me diga seu *nome completo*.");
      return;
    }

    // Se está esperando nome
    if (status === "WAIT_NAME") {
      const name = String(msg.text?.body || "").trim();
      if (name.length < 5) {
        await sendWhatsAppText(waId, "Me envie seu *nome completo*, por favor 🙂");
        return;
      }
      await setFullName(waId, name);
      await setStatus(waId, "TRIAL");
      await sendWhatsAppText(waId, `Perfeito, ${firstNameOf(name)}! ✅\nAgora me diga o que você quer vender (ex.: “brigadeiro gourmet R$ 10”).`);
      return;
    }

    // texto do usuário (não logar)
    const text = (msg.text?.body || "").trim();

    // ===================== FLUXO DE PAGAMENTO / ATIVAÇÃO =====================
    // Se está bloqueado ou pending, a conversa vira: planos -> pagamento -> ativação
    status = await getStatus(waId);

    const needsPaymentFlow = status === "BLOCKED" || status === "PENDING" || status === "WAIT_DOC" || status === "WAIT_PLAN" || status === "WAIT_PAYMETHOD";

    if (needsPaymentFlow) {
      // 1) Se bloqueado: mostra planos
      if (status === "BLOCKED") {
        await setStatus(waId, "WAIT_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // 2) Escolher plano
      if (status === "WAIT_PLAN") {
        const choice = text;
        const chosen = choice === "1" ? "P1" : choice === "2" ? "P2" : choice === "3" ? "P3" : null;

        if (!chosen) {
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }

        await setPlan(waId, chosen);
        await setStatus(waId, "WAIT_PAYMETHOD");
        await sendWhatsAppText(waId, payMethodText());
        return;
      }

      // 3) Escolher forma de pagamento (cartão / pix)
      if (status === "WAIT_PAYMETHOD") {
        const choice = text;
        const method = choice === "1" ? "CARD" : choice === "2" ? "PIX" : "";
        if (!method) {
          await sendWhatsAppText(waId, payMethodText());
          return;
        }
        await setPayMethod(waId, method);

        // precisa de doc?
        const existingDoc = await getDoc(waId);
        if (!existingDoc) {
          await setStatus(waId, "WAIT_DOC");
          const fn = firstNameOf(await getFullName(waId));
          await sendWhatsAppText(waId, `Perfeito${fn ? `, ${fn}` : ""}! Agora vamos ativar seu plano 🙂`);
          await sendWhatsAppText(waId, "Me envie seu CPF ou CNPJ (somente números).\nÉ só para registrar o pagamento.");
          return;
        }

        // já tem doc -> cria cobrança
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
            await sendWhatsAppText(waId, "Criei o pagamento, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico ✅");
          }
        } catch (e) {
          safeLogError("Erro criando cobrança Asaas:", e);
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
        }
        return;
      }

      // 4) Receber DOC (CPF/CNPJ)
      if (status === "WAIT_DOC") {
        const doc = normalizeDocOnlyDigits(text);
        if (!isValidCPFOrCNPJ(doc)) {
          await sendWhatsAppText(waId, "Não consegui validar. Envie CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números*.");
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
            await sendWhatsAppText(waId, "Criei o pagamento, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico ✅");
          }
        } catch (e) {
          safeLogError("Erro criando cobrança Asaas:", e);
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
        }
        return;
      }

      // Pending: se mandar algo, reorienta
      if (status === "PENDING") {
        await sendWhatsAppText(waId, "Assim que o pagamento for confirmado, eu libero automaticamente ✅");
        return;
      }
    }

    // ===================== ATIVO/TRIAL: DESCRIÇÃO =====================
    // Se status for TRIAL e passou 5, bloqueia e mostra planos
    status = await getStatus(waId);

    if (status !== "ACTIVE") {
      const usedTrial = await getTrialUses(waId);
      if (usedTrial >= FREE_DESCRIPTIONS_LIMIT) {
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, `✅ Você usou as ${FREE_DESCRIPTIONS_LIMIT} descrições grátis.\n\n${plansMenuText()}`);
        return;
      }
    }

    // Draft/refine
    const draft = await getDraft(waId);
    const refines = await getRefineCount(waId);
    const isNewDescription = !draft;

    const feedbackPositive = isPositiveFeedback(text);
    const feedbackNegative = isNegativeFeedback(text);

    // Se gostou, limpa rascunho
    if (feedbackPositive) {
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);

      await sendWhatsAppText(waId, "Boa! ✅ Se quiser fazer outro produto, me mande agora (ex.: “brigadeiro gourmet R$10”).");
      return;
    }

    // Se refinou demais, força reset de “nova descrição”
    const willResetRefines = !isNewDescription && shouldResetAfterRefines(refines);

    if (willResetRefines) {
      // Zera, mas mantém o texto atual como “novo começo”
      await clearDraft(waId);
      await setRefineCount(waId, 0);
    }

    // Verifica consumo: só consome quando for “nova descrição”
    // Refinamentos (até 3) não consomem.
    if (isNewDescription || willResetRefines) {
      const check = await canConsumeDescription(waId);
      if (!check.ok) {
        if (check.reason === "trial_limit") {
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, limitMessage("TRIAL", "", check.used || FREE_DESCRIPTIONS_LIMIT, check.limit || FREE_DESCRIPTIONS_LIMIT));
          return;
        }

        if (check.reason === "pix_expired") {
          await sendWhatsAppText(waId, "✅ Seu plano expirou.\n\n" + plansMenuText());
          return;
        }

        // plano atingiu limite
        const planCode = await getPlan(waId);
        await sendWhatsAppText(waId, limitMessage("ACTIVE", planCode, check.used, check.limit));
        return;
      }
    }

    // Atualiza draft com mensagem do usuário
    let nextDraft = draft || emptyDraft();
    nextDraft = updateDraftFromUserMessage(nextDraft, text);

    // Se ainda não tem produto
    if (!nextDraft.product || nextDraft.product.length < 2) {
      await setDraft(waId, nextDraft);
      await sendWhatsAppText(waId, "Me diga qual produto você está vendendo 🙂 (ex.: “bolo de chocolate”, “brigadeiro gourmet”).");
      return;
    }

    // ===================== REFINAMENTO =====================
    const previousDescription = await getLastDescription(waId);

    // Se “não gostei…” ou msg curtinha (detalhe faltante), vira instrução de ajuste
    const feedbackInstruction =
      feedbackNegative || (!isNewDescription && text.length <= 200)
        ? extractFeedbackInstruction(text)
        : null;

    // incrementa refine count se não for nova descrição
    if (!isNewDescription) {
      const newRef = willResetRefines ? 1 : refines + 1;
      await setRefineCount(waId, newRef);
    } else {
      await setRefineCount(waId, 0);
    }

    // salva draft
    await setDraft(waId, nextDraft);

    // ===================== GERAR COM IA =====================
    let description;
    try {
      description = await generateSalesDescription({
        draft: nextDraft,
        feedbackInstruction,
        previousDescription: isNewDescription ? null : previousDescription,
      });
    } catch (e) {
      safeLogError("Erro OpenAI (geração):", e);
      await sendWhatsAppText(waId, "Tive um problema para gerar a descrição agora. Tente novamente em instantes 🙂");
      return;
    }

    // Sanitiza
    description = sanitizeWhatsAppFormatting(description);

    await setLastDescription(waId, description);

    // 1) Mensagem limpa pra encaminhar
    await sendWhatsAppText(waId, description);

    // 2) Feedback separado (bem diagramado)
    await sendWhatsAppText(waId, askFeedbackText());

    // Se trial acabou exatamente agora (após consumo), avisa que a próxima exigirá plano
    // (sem aumentar custo demais: só manda quando chega no limite)
    const st = await getStatus(waId);
    if (st !== "ACTIVE") {
      const used = await getTrialUses(waId);
      if (used >= FREE_DESCRIPTIONS_LIMIT) {
        await sendWhatsAppText(waId, `✅ Você usou as ${FREE_DESCRIPTIONS_LIMIT} descrições grátis.\nNa próxima, será necessário escolher um plano.`);
      }
    }
  } catch (err) {
    safeLogError("Erro geral no webhook:", err);
  }
});

// ===================== WEBHOOK ASAAS =====================
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (!USE_UPSTASH) return;

    if (ASAAS_WEBHOOK_TOKEN) {
      const token = req.get("asaas-access-token");
      if (token !== ASAAS_WEBHOOK_TOKEN) return;
    }

    // idempotência por hash (não logar body)
    const hash = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
    const evtKey = `asaas_evt:${hash}`;
    if (await redisExists(evtKey)) return;
    await redisSetEx(evtKey, "1", TTL_WEEK_SECONDS);

    const eventType = req.body?.event;

    // =====================
    // Confirmação de pagamento
    // - Cartão recorrente: vem com payment.subscription
    // - Pix avulso: vem com payment.id (sem subscription)
    // =====================
    if (eventType === "PAYMENT_RECEIVED" || eventType === "PAYMENT_CONFIRMED") {
      const payment = req.body?.payment || null;
      if (!payment?.id) return;

      const subscriptionId = payment?.subscription || "";

      // 1) Se for assinatura (cartão)
      if (subscriptionId) {
        const waId = await redisGet(kSubscriptionToWa(subscriptionId));
        if (!waId) return;

        await setStatus(waId, "ACTIVE");
        await setPayMethod(waId, "CARD");
        await clearActiveUntil(waId);

        const planCode = await getPlan(waId);
        const plan = planCode ? PLANS[planCode] : null;
        const fn = firstNameOf(await getFullName(waId));

        await sendWhatsAppText(
          waId,
          `✅ Pagamento confirmado! Seu plano foi ativado${fn ? `, ${fn}` : ""}.\n` +
            (plan ? `Plano: *${plan.name}* • ${plan.monthlyLimit} descrições/mês\n\n` : "\n") +
            "Me mande o produto que você quer vender 🙂"
        );
        return;
      }

      // 2) Se for Pix (pagamento avulso)
      const waId = await redisGet(kPaymentToWa(payment.id));
      if (!waId) return;

      await setStatus(waId, "ACTIVE");
      await setPayMethod(waId, "PIX");

      const until = nowMs() + PIX_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
      await setActiveUntil(waId, until);

      const planCode = await getPlan(waId);
      const plan = planCode ? PLANS[planCode] : null;
      const fn = firstNameOf(await getFullName(waId));

      await sendWhatsAppText(
        waId,
        `✅ Pagamento confirmado! Seu plano foi ativado${fn ? `, ${fn}` : ""}.\n` +
          (plan ? `Plano: *${plan.name}* • ${plan.monthlyLimit} descrições/mês\n\n` : "\n") +
          "Me mande o produto que você quer vender 🙂"
      );
      return;
    }

    // Cancelamento de assinatura (cartão)
    if (eventType === "SUBSCRIPTION_INACTIVATED") {
      const subId = req.body?.subscription?.id;
      if (!subId) return;

      const waId = await redisGet(kSubscriptionToWa(subId));
      if (!waId) return;

      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, "⚠️ Sua assinatura foi inativada.\n\n" + plansMenuText());
    }
  } catch (err) {
    safeLogError("Erro webhook Asaas:", err);
  }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log("USE_UPSTASH =", USE_UPSTASH);
});
