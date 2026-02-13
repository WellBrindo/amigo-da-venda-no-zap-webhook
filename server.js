import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

/**
 * IMPORTANTE:
 * - guardamos rawBody pra validar assinatura do webhook da Meta
 * - NÃO vamos logar req.body inteiro (pode conter dados sensíveis)
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ===================== ENV =====================
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const APP_SECRET = (process.env.APP_SECRET || "").trim();

const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || "").trim();
const ASAAS_WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || "").trim();
const ASAAS_BASE_URL = (process.env.ASAAS_BASE_URL || "https://api.asaas.com").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-5-mini").trim();

const FREE_DESCRIPTIONS_LIMIT = Number(process.env.FREE_DESCRIPTIONS_LIMIT || 5);

// ===================== OPENAI CLIENT =====================
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ===================== PLANOS (MENSAL) =====================
const PLANS = {
  P1: { code: "P1", name: "De Vez em Quando", price: 24.9, monthlyLimit: 20 },
  P2: { code: "P2", name: "Sempre por Perto", price: 34.9, monthlyLimit: 60 },
  P3: { code: "P3", name: "Melhor Amigo", price: 49.9, monthlyLimit: 200 },
};

// refinamentos gratuitos por “descrição/sessão”
const MAX_FREE_REFINES_PER_DESCRIPTION = 3;

// TTLs
const TTL_DAY_SECONDS = 26 * 60 * 60;
const TTL_WEEK_SECONDS = 8 * 24 * 60 * 60;
const TTL_MONTH_SECONDS = 40 * 24 * 60 * 60;

// ===================== HEALTH =====================
app.get("/", (_req, res) => res.status(200).send("OK - Amigo das Vendas no Zap rodando"));

// ===================== META VERIFY =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===================== META SIGNATURE =====================
function isValidMetaSignature(req) {
  if (!APP_SECRET) {
    console.warn("⚠️ APP_SECRET não configurado: assinatura da Meta NÃO será validada (recomendado configurar).");
    return true;
  }
  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ===================== UPSTASH HELPERS =====================
async function upstashCmd(cmdArr) {
  if (!USE_UPSTASH) throw new Error("Upstash não configurado.");
  const url = `${UPSTASH_REDIS_REST_URL}/${cmdArr.map(encodeURIComponent).join("/")}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upstash ${resp.status}`);
  return data?.result;
}

const redisGet = async (k) => (await upstashCmd(["GET", k])) ?? null;
const redisSet = async (k, v) => upstashCmd(["SET", k, String(v)]);
const redisSetEx = async (k, v, ex) => upstashCmd(["SET", k, String(v), "EX", String(ex)]);
const redisExists = async (k) => Number((await upstashCmd(["EXISTS", k])) || 0) > 0;
const redisIncr = async (k) => Number((await upstashCmd(["INCR", k])) || 0);
const redisDel = async (k) => upstashCmd(["DEL", k]);

// ===================== TIME (SP) =====================
function spYYYYMM() {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });
  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}${map.month}`; // ex: 202602
}

// ===================== WHATSAPP SEND =====================
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID.");
    return;
  }
  const url = `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // não logar tokens/ambiente; só status
      console.error("Erro ao enviar mensagem:", resp.status);
    } else {
      // log mínimo
      console.log("Mensagem enviada OK:", data?.messages?.[0]?.id || "ok");
    }
  } catch (e) {
    console.error("Erro rede ao enviar mensagem.");
  }
}

// ===================== TEXTOS =====================
function askNameText() {
  return "Olá! Eu sou o Amigo das Vendas no Zap 🤝\nPra eu te atender direitinho, me diga seu *nome completo* 🙂";
}

function plansMenuText() {
  return (
    "Você chegou ao limite do seu plano/trial.\n\n" +
    "Para continuar, escolha um plano:\n\n" +
    "1) 🤝 De Vez em Quando — R$ 24,90/mês\n" +
    "   • 20 descrições por mês\n\n" +
    "2) 💬 Sempre por Perto ⭐ — R$ 34,90/mês\n" +
    "   • 60 descrições por mês\n\n" +
    "3) 🚀 Melhor Amigo — R$ 49,90/mês\n" +
    "   • 200 descrições por mês\n\n" +
    "Responda com 1, 2 ou 3."
  );
}

function askFeedbackText() {
  return (
    "Gostou da descrição? 🙂\n" +
    "Se quiser ajustar, me diga *o que não gostou* (ex.: “título”, “muito longo”, “mais direto”, “mais emoji”) ou envie alguma info que faltou (preço, sabores, entrega etc.).\n" +
    "Se quiser fazer outro produto, escreva: *novo*"
  );
}

function firstNameOf(fullName) {
  const t = String(fullName || "").trim();
  if (!t) return "";
  return t.split(/\s+/)[0] || "";
}

function looksLikeFullName(text) {
  const t = String(text || "").trim();
  if (t.length < 5) return false;
  if (!t.includes(" ")) return false;
  if (/^\d+$/.test(t.replace(/\s+/g, ""))) return false;
  return true;
}

// ===================== PRIVACIDADE (CPF/CNPJ) =====================
function normalizeDocOnlyDigits(input) {
  return String(input || "").replace(/\D/g, "");
}
function isValidCPFOrCNPJ(doc) {
  const d = normalizeDocOnlyDigits(doc);
  return d.length === 11 || d.length === 14;
}
function redactDoc(text) {
  // remove sequências longas de números (ex.: CPF) de logs/eventos
  return String(text || "").replace(/\d{11,14}/g, "[REDACTED]");
}

// ===================== DRAFT / CONTEXTO =====================
function emptyDraft() {
  return {
    product: null,
    price: null,
    flavors: null,
    delivery: null,
    extras: null, // qualquer info extra curta
    tone: null,   // opcional
    updatedAt: Date.now(),
  };
}

function parsePrice(text) {
  // pega R$ 10,00 / 10.00 / 10 reais etc.
  const t = String(text || "");
  const m1 = t.match(/R\$\s*([0-9]{1,6}(?:[.,][0-9]{1,2})?)/i);
  if (m1) return `R$ ${m1[1].replace(".", ",")}`;
  const m2 = t.match(/\b([0-9]{1,6}(?:[.,][0-9]{1,2})?)\s*(reais|real)\b/i);
  if (m2) return `R$ ${m2[1].replace(".", ",")}`;
  return null;
}

function detectDelivery(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("entrego") || t.includes("entrega") || t.includes("delivery") || t.includes("retirada") || t.includes("retirar")) {
    return text.trim().slice(0, 80);
  }
  return null;
}

function detectFlavors(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("sabor") || t.includes("sabores") || t.includes("opções") || t.includes("opcoes")) {
    return text.trim().slice(0, 120);
  }
  // heurística: lista com vírgulas pode ser sabores
  if (text.includes(",") && text.split(",").length >= 2) return text.trim().slice(0, 120);
  return null;
}

function isResetCommand(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["novo", "reiniciar", "cancelar", "reset"].includes(t);
}

function isPositiveFeedback(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["gostei", "perfeito", "ótimo", "otimo", "amei", "ficou bom", "show", "top", "fechado"].some((k) => t.includes(k));
}

function isNegativeFeedback(text) {
  const t = String(text || "").trim().toLowerCase();
  return t.includes("não gostei") || t.includes("nao gostei") || t.includes("ruim") || t.includes("melhorar") || t.includes("refazer");
}

function extractFeedbackInstruction(text) {
  // tenta capturar "não gostei do título", "muito longo", etc.
  const t = String(text || "").trim();
  if (!t) return null;
  // remove cpf/cnpj por segurança
  return redactDoc(t).slice(0, 200);
}

function guessProduct(text) {
  // bem simples: se tiver "vendendo X", pega X; senão pega a mensagem toda como produto
  const t = String(text || "").trim();
  const m = t.match(/vendendo\s+(.+)/i);
  if (m && m[1]) return m[1].trim().slice(0, 80);
  return t.slice(0, 80);
}

// ===================== UPSTASH KEYS (USER STATE) =====================
const getStatus = async (waId) => (await redisGet(`status:${waId}`)) || "TRIAL";
const setStatus = async (waId, s) => redisSet(`status:${waId}`, s);

const getPlan = async (waId) => (await redisGet(`plan:${waId}`)) || null;
const setPlan = async (waId, p) => redisSet(`plan:${waId}`, p);

const getFullName = async (waId) => (await redisGet(`full_name:${waId}`)) || null;
const setFullName = async (waId, name) => redisSet(`full_name:${waId}`, name);

const setPhone = async (waId) => redisSet(`phone:${waId}`, waId);

const getDoc = async (waId) => (await redisGet(`doc:${waId}`)) || null;
const setDoc = async (waId, doc) => redisSet(`doc:${waId}`, doc);

// trial por “descrições” (mensal)
const getTrialUses = async (waId) => Number((await redisGet(`trial_uses:${waId}:${spYYYYMM()}`)) || 0);
const incrTrialUses = async (waId) => redisIncr(`trial_uses:${waId}:${spYYYYMM()}`);

// uso do plano (mensal)
const getPlanUses = async (waId) => Number((await redisGet(`uses_month:${waId}:${spYYYYMM()}`)) || 0);
const incrPlanUses = async (waId) => redisIncr(`uses_month:${waId}:${spYYYYMM()}`);

// draft + refinamentos
const getDraft = async (waId) => {
  const raw = await redisGet(`draft:${waId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const setDraft = async (waId, obj) => redisSetEx(`draft:${waId}`, JSON.stringify(obj), TTL_DAY_SECONDS);
const clearDraft = async (waId) => redisDel(`draft:${waId}`);

const getRefineCount = async (waId) => Number((await redisGet(`refines:${waId}`)) || 0);
const setRefineCount = async (waId, n) => redisSetEx(`refines:${waId}`, String(n), TTL_DAY_SECONDS);
const clearRefineCount = async (waId) => redisDel(`refines:${waId}`);

// guarda a última descrição para refinamentos
const getLastDescription = async (waId) => (await redisGet(`last_desc:${waId}`)) || null;
const setLastDescription = async (waId, text) => redisSetEx(`last_desc:${waId}`, text, TTL_DAY_SECONDS);
const clearLastDescription = async (waId) => redisDel(`last_desc:${waId}`);

// ===================== LIMITES =====================
async function canConsumeDescription(waId, status, planCode) {
  if (status === "ACTIVE") {
    const plan = PLANS[planCode];
    if (!plan) return { ok: false, reason: "no_plan" };
    const used = await getPlanUses(waId);
    if (used >= plan.monthlyLimit) return { ok: false, reason: "plan_limit", used, limit: plan.monthlyLimit };
    const next = await incrPlanUses(waId);
    // set ttl na primeira vez (opcional) — Upstash REST não tem EXPIRE separado fácil; usamos setEx quando iniciar o mês:
    // aqui mantemos simples: se quiser TTL, você pode trocar para SETEX com valor inicial 0 no começo do mês.
    return { ok: true, used: next, limit: plan.monthlyLimit };
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
      `✅ Você atingiu o limite do mês do plano ${plan?.name || ""}.\n` +
      `Uso: ${used}/${limit}\n\n` +
      `Se quiser, posso te mostrar os planos novamente.`
    );
  }
  return `✅ Você atingiu o limite do trial.\nUso: ${used}/${limit}\n\n${plansMenuText()}`;
}

// ===================== ASAAS =====================
async function asaasFetch(path, { method = "GET", body = null } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY não configurada.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // não retornar data (pode conter info)
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
  // PUT para atualizar
  await asaasFetch(`/v3/customers/${customerId}`, {
    method: "PUT",
    body: { cpfCnpj },
  });
}

async function getOrCreateAsaasCustomer(waId, fullName, cpfCnpj) {
  const key = `asaas_customer:${waId}`;
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

async function createSubscriptionAndGetPayLink(waId, planCode) {
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
      billingType: "UNDEFINED",
      nextDueDate: nextDueDateISO(),
      value: plan.price,
      cycle: "MONTHLY",
      description: `Amigo das Vendas no Zap - ${plan.name}`,
    },
  });

  if (!sub?.id) throw new Error("Asaas subscription id ausente.");

  await redisSet(`subscription_to_wa:${sub.id}`, waId);
  await redisSet(`asaas_subscription:${waId}`, sub.id);

  const payments = await asaasFetch(`/v3/subscriptions/${sub.id}/payments`, { method: "GET" });
  const first = payments?.data?.[0] || null;

  return { subscriptionId: sub.id, invoiceUrl: first?.invoiceUrl || null };
}

// ===================== IA: GERAR DESCRIÇÃO =====================
function buildMissingHints(draft) {
  const hints = [];
  if (!draft.price) hints.push("Não foi informado o preço: inclua 'Consulte valores'.");
  if (!draft.flavors) hints.push("Não foram informados sabores/opções: inclua 'Consulte sabores disponíveis'.");
  if (!draft.delivery) hints.push("Não foi informado entrega/retirada: inclua 'Entrega/retirada a combinar'.");
  return hints;
}

function buildUserBrief(draft) {
  const parts = [];
  if (draft.product) parts.push(`Produto: ${draft.product}`);
  if (draft.price) parts.push(`Preço: ${draft.price}`);
  if (draft.flavors) parts.push(`Sabores/opções: ${draft.flavors}`);
  if (draft.delivery) parts.push(`Entrega/retirada: ${draft.delivery}`);
  if (draft.extras) parts.push(`Detalhes extras: ${draft.extras}`);
  return parts.join("\n");
}

async function generateSalesDescription({ fullName, draft, feedbackInstruction }) {
  if (!openai) throw new Error("OPENAI_NOT_CONFIGURED");

  const fn = firstNameOf(fullName);

  const missingHints = buildMissingHints(draft);
  const brief = buildUserBrief(draft);

  const instructions =
    "Você é um redator publicitário para WhatsApp. Sua tarefa é gerar UMA descrição vendável e curta para a pessoa copiar e encaminhar no grupo.\n" +
    "Regras:\n" +
    "- Responda APENAS com o texto final (sem explicações).\n" +
    "- Estrutura: Título chamativo + 2-4 linhas + preço + entrega/retirada + CTA.\n" +
    "- Emojis moderados (2 a 6), apropriados.\n" +
    "- Linguagem simples, acolhedora, sem termos técnicos.\n" +
    "- NÃO invente informação. Se faltar algo, use as frases: 'Consulte valores', 'Consulte sabores disponíveis', 'Entrega/retirada a combinar'.\n" +
    "- Não cite 'Asaas' nem termos de pagamento técnico.\n" +
    "- Não use caracteres excessivos nem texto longo.\n" +
    (fn ? `- Trate o cliente internamente como '${fn}', mas NÃO inclua o nome no texto final (o texto deve ser genérico para encaminhar).\n` : "");

  const userInput =
    `Informações do produto:\n${brief || "(usuário não detalhou; deduza o mínimo sem inventar)"}\n\n` +
    (missingHints.length ? `Pontos que faltam:\n- ${missingHints.join("\n- ")}\n\n` : "") +
    (feedbackInstruction ? `Ajuste solicitado pelo usuário:\n${feedbackInstruction}\n\n` : "") +
    "Gere agora a descrição final.";

  // Responses API (recomendada) via SDK
  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: userInput },
    ],
  });

  const out = resp.output_text?.trim();
  if (!out) throw new Error("EMPTY_MODEL_OUTPUT");
  return out;
}

// ===================== FLUXO: DRAFT UPDATE =====================
function updateDraftFromUserMessage(draft, userText) {
  const next = { ...(draft || emptyDraft()) };

  // tenta achar preço
  const p = parsePrice(userText);
  if (p) next.price = p;

  // sabores/opções
  const f = detectFlavors(userText);
  if (f) next.flavors = f;

  // entrega
  const d = detectDelivery(userText);
  if (d) next.delivery = d;

  // produto
  // se draft não tem produto, inferimos do texto
  if (!next.product) {
    const prod = guessProduct(userText);
    if (prod) next.product = prod;
  } else {
    // se a pessoa escreve "é bolo de pote" e o draft já era "bolo",
    // podemos enriquecer extras
    if (userText.length <= 120 && !p && !f && !d) {
      next.extras = next.extras ? `${next.extras} | ${userText}`.slice(0, 180) : userText.slice(0, 180);
    }
  }

  next.updatedAt = Date.now();
  return next;
}

// ===================== WEBHOOK META (WHATSAPP) =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    if (!USE_UPSTASH) return console.error("❌ Upstash não configurado.");
    if (!isValidMetaSignature(req)) return;

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();
    if (metaPhoneId === "123456123") return; // mock painel
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    // status events
    if (value?.statuses?.length) return;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const waId = msg.from;
    const messageId = msg.id;

    await setPhone(waId);

    // idempotência por messageId
    if (messageId) {
      const k = `processed:${messageId}`;
      if (await redisExists(k)) return;
      await redisSetEx(k, "1", 48 * 60 * 60);
    }

    const text = msg.type === "text" ? (msg.text?.body?.trim() || "") : "";
    const safeTextForLogic = redactDoc(text); // não usa doc em nenhum log

    // comandos básicos
    if (isResetCommand(text)) {
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);
      await setStatus(waId, (await getPlan(waId)) ? "ACTIVE" : "TRIAL");
      await sendWhatsAppText(waId, "Beleza! 👌 Me diga qual produto você quer vender agora (pode ser simples, tipo: “bolo de chocolate”).");
      return;
    }

    // guarda nome (primeiro passo)
    const fullName = await getFullName(waId);
    let status = await getStatus(waId);
    const planCode = await getPlan(waId);

    if (!fullName && status !== "WAIT_NAME") {
      await setStatus(waId, "WAIT_NAME");
      await sendWhatsAppText(waId, askNameText());
      return;
    }

    if (status === "WAIT_NAME") {
      if (!looksLikeFullName(text)) {
        await sendWhatsAppText(waId, "Me diga seu *nome completo* 🙂 (ex.: Maria da Silva)");
        return;
      }
      await setFullName(waId, text);
      await setStatus(waId, planCode ? "ACTIVE" : "TRIAL");
      await sendWhatsAppText(waId, `Prazer, ${firstNameOf(text)}! ✅ Agora me diga: o que você está vendendo?`);
      return;
    }

    // Se não for texto, pede texto (produto precisa)
    if (msg.type !== "text") {
      await sendWhatsAppText(waId, "Por enquanto eu entendo *apenas texto* 🙂\nMe mande: produto + preço (se tiver) + entrega (se tiver).");
      return;
    }

    // ===================== BLOQUEADO/PAGAMENTO =====================
    if (status === "BLOCKED" || status === "PENDING" || status === "WAIT_DOC") {
      // fluxo pagamento (igual ao anterior), com CPF e nome guardados.
      // 1) escolher plano
      if (status === "BLOCKED" || status === "PENDING") {
        const choice = text.replace(/[^\d]/g, "");
        const chosen = choice === "1" ? "P1" : choice === "2" ? "P2" : choice === "3" ? "P3" : null;

        if (!chosen) {
          await sendWhatsAppText(waId, plansMenuText());
          return;
        }

        await setPlan(waId, chosen);

        const existingDoc = await getDoc(waId);
        if (!existingDoc) {
          await setStatus(waId, "WAIT_DOC");
          const fn = firstNameOf(await getFullName(waId));
          await sendWhatsAppText(waId, `Perfeito${fn ? `, ${fn}` : ""}! Agora vamos ativar seu plano 🙂`);
          await sendWhatsAppText(waId, "Me envie seu CPF ou CNPJ (somente números).\nÉ só para registrar o pagamento.");
          return;
        }

        // já tem doc -> cria assinatura
        await setStatus(waId, "PENDING");
        try {
          const pay = await createSubscriptionAndGetPayLink(waId, chosen);
          if (pay.invoiceUrl) {
            await sendWhatsAppText(waId, `✅ Aqui está o link para ativar seu plano:\n${pay.invoiceUrl}\n\nAssim que o pagamento for confirmado, eu libero automaticamente ✅`);
          } else {
            await sendWhatsAppText(waId, "Criei sua assinatura, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico ✅");
          }
        } catch {
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
        }
        return;
      }

      // 2) receber doc
      if (status === "WAIT_DOC") {
        const doc = normalizeDocOnlyDigits(text);
        if (!isValidCPFOrCNPJ(doc)) {
          await sendWhatsAppText(waId, "Não consegui validar. Envie CPF (11 dígitos) ou CNPJ (14 dígitos), *somente números*.");
          return;
        }

        await setDoc(waId, doc);
        await setStatus(waId, "PENDING");

        try {
          const chosen = (await getPlan(waId)) || "P1";
          const pay = await createSubscriptionAndGetPayLink(waId, chosen);
          if (pay.invoiceUrl) {
            await sendWhatsAppText(waId, `✅ Aqui está o link para ativar seu plano:\n${pay.invoiceUrl}\n\nAssim que o pagamento for confirmado, eu libero automaticamente ✅`);
          } else {
            await sendWhatsAppText(waId, "Criei sua assinatura, mas não consegui obter o link automaticamente. Me chama aqui que eu verifico ✅");
          }
        } catch (e) {
          // nunca logar doc; e não retornar detalhes
          console.error("Erro criando assinatura Asaas.");
          await setStatus(waId, "BLOCKED");
          await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3).");
        }
        return;
      }
    }

    // ===================== CHECAR LIMITE (TRIAL ou ACTIVE) =====================
    // Só cobra “descrição” quando a gente decide que é “nova sessão”
    // Refinamentos até 3 não cobram.
    const draft = await getDraft(waId);
    const refines = await getRefineCount(waId);

    // Se não existe draft ainda -> isso é uma NOVA descrição
    const isNewDescription = !draft;

    // Se existe draft -> pode ser refinamento OU pode ser novo produto
    // Heurística: se a pessoa escreveu algo bem diferente e sem relação com "título/emoji" etc,
    // você pode mandar "Se é outro produto, escreva 'novo'".
    // Mantemos simples: se há draft, tudo vira refinamento até ela dizer "novo" ou "gostei".
    const feedbackPositive = isPositiveFeedback(text);
    const feedbackNegative = isNegativeFeedback(text);

    if (feedbackPositive) {
      // finaliza sessão, limpa tudo
      await clearDraft(waId);
      await clearRefineCount(waId);
      await clearLastDescription(waId);

      await sendWhatsAppText(waId, "Boa! ✅ Se quiser fazer outro produto, me mande agora (ex.: “brigadeiro gourmet R$10”).");
      return;
    }

    // ===================== CONSUMO DE COTA =====================
    // Regra: nova descrição consome 1.
    // Refinamento:
    // - se refines < 3 -> não consome
    // - se refines >= 3 -> consome nova descrição e zera contador (vira “nova descrição”)
    let willConsume = false;
    let willResetRefines = false;

    if (isNewDescription) {
      willConsume = true;
    } else {
      // é refinamento
      if (refines >= MAX_FREE_REFINES_PER_DESCRIPTION) {
        willConsume = true;           // cobra mais 1 descrição
        willResetRefines = true;      // zera e recomeça refinamentos
      }
    }

    if (willConsume) {
      const check = await canConsumeDescription(waId, status, planCode);
      if (!check.ok) {
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, limitMessage(status, planCode, check.used ?? check.limit, check.limit));
        return;
      }
      // Se é trial e estourou exatamente agora, a próxima interação bloqueia; aqui só segue.
      // (se quiser avisar “uso X/Y”, dá pra mandar uma msg extra)
    }

    // ===================== ATUALIZAR DRAFT =====================
    let nextDraft = draft || emptyDraft();
    nextDraft = updateDraftFromUserMessage(nextDraft, text);

    // Se a pessoa só mandou “oi” e não tem produto, tenta pedir o mínimo
    if (!nextDraft.product || nextDraft.product.length < 2) {
      await setDraft(waId, nextDraft);
      await sendWhatsAppText(waId, "Me diga qual produto você está vendendo 🙂 (ex.: “bolo de chocolate”, “brigadeiro gourmet”).");
      return;
    }

    // feedbackInstruction: se disse “não gostei...” ou explicou o que quer mudar, usamos isso.
    const feedbackInstruction = (feedbackNegative || (!isNewDescription && text.length <= 200)) ? extractFeedbackInstruction(text) : null;

    // Se vamos resetar refinamentos, recomeça a contagem em 0 (mas mantém draft)
    if (willResetRefines) {
      await setRefineCount(waId, 0);
    }

    // Se é refinamento normal, incrementa refines
    if (!isNewDescription) {
      const newRef = willResetRefines ? 1 : refines + 1;
      await setRefineCount(waId, newRef);
    } else {
      // nova descrição -> começa em 0 refinamentos
      await setRefineCount(waId, 0);
    }

    // salva draft
    await setDraft(waId, nextDraft);

    // ===================== GERAR TEXTO COM IA =====================
    let description;
    try {
      description = await generateSalesDescription({
        fullName: await getFullName(waId),
        draft: nextDraft,
        feedbackInstruction,
      });
    } catch (e) {
      // não expor detalhes; e não logar texto do usuário com CPF
      console.error("Erro OpenAI (geração).");
      await sendWhatsAppText(waId, "Tive um problema para gerar a descrição agora. Tente novamente em instantes 🙂");
      return;
    }

    await setLastDescription(waId, description);

    // 1) mensagem limpa para encaminhar
    await sendWhatsAppText(waId, description);

    // 2) mensagem de feedback separada
    await sendWhatsAppText(waId, askFeedbackText());

    // Se trial acabou exatamente agora, avisa que a próxima exigirá plano
    if (status !== "ACTIVE") {
      const used = await getTrialUses(waId);
      if (used >= FREE_DESCRIPTIONS_LIMIT) {
        await sendWhatsAppText(waId, "✅ Você usou as 5 descrições grátis.\nNa próxima, será necessário escolher um plano.");
      }
    }
  } catch (err) {
    console.error("Erro geral no webhook.");
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

    // idempotência por hash
    const hash = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
    const evtKey = `asaas_evt:${hash}`;
    if (await redisExists(evtKey)) return;
    await redisSetEx(evtKey, "1", TTL_WEEK_SECONDS);

    const eventType = req.body?.event;

    if (eventType === "PAYMENT_RECEIVED" || eventType === "PAYMENT_CONFIRMED") {
      const subscriptionId = req.body?.payment?.subscription;
      if (!subscriptionId) return;

      const waId = await redisGet(`subscription_to_wa:${subscriptionId}`);
      if (!waId) return;

      await setStatus(waId, "ACTIVE");

      const planCode = await getPlan(waId);
      const plan = planCode ? PLANS[planCode] : null;
      const fn = firstNameOf(await getFullName(waId));

      await sendWhatsAppText(
        waId,
        `✅ Pagamento confirmado! Sua assinatura foi ativada${fn ? `, ${fn}` : ""}.\n` +
          (plan ? `Plano: ${plan.name} • ${plan.monthlyLimit} descrições/mês\n\n` : "\n") +
          "Me mande o produto que você quer vender 🙂"
      );
      return;
    }

    if (eventType === "SUBSCRIPTION_INACTIVATED") {
      const subId = req.body?.subscription?.id;
      if (!subId) return;

      const waId = await redisGet(`subscription_to_wa:${subId}`);
      if (!waId) return;

      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, "⚠️ Sua assinatura foi inativada.\n\n" + plansMenuText());
    }
  } catch {
    console.error("Erro webhook Asaas.");
  }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log("USE_UPSTASH =", USE_UPSTASH);
});
