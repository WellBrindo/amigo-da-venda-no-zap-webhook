import express from "express";
import crypto from "crypto";

// Node 18+ já tem fetch global.
// Este server.js é ESM (import ...). Garanta "type":"module" no package.json.

const app = express();
app.use(express.json());

// ===================== CONFIG =====================
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// Upstash (Redis REST)
const USE_UPSTASH =
  String(process.env.USE_UPSTASH || "true").trim().toLowerCase() === "true";
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

// Asaas
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_ENV = (process.env.ASAAS_ENV || "sandbox").trim(); // "sandbox" | "production"
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim(); // opcional (recomendado)
const ASAAS_BASE_URL =
  ASAAS_ENV === "production" ? "https://api.asaas.com" : "https://sandbox.asaas.com";

// Produto
const HELP_URL = "https://amigodasvendas.com.br";

// Trial e limites
const FREE_DESCRIPTIONS_LIMIT = 5;        // trial por uso
const MAX_REFINES_PER_DESCRIPTION = 2;    // até 2 refinamentos por descrição; o 3º conta como nova descrição

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

/**
 * Não “corrigir” estados intencionais (menu/compra/pagamento pendente etc.)
 */
async function normalizeOnboardingStatus(waId, status) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);

  const doNotNormalize = new Set([
    "MENU",
    "MENU_CANCEL_CONFIRM",
    "MENU_UPDATE_NAME",
    "MENU_UPDATE_DOC",
    "WAIT_PLAN",
    "WAIT_PAYMETHOD",
    "PAYMENT_PENDING",
    "BLOCKED",
    "ACTIVE",
  ]);
  if (doNotNormalize.has(status)) return status;

  if (name && doc && (status === "WAIT_NAME" || status === "WAIT_NAME_VALUE" || status === "WAIT_DOC")) {
    return "ACTIVE";
  }
  if (name && !doc && (status === "WAIT_NAME" || status === "WAIT_NAME_VALUE")) return "WAIT_DOC";

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
  if (!subId) {
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
  return t.trim();
}

function askFeedbackText() {
  return (
    "💬 *Quer melhorar algo?*\n\n" +
    "Me diga *o que você quer que eu melhore* (ex.: mais emoji, muda o título, mais emocional, mais curto, mais técnico).\n\n" +
    "Se estiver tudo certo com a descrição, me envie um *OK* ✅"
  );
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

async function openaiGenerateDescription({ baseUserText, previousDescription, instruction, fullName }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente.");

  const system = `
Você é o "Amigo das Vendas": cria descrições curtas, chamativas e vendáveis para WhatsApp.

OBJETIVO:
- Transformar a mensagem do cliente em uma descrição pronta para copiar/encaminhar.

REGRAS IMPORTANTES (WhatsApp):
- Negrito é com *asterisco único*: *TÍTULO*
- O título (1ª linha) SEMPRE em negrito.
- Use emojis moderados (não exagerar).
- Destaque APENAS 2 a 4 trechos importantes em negrito. Não deixe tudo em negrito.
- Não invente informações. Se faltar dado, use texto neutro: "Consulte valores", "Consulte sabores", "Consulte disponibilidade".

DIFERENÇA ENTRE PRODUTO x SERVIÇO:
- Se for PRODUTO:
  - Só mencione entrega/retirada se o cliente informou.
  - Se não informou, OU omita isso, OU use "Entrega/retirada a combinar".
- Se for SERVIÇO:
  - NÃO use "entrega/retirada".
  - Se parecer serviço com hora marcada: use "Agende um horário".
  - Se parecer serviço orçamentado: use "Solicite um orçamento".

ESTRUTURA:
1) *TÍTULO*
2) 2–4 linhas com benefícios e apelo
3) Linha de preço/valor (se houver) ou "Consulte valores"
4) Linha final: produto (entrega/retirada se fizer sentido) OU serviço ("Agende um horário" / "Solicite um orçamento")
5) CTA curto.
`.trim();

  const user = `
Nome do cliente (se houver): ${fullName || "—"}

Informações do cliente (base):
${baseUserText || "—"}

Descrição anterior (se houver):
${previousDescription || "—"}

O que o cliente quer melhorar (se houver):
${instruction || "—"}

Crie a DESCRIÇÃO FINAL agora. Se houver "Descrição anterior", faça uma NOVA VERSÃO dela aplicando a melhoria pedida, sem trocar de assunto.
`.trim();

  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `OpenAI ${resp.status}: erro ao gerar.`);
  }

  const outText = data.output_text || data?.output?.[0]?.content?.[0]?.text || "";
  return sanitizeWhatsAppMarkdown(outText);
}

