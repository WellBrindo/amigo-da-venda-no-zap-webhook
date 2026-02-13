import express from "express";
import crypto from "crypto";

// Node 18+ já tem fetch global. Em versões antigas, instale node-fetch.

const app = express();
app.use(express.json());

// ===================== CONFIG =====================
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// Upstash (Redis)
const USE_UPSTASH = String(process.env.USE_UPSTASH || "true").trim().toLowerCase() === "true";
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

// Asaas
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_ENV = (process.env.ASAAS_ENV || "sandbox").trim(); // "sandbox" ou "production"
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim(); // opcional (recomendado)
const ASAAS_BASE_URL =
  ASAAS_ENV === "production"
    ? "https://api.asaas.com"
    : "https://sandbox.asaas.com";

// Produto
const HELP_URL = "https://amigodasvendas.com.br";

// Trial e limites
const FREE_DESCRIPTIONS_LIMIT = 5; // trial por uso
const MAX_REFINES_PER_DESCRIPTION = 2; // após 2 refinamentos, o próximo conta como nova descrição

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
    description:
      "Para quem já entendeu que vender melhor muda o jogo. O Amigo acompanha seu ritmo.",
    button: "Quero o Amigo comigo",
  },
  3: {
    code: "MELHOR_AMIGO",
    name: "Melhor Amigo",
    price: 49.9,
    quotaMonthly: 200,
    description:
      "Para quem não quer só ajuda. Quer parceria de verdade.",
    button: "Virar Melhor Amigo",
  },
};

// ===================== UTIL: LOG SEGURO =====================
function safeLogError(prefix, err) {
  // Nunca logar CPF/CNPJ. Também evitar logar payloads inteiros.
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
async function upstashFetch(path, bodyObj) {
  if (!USE_UPSTASH) return null;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    safeLogError("Upstash não configurado.", { message: "Falta URL/TOKEN" });
    return null;
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
    safeLogError("Erro Upstash:", { message: JSON.stringify(data) });
    return null;
  }
  return data;
}

async function redisGet(key) {
  if (!USE_UPSTASH) return null;
  const r = await upstashFetch("/get", [key]);
  return r?.result ?? null;
}

async function redisSet(key, value) {
  if (!USE_UPSTASH) return null;
  return upstashFetch("/set", [key, value]);
}

async function redisDel(key) {
  if (!USE_UPSTASH) return null;
  return upstashFetch("/del", [key]);
}

async function redisIncr(key) {
  if (!USE_UPSTASH) return null;
  const r = await upstashFetch("/incr", [key]);
  return r?.result ?? null;
}

// ===================== CHAVES =====================
function kUser(waId) {
  return `user:${waId}`;
}
function kStatus(waId) {
  return `status:${waId}`;
}
function kPrevStatus(waId) {
  return `prevstatus:${waId}`;
}
function kFreeUsed(waId) {
  return `freeused:${waId}`;
}
function kPlan(waId) {
  return `plan:${waId}`; // code
}
function kQuotaUsed(waId) {
  return `quotaused:${waId}`; // mês corrente
}
function kQuotaMonth(waId) {
  return `quotamonth:${waId}`; // YYYY-MM
}
function kPixValidUntil(waId) {
  return `pixvalid:${waId}`; // epoch ms
}
function kAsaasCustomerId(waId) {
  return `asaas:customer:${waId}`;
}
function kAsaasSubscriptionId(waId) {
  return `asaas:sub:${waId}`;
}
function kDraft(waId) {
  return `draft:${waId}`;
}
function kLastDesc(waId) {
  return `lastdesc:${waId}`;
}
function kRefineCount(waId) {
  return `refinecount:${waId}`;
}
function kIdempotency(messageId) {
  return `idemp:${messageId}`;
}
function kCleanupTick() {
  return `cleanup:last`;
}

// ===================== USER STATE =====================
async function getStatus(waId) {
  const s = await redisGet(kStatus(waId));
  return s || "WAIT_NAME";
}
async function setStatus(waId, status) {
  await redisSet(kStatus(waId), status);
}
async function pushPrevStatus(waId, status) {
  await redisSet(kPrevStatus(waId), status);
}
async function popPrevStatus(waId) {
  const s = await redisGet(kPrevStatus(waId));
  await redisDel(kPrevStatus(waId));
  return s;
}

async function getUser(waId) {
  const raw = await redisGet(kUser(waId));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  return u?.doc || ""; // cpf/cnpj
}
async function setDoc(waId, doc) {
  const u = await getUser(waId);
  u.doc = String(doc || "").trim();
  await setUser(waId, u);
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
  await redisSet(kPlan(waId), code);
}

function findPlanByCode(code) {
  const entries = Object.values(PLANS);
  return entries.find((p) => p.code === code) || null;
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
  if (!until) return false;
  return Date.now() < until;
}

async function canUseByPlanNow(waId) {
  const planCode = await getPlanCode(waId);
  if (!planCode) return false;

  // Pix: válido por 30 dias
  const subId = await redisGet(kAsaasSubscriptionId(waId));
  if (!subId) {
    const ok = await isActiveByPix(waId);
    if (!ok) return false;
  }

  // quota mensal
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
  // Primeiro tenta plano ativo
  const planCode = await getPlanCode(waId);
  if (planCode) {
    const can = await canUseByPlanNow(waId);
    if (!can) return false;
    await incQuotaUsed(waId);
    return true;
  }

  // Senão, trial
  const used = await getFreeUsed(waId);
  if (used >= FREE_DESCRIPTIONS_LIMIT) return false;
  await incFreeUsed(waId);
  return true;
}

// ===================== DRAFT / REFINO =====================
async function getDraft(waId) {
  const raw = await redisGet(kDraft(waId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function setDraft(waId, obj) {
  await redisSet(kDraft(waId), JSON.stringify(obj || {}));
}
async function clearDraft(waId) {
  await redisDel(kDraft(waId));
}

async function getLastDescription(waId) {
  return (await redisGet(kLastDesc(waId))) || "";
}
async function setLastDescription(waId, text) {
  await redisSet(kLastDesc(waId), String(text || ""));
}
async function clearLastDescription(waId) {
  await redisDel(kLastDesc(waId));
}

async function getRefineCount(waId) {
  const v = await redisGet(kRefineCount(waId));
  return Number(v || 0);
}
async function setRefineCount(waId, n) {
  await redisSet(kRefineCount(waId), String(Number(n || 0)));
}
async function clearRefineCount(waId) {
  await redisDel(kRefineCount(waId));
}

function mergeDraftFromMessage(prev, text) {
  const t = String(text || "").trim();
  const draft = prev ? { ...prev } : {};

  if (!draft.raw) draft.raw = [];
  draft.raw.push(t);

  // Heurística simples: não “entender demais”, só acumular.
  // (A IA decide o que está faltando e o que colocar como “consulte”.)

  return draft;
}

function draftToUserText(draft) {
  if (!draft) return "";
  const raw = Array.isArray(draft.raw) ? draft.raw.join(" | ") : "";
  return raw || "";
}

function looksLikeRefinement(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const low = t.toLowerCase();

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
    "agende", "agendar", "horário", "horario"
  ];
  if (keywords.some(k => low.includes(k))) return true;

  // feedback curto após uma descrição
  if (t.length <= 80) return true;

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
  return k.some(x => low.includes(x));
}

function isOkToFinish(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "ok" || t === "ok." || t === "okay" || t === "ok ✅" || t === "ok✅";
}

function isPositiveFeedbackLegacy(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["sim", "gostei", "perfeito", "ótimo", "otimo", "top", "show", "fechado"].includes(t);
}

function extractImprovementInstruction(text) {
  let t = String(text || "").trim();
  if (!t) return "";

  // Remove prefixos comuns para virar uma instrução "limpa"
  t = t.replace(/^(meu|minha)\s+/i, "");
  t = t.replace(/^((não\s+gostei|nao\s+gostei)\s*(do|da|de)?\s*)/i, "");
  t = t.replace(/^(melhore|melhorar|ajuste|ajustar|refaça|refazer|refaca|refazer|troque|substitua|mude|coloque)\s*[:\-]?\s*/i, "");

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
    safeLogError("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID no Render.", {
      message: "Env vars ausentes",
    });
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
    safeLogError("Erro ao enviar mensagem:", {
      message: `${resp.status} ${JSON.stringify(data)}`,
    });
  }
}

// ===================== OPENAI =====================
function sanitizeWhatsAppMarkdown(text) {
  let t = String(text || "");

  // Normaliza **negrito** -> *negrito*
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Remove padrões quebrados "* *" ou "** **"
  t = t.replace(/\*\s+\*/g, "*");
  t = t.replace(/\*\*\s+\*\*/g, "*");

  // Evita múltiplos asteriscos repetidos
  t = t.replace(/\*{3,}/g, "*");

  // Evita linhas vazias excessivas
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

async function openaiGenerateDescription({ userText, instruction, fullName }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY ausente.");
  }

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
- Se for PRODUTO (comida, item, artesanato etc): pode mencionar entrega/retirada somente se o cliente informou. Se não informou, use "Entrega/retirada a combinar" ou apenas omita e finalize com CTA.
- Se for SERVIÇO (ex.: pedreiro, manicure, sobrancelha, elétrica, pneu, vidraceiro etc):
  - NÃO use "entrega/retirada".
  - Se parecer serviço com hora marcada (unha, cabelo, sobrancelha, estética): use "Agende um horário".
  - Se parecer serviço orçamentado (pedreiro, elétrica, telhado, vidraçaria): use "Solicite um orçamento".

ESTRUTURA SUGERIDA:
1) *TÍTULO*
2) 2–4 linhas com benefícios e apelo
3) Linha de preço/valor (se houver) ou "Consulte valores"
4) Linha final (produto: entrega/retirada se fizer sentido; serviço: "Agende um horário" ou "Solicite um orçamento")
5) CTA curto (ex.: "Chama no WhatsApp!").
`;

  const user = `