// ===================== ASAAS =====================
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

  // Asaas geralmente retorna 4xx em erro, mas vamos ser defensivos:
  if (!resp.ok) {
    throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
  }
  if (data && typeof data === "object" && Array.isArray(data.errors) && data.errors.length) {
    // Não expor dados sensíveis. Só uma mensagem genérica.
    throw new Error(`Asaas: retornou errors no body.`);
  }
  return data;
}

async function findCustomerByCpfCnpj(doc) {
  // doc já vem limpo (apenas números)
  const q = encodeURIComponent(doc);
  const data = await asaasFetch(`/v3/customers?cpfCnpj=${q}`, "GET");
  // Estrutura típica: { data: [...], totalCount: n }
  const list = Array.isArray(data?.data) ? data.data : [];
  if (list.length > 0 && list[0]?.id) return String(list[0].id);
  return "";
}

async function findOrCreateAsaasCustomer({ waId, name, doc }) {
  const cached = await redisGet(kAsaasCustomerId(waId));
  if (cached) return cached;

  // 1) tenta criar
  let created = null;
  try {
    created = await asaasFetch("/v3/customers", "POST", {
      name,
      cpfCnpj: doc,
      externalReference: waId, // ajuda em troubleshooting sem expor doc
    });
  } catch (e) {
    // Se falhar, tentamos buscar
    safeLogError("Asaas create customer falhou (tentando buscar):", e);
  }

  let customerId = created?.id ? String(created.id) : "";

  // 2) fallback: buscar por CPF/CNPJ
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
  const link = sub?.invoiceUrl || sub?.paymentLink || sub?.url || "";
  return { subscriptionId: subId, link };
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
  await redisSet(kPendingPlan(waId), planCode || "");
  await redisSet(kPendingMethod(waId), method || "");
  if (paymentId) await redisSet(kPendingPaymentId(waId), paymentId);
  if (subId) await redisSet(kPendingSubId(waId), subId);
  await redisSet(kPendingCreatedAt(waId), String(Date.now()));
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
  return "*Forma de pagamento* 💳\n\n1) Cartão\n2) Pix\n\nResponda com 1 ou 2.";
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
  await redisSet(key, "1");
  return false;
}