Nome do cliente (se houver): ${fullName || "—"}

Texto do cliente:
${userText}

Instrução de melhoria (se houver):
${instruction || "—"}

Gere a descrição final agora.
`;

  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      data?.error?.message || `OpenAI ${resp.status}: erro ao gerar.`
    );
  }

  // responses API: texto pode estar em output_text (mais simples)
  const outText =
    data.output_text ||
    data?.output?.[0]?.content?.[0]?.text ||
    "";

  return sanitizeWhatsAppMarkdown(outText);
}

// ===================== ASAAS =====================
async function asaasFetch(path, method, bodyObj) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY ausente.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      access_token: ASAAS_API_KEY,
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findOrCreateAsaasCustomer({ waId, name, doc }) {
  // Tenta recuperar do cache
  const cached = await redisGet(kAsaasCustomerId(waId));
  if (cached) return cached;

  // Cria cliente no Asaas (CPF/CNPJ é obrigatório em várias operações)
  const created = await asaasFetch("/v3/customers", "POST", {
    name,
    cpfCnpj: doc,
    // opcional: email, phone, mobilePhone etc (não obrigatório aqui)
  });

  const customerId = created?.id;
  if (!customerId) throw new Error("Asaas: customerId não retornou.");

  await redisSet(kAsaasCustomerId(waId), customerId);
  return customerId;
}

async function createCardSubscription({ waId, plan }) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);
  if (!name) throw new Error("Nome ausente.");
  if (!doc) throw new Error("CPF/CNPJ ausente.");

  const customerId = await findOrCreateAsaasCustomer({ waId, name, doc });

  // Assinatura recorrente (cartão). O Asaas gerencia cobrança recorrente.
  const sub = await asaasFetch("/v3/subscriptions", "POST", {
    customer: customerId,
    billingType: "CREDIT_CARD",
    nextDueDate: new Date().toISOString().slice(0, 10),
    value: plan.price,
    cycle: "MONTHLY",
    description: `Amigo das Vendas - Plano ${plan.name}`,
  });

  const subId = sub?.id;
  if (!subId) throw new Error("Asaas: subscription id não retornou.");

  await redisSet(kAsaasSubscriptionId(waId), subId);
  await setPlanCode(waId, plan.code);

  // Zera quota do mês (começa novo ciclo)
  await setQuotaMonth(waId, currentMonthKey());
  await setQuotaUsed(waId, 0);
  await clearPixValidUntil(waId);

  // Link de pagamento / checkout
  // Em assinaturas, o pagamento pode exigir ação do cliente. O Asaas retorna invoiceUrl em alguns cenários,
  // mas nem sempre. Vamos tentar usar "invoiceUrl" se existir; senão, orientar o usuário a concluir no Asaas.
  const link =
    sub?.invoiceUrl ||
    sub?.paymentLink ||
    sub?.bankSlipUrl ||
    sub?.url ||
    "";

  return { subscriptionId: subId, link };
}

async function createPixPayment({ waId, plan }) {
  const name = await getFullName(waId);
  const doc = await getDoc(waId);
  if (!name) throw new Error("Nome ausente.");
  if (!doc) throw new Error("CPF/CNPJ ausente.");

  const customerId = await findOrCreateAsaasCustomer({ waId, name, doc });

  // Pagamento avulso via PIX
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

  const payId = payment?.id;
  if (!payId) throw new Error("Asaas: payment id não retornou.");

  // Busca QR Code / link do Pix
  const pix = await asaasFetch(`/v3/payments/${payId}/pixQrCode`, "GET");
  const link =
    pix?.payload ||
    pix?.encodedImage ||
    payment?.invoiceUrl ||
    "";

  return { paymentId: payId, link, invoiceUrl: payment?.invoiceUrl || "" };
}

// Webhook Asaas (confirma pagamento PIX, etc.)
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (ASAAS_WEBHOOK_TOKEN) {
      const token = req.header("asaas-access-token") || req.header("Authorization") || "";
      if (!token || !token.includes(ASAAS_WEBHOOK_TOKEN)) {
        return;
      }
    }

    const event = req.body?.event;
    const payment = req.body?.payment;

    if (!event) return;

    // Quando PIX for confirmado, liberar 30 dias
    if (event === "PAYMENT_CONFIRMED" || event === "PAYMENT_RECEIVED") {
      // Aqui você pode mapear waId pelo customerId se quiser, mas como MVP:
      // no seu fluxo atual, você já libera após confirmação do webhook? (depende do seu design)
      // Mantemos a estrutura sem assumir vínculo.
      // (Se você quiser, a gente implementa lookup customerId->waId via Redis.)
      return;
    }
  } catch (e) {
    safeLogError("Erro webhook Asaas:", e);
  }
});

// ===================== TEXTO DE MENUS =====================
function menuText() {
  return (
    "*MENU — Amigo das Vendas* 📌\n\n" +
    "1) Minha assinatura\n" +
    "2) Mudar plano\n" +
    "3) Cancelar plano (cartão)\n" +
    "4) Alterar nome\n" +
    "5) Alterar CPF/CNPJ\n" +
    "6) Ajuda\n\n" +
    "Responda com o número da opção.\n" +
    "Se quiser sair do menu, é só mandar sua próxima descrição normalmente 🙂"
  );
}

function plansMenuText() {
  return (
    "*Escolha um plano* 👇\n\n" +
    `1) *${PLANS[1].name}* — R$ ${PLANS[1].price.toFixed(2)}\n` +
    `   • ${PLANS[1].quotaMonthly} descrições/mês\n\n` +
    `2) *${PLANS[2].name}* — R$ ${PLANS[2].price.toFixed(2)}\n` +
    `   • ${PLANS[2].quotaMonthly} descrições/mês\n\n` +
    `3) *${PLANS[3].name}* — R$ ${PLANS[3].price.toFixed(2)}\n` +
    `   • ${PLANS[3].quotaMonthly} descrições/mês\n\n` +
    "Responda com 1, 2 ou 3."
  );
}

function paymentMethodText() {
  return (
    "*Forma de pagamento* 💳\n\n" +
    "1) Cartão\n" +
    "2) Pix\n\n" +
    "Responda com 1 ou 2."
  );
}

async function buildMySubscriptionText(waId) {
  const status = await getStatus(waId);

  if (status !== "ACTIVE") {
    const used = await getFreeUsed(waId);
    const left = Math.max(0, FREE_DESCRIPTIONS_LIMIT - used);
    return (
      "*Minha assinatura*\n\n" +
      "Você ainda não ativou um plano.\n\n" +
      `Grátis restantes: *${left}* de *${FREE_DESCRIPTIONS_LIMIT}*\n\n` +
      "Digite *MENU* para ver opções."
    );
  }

  const planCode = await getPlanCode(waId);
  const plan = findPlanByCode(planCode);
  const used = await getQuotaUsed(waId);

  let extra = "";
  const subId = await redisGet(kAsaasSubscriptionId(waId));
  if (!subId) {
    const until = await getPixValidUntil(waId);
    if (until) {
      const daysLeft = Math.max(0, Math.ceil((until - Date.now()) / (1000 * 60 * 60 * 24)));
      extra = `Validade (Pix): *${daysLeft} dia(s)* restantes\n`;
    }
  }

  return (
    "*Minha assinatura*\n\n" +
    `Plano: *${plan?.name || "—"}*\n` +
    `Uso no mês: *${used}* / *${plan?.quotaMonthly || "—"}*\n` +
    (extra ? extra : "") +
    `\nAjuda: ${HELP_URL}`
  );
}

// ===================== LIMPEZA (a cada ~1h) =====================
async function maybeCleanup() {
  if (!USE_UPSTASH) return;
  const last = Number((await redisGet(kCleanupTick())) || 0);
  const now = Date.now();
  if (now - last < 60 * 60 * 1000) return;

  await redisSet(kCleanupTick(), String(now));
  // MVP: sem scan para não pagar caro / sem keys list.
  // Se quiser limpeza real, implementamos com prefixos + sets de usuários.
}

// ===================== IDEMPOTÊNCIA =====================
async function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const key = kIdempotency(messageId);
  const seen = await redisGet(key);
  if (seen) return true;
  // marca como visto (sem TTL no MVP; se quiser TTL, dá pra usar /setex)
  await redisSet(key, "1");
  return false;
}

// ===================== MENU HELPERS =====================
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

    // status events
    const statuses = value?.statuses;
    if (statuses && statuses.length) {
      // não precisa responder
      return;
    }

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const waId = msg.from;

    if (!waId) return;

    // idempotência
    if (await isDuplicateMessage(msg.id)) return;

    // apenas texto por enquanto
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

    // ===== MENU (ativar a qualquer momento) =====
    if (isMenuCommand(text)) {
      // Evita "prender" em MENU: se já estiver em algum estado MENU, não sobrescreve o status anterior
      if (!String(status || "").startsWith("MENU")) {
        await pushPrevStatus(waId, status);
      }
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    // ===== MENU FLOW =====
    if (status === "MENU") {
      if (text === "1") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_PLANINFO");
        const info = await buildMySubscriptionText(waId);
        await sendWhatsAppText(waId, info + "\n\nDigite 1 para voltar ao Menu.");
        return;
      }
      if (text === "2") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_CHANGE_PLAN");
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }
      if (text === "3") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_CANCEL");
        await sendWhatsAppText(
          waId,
          "*Cancelar plano (cartão)*\n\nResponda:\n1) Confirmar cancelamento\n2) Voltar"
        );
        return;
      }
      if (text === "4") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_UPDATE_NAME");
        await sendWhatsAppText(waId, "Me envie seu *nome completo* para atualizar.");
        return;
      }
      if (text === "5") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_UPDATE_DOC");
        await sendWhatsAppText(waId, "Me envie seu *CPF ou CNPJ* (somente números) para atualizar.");
        return;
      }
      if (text === "6") {
        await pushPrevStatus(waId, "MENU");
        await setStatus(waId, "MENU_HELP");
        await sendWhatsAppText(
          waId,
          "*Ajuda* 🙋\n\n" +
            `Dúvidas e perguntas frequentes: ${HELP_URL}\n\n` +
            "Digite 1 para voltar ao Menu."
        );
        return;
      }

      // Se não for opção, sai do menu e segue como descrição
      const prev = (await popPrevStatus(waId)) || "ACTIVE";
      await setStatus(waId, prev);
      status = prev;
      // Não retorna: se a pessoa digitou algo que não é opção, tratamos como nova descrição.
    }

    if (status === "MENU_HELP") {
      const prev = (await popPrevStatus(waId)) || "ACTIVE";
      await setStatus(waId, prev);
      status = prev;
      // segue fluxo normal
    }

    if (status === "MENU_PLANINFO") {
      const prev = (await popPrevStatus(waId)) || "ACTIVE";
      await setStatus(waId, prev);
      status = prev;
      // segue fluxo normal
    }

    if (status === "MENU_CHANGE_PLAN") {
      if (!["1", "2", "3"].includes(text)) {
        const prev = (await popPrevStatus(waId)) || "ACTIVE";
        await setStatus(waId, prev);
        status = prev;
        // segue fluxo normal
      } else {
        await redisSet(`tmp:planchoice:${waId}`, text);
        await setStatus(waId, "WAIT_PAYMETHOD");
        await sendWhatsAppText(waId, paymentMethodText());
        return;
      }
    }

    if (status === "MENU_CANCEL") {
      if (text === "2") {
        await setStatus(waId, "MENU");
        await sendWhatsAppText(waId, menuText());
        return;
      }
      if (text !== "1") {
        const prev = (await popPrevStatus(waId)) || "ACTIVE";
        await setStatus(waId, prev);
        status = prev;
        // segue fluxo normal
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
        await setStatus(waId, "MENU");
        await sendWhatsAppText(waId, menuText());
        return;
      }
    }

    // ===================== ATUALIZAÇÃO (nome) =====================
    if (status === "MENU_UPDATE_NAME") {
      const name = text.trim();
      if (name.length < 3) {
        await sendWhatsAppText(waId, "Nome muito curto. Me envie seu *nome completo*.");
        return;
      }
      await setFullName(waId, name);
      await sendWhatsAppText(waId, "Nome atualizado ✅");
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    // ===================== ATUALIZAÇÃO (doc) =====================
    if (status === "MENU_UPDATE_DOC") {
      const doc = cleanDoc(text);
      if (doc.length !== 11 && doc.length !== 14) {
        await sendWhatsAppText(waId, "CPF/CNPJ inválido. Me envie somente números (11 ou 14 dígitos).");
        return;
      }
      await setDoc(waId, doc);
      await sendWhatsAppText(waId, "CPF/CNPJ atualizado ✅");
      await setStatus(waId, "MENU");
      await sendWhatsAppText(waId, menuText());
      return;
    }

    // ===================== ONBOARDING =====================
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

      // Cartão
      if (text === "1") {
        try {
          const r = await createCardSubscription({ waId, plan });
          await setStatus(waId, "ACTIVE");

          if (r.link) {
            await sendWhatsAppText(
              waId,
              `✅ Plano ativado: *${plan.name}*!\n\nFinalize o pagamento por aqui:\n${r.link}`
            );
          } else {
            await sendWhatsAppText(
              waId,
              `✅ Plano ativado: *${plan.name}*!\n\nSe o Asaas solicitar confirmação do pagamento, conclua por lá.`
            );
          }

          await sendWhatsAppText(waId, "Agora é só me mandar o que você vende/serviço que oferece 🙂");
        } catch (e) {
          safeLogError("Erro criando assinatura Asaas:", e);
          await sendWhatsAppText(
            waId,
            "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3)."
          );
          await setStatus(waId, "WAIT_PLAN");
          await sendWhatsAppText(waId, plansMenuText());
        }
        return;
      }

      // Pix
      if (text === "2") {
        try {
          const r = await createPixPayment({ waId, plan });

          // Só ativa quando realmente pagar (ideal via webhook). MVP: ativa por 30 dias a partir de agora ao gerar link.
          await setPlanCode(waId, plan.code);
          await setQuotaMonth(waId, currentMonthKey());
          await setQuotaUsed(waId, 0);

          const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
          await setPixValidUntil(waId, validUntil);
          await setStatus(waId, "ACTIVE");

          const linkText =
            r.invoiceUrl
              ? r.invoiceUrl
              : (r.link ? "Pix gerado. Use o link/QR no Asaas." : "");

          await sendWhatsAppText(
            waId,
            `✅ Plano ativado: *${plan.name}*!\n\nPague via Pix neste link:\n${linkText}`
          );
          await sendWhatsAppText(waId, "Agora é só me mandar o que você vende/serviço que oferece 🙂");
        } catch (e) {
          safeLogError("Erro criando pagamento Pix Asaas:", e);
          await sendWhatsAppText(
            waId,
            "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3)."
          );
          await setStatus(waId, "WAIT_PLAN");
          await sendWhatsAppText(waId, plansMenuText());
        }
        return;
      }
    }

    // ===================== ACTIVE / BLOQUEIOS =====================
    // Se não tem plano e já acabou trial: bloqueia
    if (status !== "ACTIVE") {
      const planCode = await getPlanCode(waId);
      const used = await getFreeUsed(waId);
      if (!planCode && used >= FREE_DESCRIPTIONS_LIMIT) {
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(
          waId,
          "Você atingiu o limite do trial.\nDigite *MENU* para ver opções."
        );
        return;
      }
    }

    // Se tem plano mas não pode usar (expirou Pix ou quota esgotou), bloqueia e manda menu
    if (status === "ACTIVE") {
      const can = await canUseByPlanNow(waId);
      if (!can) {
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(
          waId,
          "Você atingiu o limite do seu plano ou ele expirou.\nDigite *MENU* para ver opções."
        );
        return;
      }
    }

    // ===================== DESCRIÇÃO / REFINO =====================

    const prevDraft = await getDraft(waId);
    const lastDesc = await getLastDescription(waId);
    const refineCount = await getRefineCount(waId);

    // Caso o usuário confirme que está tudo certo
    if (lastDesc && (isOkToFinish(text) || isPositiveFeedbackLegacy(text))) {
      await sendWhatsAppText(waId, "Boa! ✅\nSe quiser fazer outra descrição, é só me mandar o próximo produto 🙂");
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);
      return;
    }

    // Decide se é REFINO / INFO EXTRA / NOVA DESCRIÇÃO
    if (lastDesc) {
      const isRefine = looksLikeRefinement(text);
      const isExtraInfo = looksLikeAdditionalInfo(text);

      // Se não parecer refino nem info extra, interpretamos como nova descrição (sai do modo refino)
      if (!isRefine && !isExtraInfo) {
        await clearDraft(waId);
        await clearRefineCount(waId);
        await clearLastDescription(waId);
      } else {
        // ======== REFINO (não consome descrição, salvo quando passa do limite) ========
        let draftForGen = prevDraft;
        let instruction = "";

        if (isExtraInfo) {
          draftForGen = mergeDraftFromMessage(prevDraft, text);
          await setDraft(waId, draftForGen);
          instruction = `Incorpore estas novas informações do cliente na descrição: ${text}`;
        } else {
          // refino puro (não altera o rascunho)
          instruction = extractImprovementInstruction(text);
        }

        // após 2 refinamentos, o próximo conta como nova descrição
        let nextRefineCount = refineCount + 1;
        if (refineCount >= MAX_REFINES_PER_DESCRIPTION) {
          const okConsume = await consumeOneDescriptionOrBlock(waId);
          if (!okConsume) {
            await setStatus(waId, "BLOCKED");
            await sendWhatsAppText(waId, "Você atingiu o limite do seu plano.\nDigite *MENU* para ver opções.");
            return;
          }
          nextRefineCount = 1; // começa um novo ciclo de refinamentos
        }

        await setRefineCount(waId, nextRefineCount);

        try {
          const gen = await openaiGenerateDescription({
            userText: draftToUserText(draftForGen),
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

    // ===================== NOVA DESCRIÇÃO (gera agora) =====================

    const draft = mergeDraftFromMessage(await getDraft(waId), text);
    await setDraft(waId, draft);

    const okConsume = await consumeOneDescriptionOrBlock(waId);
    if (!okConsume) {
      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, "Você atingiu o limite do trial/plano.\nDigite *MENU* para ver opções.");
      return;
    }

    try {
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