// ===================== HELPERS =====================
function isMenuCommand(text) {
  return String(text || "").trim().toLowerCase() === "menu";
}
function cleanDoc(text) {
  return String(text || "").replace(/\D/g, "");
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

    const text = String(msg.text?.body || "").trim();
    if (!text) return;

    let status = await getStatus(waId);
    status = await normalizeOnboardingStatus(waId, status);

    if (isMenuCommand(text)) {
      await setMenuReturn(waId, status);
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    if (status === "PAYMENT_PENDING") {
      await sendWhatsAppText(
        waId,
        "⏳ Estou aguardando a confirmação do seu pagamento pelo Asaas.\n\n" +
        "Assim que confirmar, eu te aviso aqui e seu plano será ativado ✅\n\n" +
        "Se quiser, digite *MENU* para ver seu status."
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
        await sendWhatsAppText(waId, "CPF/CNPJ inválido. Me envie somente números (11 ou 14 dígitos).");
        return;
      }
      await setDoc(waId, doc);
      await sendWhatsAppText(waId, "CPF/CNPJ atualizado ✅");
      const back = (await popMenuReturn(waId)) || "ACTIVE";
      await setStatus(waId, back);
      return;
    }

    if (status === "WAIT_NAME") {
      await sendWhatsAppText(waId, "Oi! 🙂\nQual é o seu *nome completo*?");
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

      await sendWhatsAppText(waId, `Perfeito, ${name.split(" ")[0]}! Agora vamos ativar seu plano 🙂`);
      await sendWhatsAppText(
        waId,
        "Me envie seu *CPF ou CNPJ* (somente números).\nÉ só para registrar o pagamento."
      );

      await setStatus(waId, "WAIT_DOC");
      return;
    }

    if (status === "WAIT_DOC") {
      const doc = cleanDoc(text);
      if (doc.length !== 11 && doc.length !== 14) {
        await sendWhatsAppText(waId, "CPF/CNPJ inválido. Me envie somente números (11 ou 14 dígitos).");
        return;
      }
      await setDoc(waId, doc);

      await setStatus(waId, "WAIT_PLAN");
      await sendWhatsAppText(waId, plansMenuText());
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

          if (r.link) {
            await sendWhatsAppText(
              waId,
              `🧾 *Pagamento gerado!*\n\nFinalize por aqui:\n${r.link}\n\n` +
              "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
            );
          } else {
            await sendWhatsAppText(
              waId,
              "🧾 *Pagamento gerado!*\n\n" +
              "⏳ Assim que o Asaas confirmar, eu ativo seu plano automaticamente ✅"
            );
          }
        } catch (e) {
          safeLogError("Erro criando assinatura Asaas:", e);
          await sendWhatsAppText(
            waId,
            "Não consegui gerar o pagamento agora.\n\n" +
            "Se quiser, digite *MENU* e tente novamente em *Mudar plano*.\n" +
            "Ou revise seu CPF/CNPJ em *Alterar CPF/CNPJ*."
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
            "Não consegui gerar o Pix agora.\n\n" +
            "Se quiser, digite *MENU* e tente novamente em *Mudar plano*.\n" +
            "Ou revise seu CPF/CNPJ em *Alterar CPF/CNPJ*."
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
        await sendWhatsAppText(waId, "Você atingiu o limite do trial.\nDigite *MENU* para ver opções.");
        return;
      }
    }

    if (planCode) {
      const can = await canUseByPlanNow(waId);
      if (!can) {
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, "Seu plano expirou ou atingiu o limite.\nDigite *MENU* para ver opções.");
        return;
      }
    }

    // ===================== DESCRIÇÃO / REFINO =====================
    const prevDraft = await getDraft(waId);
    const lastDesc = await getLastDescription(waId);
    const refineCount = await getRefineCount(waId);
    const lastInput = await getLastInput(waId);

    if (lastDesc && (isOkToFinish(text) || isPositiveFeedbackLegacy(text))) {
      await sendWhatsAppText(waId, "Boa! ✅\nSe quiser fazer outra descrição, é só me mandar o próximo produto/serviço 🙂");
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

        let nextRef = refineCount + 1;
        if (refineCount >= MAX_REFINES_PER_DESCRIPTION) {
          const okConsume = await consumeOneDescriptionOrBlock(waId);
          if (!okConsume) {
            await setStatus(waId, "BLOCKED");
            await sendWhatsAppText(waId, "Você atingiu o limite do seu plano/trial.\nDigite *MENU* para ver opções.");
            return;
          }
          nextRef = 1;
        }
        await setRefineCount(waId, nextRef);

        try {
          const gen = await openaiGenerateDescription({
            baseUserText: baseText,
            previousDescription: lastDesc,
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
    }

    const draft = mergeDraftFromMessage(await getDraft(waId), text);
    await setDraft(waId, draft);

    const okConsume = await consumeOneDescriptionOrBlock(waId);
    if (!okConsume) {
      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, "Você atingiu o limite do trial/plano.\nDigite *MENU* para ver opções.");
      return;
    }

    try {
      const baseText = draftToUserText(draft);
      const gen = await openaiGenerateDescription({
        baseUserText: baseText,
        previousDescription: "",
        instruction: "",
        fullName: await getFullName(waId),
      });

      await setLastInput(waId, baseText);
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
