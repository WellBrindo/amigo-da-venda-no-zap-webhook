import express from "express";
import crypto from "crypto";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer para validação de assinatura da Meta
    },
  })
);

// ====== CONFIG ======
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

const FREE_USES_LIMIT = Number(process.env.FREE_USES_LIMIT || 5);

// ====== PLANOS ======
const PLANS = {
  P1: { code: "P1", name: "De Vez em Quando", price: 24.9, limitType: "DAILY", dailyLimit: 5, monthlyLimit: null },
  P2: { code: "P2", name: "Sempre por Perto", price: 34.9, limitType: "DAILY", dailyLimit: 10, monthlyLimit: null },
  P3: { code: "P3", name: "Melhor Amigo", price: 54.9, limitType: "MONTHLY", dailyLimit: null, monthlyLimit: 500 },
};

const TTL_DAY_SECONDS = 26 * 60 * 60;
const TTL_MONTH_SECONDS = 40 * 24 * 60 * 60;

// ====== HEALTH ======
app.get("/", (_req, res) => res.status(200).send("OK - Amigo das Vendas no Zap rodando"));

// ====== META VERIFY ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== META SIGNATURE ======
function isValidMetaSignature(req) {
  if (!APP_SECRET) {
    console.warn("⚠️ APP_SECRET não configurado: assinatura da Meta NÃO será validada.");
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

// ====== UPSTASH HELPERS ======
async function upstashCmd(cmdArr) {
  if (!USE_UPSTASH) throw new Error("Upstash não configurado.");
  const url = `${UPSTASH_REDIS_REST_URL}/${cmdArr.map(encodeURIComponent).join("/")}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upstash ${resp.status}: ${JSON.stringify(data)}`);
  return data?.result;
}

const redisGet = async (k) => (await upstashCmd(["GET", k])) ?? null;
const redisSet = async (k, v) => upstashCmd(["SET", k, String(v)]);
const redisSetEx = async (k, v, ex) => upstashCmd(["SET", k, String(v), "EX", String(ex)]);
const redisExists = async (k) => Number((await upstashCmd(["EXISTS", k])) || 0) > 0;
const redisIncr = async (k) => Number((await upstashCmd(["INCR", k])) || 0);
const redisDel = async (k) => upstashCmd(["DEL", k]);

// ====== TIME SP ======
function spYYYYMMDD() {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}${map.month}${map.day}`;
}
function spYYYYMM() {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });
  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}${map.month}`;
}

// ====== WHATSAPP SEND ======
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID.", { hasAccessToken: Boolean(ACCESS_TOKEN), phoneNumberId: PHONE_NUMBER_ID || null });
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
  if (!resp.ok) console.error("Erro ao enviar mensagem:", resp.status, data);
  else console.log("Mensagem enviada com sucesso:", data);
}

// ====== TEXTOS ======
function askNameText() {
  return "Olá! Eu sou o Amigo das Vendas no Zap 🤝\nPra eu te atender direitinho, me diga seu *nome completo* 🙂";
}

function plansMenuText() {
  return (
    "Você já utilizou as 5 utilizações grátis do Amigo das Vendas no Zap.\n\n" +
    "Para continuar usando, escolha um plano:\n\n" +
    "1) 🤝 De Vez em Quando — R$ 24,90/mês\n" +
    "   • 5 envios por dia\n" +
    "   • Apenas texto\n\n" +
    "2) 💬 Sempre por Perto ⭐ — R$ 34,90/mês\n" +
    "   • 10 envios por dia\n" +
    "   • Texto + Áudio\n\n" +
    "3) 🚀 Melhor Amigo — R$ 54,90/mês\n" +
    "   • 500 envios por mês (sem limite diário)\n" +
    "   • Texto + Áudio + Imagem\n\n" +
    "Responda com 1, 2 ou 3."
  );
}

function limitReachedText(plan) {
  if (plan.limitType === "DAILY") {
    return `✅ Você atingiu o limite de hoje do plano ${plan.name} (${plan.dailyLimit} envios/dia).\nAmanhã os envios liberam automaticamente.`;
  }
  return `✅ Você atingiu o limite do mês do plano ${plan.name} (${plan.monthlyLimit} envios/mês).\nNo próximo mês os envios liberam automaticamente.`;
}

function firstNameOf(fullName) {
  const t = String(fullName || "").trim();
  if (!t) return "";
  return t.split(/\s+/)[0] || "";
}

function baseReplyText(fullName, receivedText) {
  const fn = firstNameOf(fullName);
  const greet = fn ? `Fechado, ${fn}! ✅` : "Fechado! ✅";
  return (
    `${greet}\n` +
    `Recebi: "${receivedText}"\n\n` +
    `Agora me diga:\n` +
    `1) O que é o produto?\n` +
    `2) Preço?\n` +
    `3) Cidade/entrega?\n` +
    `4) Tom (direto / técnico / emocional)\n`
  );
}

function normalizeDocOnlyDigits(input) {
  return String(input || "").replace(/\D/g, "");
}
function isValidCPFOrCNPJ(doc) {
  const d = normalizeDocOnlyDigits(doc);
  return d.length === 11 || d.length === 14;
}

function looksLikeFullName(text) {
  const t = String(text || "").trim();
  if (t.length < 5) return false;
  if (!t.includes(" ")) return false; // pelo menos 2 palavras
  if (/^\d+$/.test(t.replace(/\s+/g, ""))) return false;
  return true;
}

// ====== STATE (REDIS) ======
// status: TRIAL | BLOCKED | WAIT_NAME | WAIT_DOC | PENDING | ACTIVE
const getStatus = async (waId) => (await redisGet(`status:${waId}`)) || "TRIAL";
const setStatus = async (waId, s) => redisSet(`status:${waId}`, s);

const getPlan = async (waId) => (await redisGet(`plan:${waId}`)) || null;
const setPlan = async (waId, p) => redisSet(`plan:${waId}`, p);

const getTrialUses = async (waId) => Number((await redisGet(`trial_uses:${waId}`)) || 0);
const incrTrialUses = async (waId) => redisIncr(`trial_uses:${waId}`);

const setDoc = async (waId, doc) => redisSet(`doc:${waId}`, doc);
const getDoc = async (waId) => (await redisGet(`doc:${waId}`)) || null;

const setFullName = async (waId, name) => redisSet(`full_name:${waId}`, name);
const getFullName = async (waId) => (await redisGet(`full_name:${waId}`)) || null;

const setPhone = async (waId) => redisSet(`phone:${waId}`, waId);

const setReturnStatus = async (waId, s) => redisSet(`return_status:${waId}`, s);
const getReturnStatus = async (waId) => (await redisGet(`return_status:${waId}`)) || null;
const clearReturnStatus = async (waId) => redisDel(`return_status:${waId}`);

// ====== LIMITS ======
async function canConsumePlanUsage(waId, planCode) {
  const plan = PLANS[planCode];
  if (!plan) return { ok: false, reason: "no_plan" };

  if (plan.limitType === "DAILY") {
    const key = `uses_day:${waId}:${spYYYYMMDD()}`;
    if (!(await redisExists(key))) await redisSetEx(key, 0, TTL_DAY_SECONDS);

    const current = Number((await redisGet(key)) || 0);
    if (current >= plan.dailyLimit) return { ok: false, reason: "daily_limit", current };

    const next = await redisIncr(key);
    return { ok: true, current: next };
  }

  const key = `uses_month:${waId}:${spYYYYMM()}`;
  if (!(await redisExists(key))) await redisSetEx(key, 0, TTL_MONTH_SECONDS);

  const current = Number((await redisGet(key)) || 0);
  if (current >= plan.monthlyLimit) return { ok: false, reason: "monthly_limit", current };

  const next = await redisIncr(key);
  return { ok: true, current: next };
}

// ====== ASAAS ======
async function asaasFetch(path, { method = "GET", body = null } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY não configurada no Render.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
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

// ✅ Asaas: atualizar cliente existente é PUT :contentReference[oaicite:1]{index=1}
async function updateAsaasCustomerDoc(customerId, cpfCnpj) {
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

  if (!created?.id) throw new Error("Asaas não retornou customer id.");
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

  if (!sub?.id) throw new Error("Asaas não retornou subscription id.");

  await redisSet(`subscription_to_wa:${sub.id}`, waId);
  await redisSet(`asaas_subscription:${waId}`, sub.id);

  const payments = await asaasFetch(`/v3/subscriptions/${sub.id}/payments`, { method: "GET" });
  const first = payments?.data?.[0] || null;

  return { subscriptionId: sub.id, paymentId: first?.id || null, invoiceUrl: first?.invoiceUrl || null };
}

// ====== META WEBHOOK ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("[POST] /webhook");
    console.log("USE_UPSTASH =", USE_UPSTASH);
    if (!USE_UPSTASH) return console.error("❌ Upstash não configurado.");

    if (!isValidMetaSignature(req)) return console.log("❌ Assinatura inválida da Meta. Ignorando.");

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();
    if (metaPhoneId === "123456123") return; // mock do painel
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    if (value?.statuses?.length) {
      console.log("Status recebido:", value.statuses[0]);
      return;
    }

    const msg = value?.messages?.[0];
    if (!msg) return;

    console.log("Evento recebido:", JSON.stringify(req.body));

    const waId = msg.from;
    const messageId = msg.id;

    // Salva telefone (waId)
    await setPhone(waId);

    // idempotência
    if (messageId) {
      const k = `processed:${messageId}`;
      if (await redisExists(k)) return;
      await redisSetEx(k, "1", 48 * 60 * 60);
    }

    const text = msg.type === "text" ? (msg.text?.body?.trim() || "") : "";

    const status = await getStatus(waId);
    const fullName = await getFullName(waId);
    const planCode = await getPlan(waId);

    // ======= NOME PRIMEIRO =======
    if (!fullName && status !== "WAIT_NAME") {
      await setReturnStatus(waId, status);
      await setStatus(waId, "WAIT_NAME");
      await sendWhatsAppText(waId, askNameText());
      return;
    }

    if (status === "WAIT_NAME") {
      if (!looksLikeFullName(text)) {
        await sendWhatsAppText(waId, "Me diga seu *nome completo* 🙂 (ex.: João da Silva)");
        return;
      }

      await setFullName(waId, text);
      const backTo = (await getReturnStatus(waId)) || "TRIAL";
      await clearReturnStatus(waId);
      await setStatus(waId, backTo);

      const fn = firstNameOf(text);
      await sendWhatsAppText(waId, `Prazer${fn ? `, ${fn}` : ""}! ✅ Agora me diga: o que você quer vender?`);
      return;
    }

    const nameNow = (await getFullName(waId)) || null;

    // ===== ACTIVE =====
    if (status === "ACTIVE") {
      const plan = PLANS[planCode];
      if (!plan) return sendWhatsAppText(waId, "Sua assinatura está ativa, mas não identifiquei seu plano. Fale com o suporte.");

      const consume = await canConsumePlanUsage(waId, planCode);
      if (!consume.ok) return sendWhatsAppText(waId, limitReachedText(plan));

      if (msg.type !== "text") return sendWhatsAppText(waId, "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!");

      return sendWhatsAppText(waId, baseReplyText(nameNow, text));
    }

    // ===== WAIT_DOC =====
    if (status === "WAIT_DOC") {
      const doc = normalizeDocOnlyDigits(text);
      if (!isValidCPFOrCNPJ(doc)) {
        return sendWhatsAppText(waId, "Não consegui validar. Envie CPF (11 dígitos) ou CNPJ (14 dígitos), somente números.");
      }

      await setDoc(waId, doc);
      await setStatus(waId, "PENDING");

      try {
        const pay = await createSubscriptionAndGetPayLink(waId, planCode);

        if (pay.invoiceUrl) {
          await sendWhatsAppText(
            waId,
            `✅ Perfeito! Aqui está o link para ativar seu plano:\n${pay.invoiceUrl}\n\nAssim que o pagamento for confirmado, eu libero automaticamente ✅`
          );
        } else {
          await sendWhatsAppText(waId, "Eu criei sua assinatura, mas não consegui obter o link automaticamente. Me avise aqui que eu verifico e te envio ✅");
        }
      } catch (e) {
        console.error("Erro criando assinatura Asaas (após doc):", e);
        await setStatus(waId, "BLOCKED");
        await sendWhatsAppText(waId, "Tive um problema ao gerar o pagamento. Responda novamente com 1, 2 ou 3.");
      }
      return;
    }

    // ===== BLOCKED ou PENDING =====
    if (status === "BLOCKED" || status === "PENDING") {
      const choice = text.replace(/[^\d]/g, "");
      const chosen = choice === "1" ? "P1" : choice === "2" ? "P2" : choice === "3" ? "P3" : null;

      if (!chosen) return sendWhatsAppText(waId, plansMenuText());

      await setPlan(waId, chosen);

      const existingDoc = await getDoc(waId);
      if (!existingDoc) {
        await setStatus(waId, "WAIT_DOC");

        const fn = firstNameOf(nameNow);
        await sendWhatsAppText(waId, `Perfeito${fn ? `, ${fn}` : ""}! Agora vamos ativar seu plano 🙂`);
        await sendWhatsAppText(waId, "Me envie seu CPF ou CNPJ (somente números).\nÉ só para registrar o pagamento.");
        return;
      }

      await setStatus(waId, "PENDING");

      try {
        const pay = await createSubscriptionAndGetPayLink(waId, chosen);

        const fn = firstNameOf(nameNow);
        let msgPay = `Perfeito${fn ? `, ${fn}` : ""}! ✅ Você escolheu o plano ${PLANS[chosen].name} (R$ ${PLANS[chosen].price.toFixed(2)}/mês).\n\n`;
        msgPay += pay.invoiceUrl ? `Pague pelo link para ativar:\n${pay.invoiceUrl}\n\n` : "Assinatura criada, mas não consegui obter o link automaticamente.\n\n";
        msgPay += "Assim que o pagamento for confirmado, eu libero automaticamente ✅";

        await sendWhatsAppText(waId, msgPay);
      } catch (e) {
        console.error("Erro criando assinatura Asaas:", e);
        await setStatus(waId, "WAIT_DOC");

        const fn = firstNameOf(nameNow);
        await sendWhatsAppText(waId, `Perfeito${fn ? `, ${fn}` : ""}! Agora vamos ativar seu plano 🙂`);
        await sendWhatsAppText(waId, "Me envie seu CPF ou CNPJ (somente números).\nÉ só para registrar o pagamento.");
      }
      return;
    }

    // ===== TRIAL =====
    // Trial só conta depois de ter nome salvo (já garantimos acima)
    const used = await getTrialUses(waId);
    if (used >= FREE_USES_LIMIT) {
      await setStatus(waId, "BLOCKED");
      return sendWhatsAppText(waId, plansMenuText());
    }

    const newUsed = await incrTrialUses(waId);

    if (msg.type !== "text") {
      await sendWhatsAppText(waId, "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!");
    } else {
      await sendWhatsAppText(waId, baseReplyText(nameNow, text));
    }

    if (newUsed >= FREE_USES_LIMIT) {
      await sendWhatsAppText(waId, `✅ Utilização registrada: ${newUsed}/${FREE_USES_LIMIT}.\nA próxima interação exigirá um plano para continuar.`);
    }
  } catch (err) {
    console.error("Erro no webhook Meta:", err);
  }
});

// ====== ASAAS WEBHOOK ======
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("[POST] /asaas/webhook", JSON.stringify(req.body));

    if (ASAAS_WEBHOOK_TOKEN) {
      const token = req.get("asaas-access-token");
      if (token !== ASAAS_WEBHOOK_TOKEN) {
        console.log("❌ Asaas webhook rejeitado: token inválido.");
        return;
      }
    } else {
      console.warn("⚠️ ASAAS_WEBHOOK_TOKEN não configurado: webhook Asaas sem validação.");
    }

    // idempotência por hash do payload
    const hash = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
    const evtKey = `asaas_evt:${hash}`;
    if (await redisExists(evtKey)) return;
    await redisSetEx(evtKey, "1", 7 * 24 * 60 * 60);

    const eventType = req.body?.event;

    if (eventType === "PAYMENT_RECEIVED" || eventType === "PAYMENT_CONFIRMED") {
      const subscriptionId = req.body?.payment?.subscription;
      if (!subscriptionId) return;

      const waId = await redisGet(`subscription_to_wa:${subscriptionId}`);
      if (!waId) return;

      await setStatus(waId, "ACTIVE");

      const planCode = await getPlan(waId);
      const plan = planCode ? PLANS[planCode] : null;

      const fullName = await getFullName(waId);
      const fn = firstNameOf(fullName);

      await sendWhatsAppText(
        waId,
        `✅ Pagamento confirmado! Sua assinatura foi ativada${fn ? `, ${fn}` : ""}.\n` +
          (plan
            ? `Plano: ${plan.name}\n` +
              (plan.limitType === "DAILY" ? `Limite: ${plan.dailyLimit} envios/dia\n\n` : `Limite: ${plan.monthlyLimit} envios/mês\n\n`)
            : "\n") +
          "Pode me mandar sua próxima solicitação 🙂"
      );
      return;
    }

    if (eventType === "SUBSCRIPTION_INACTIVATED") {
      const subId = req.body?.subscription?.id;
      if (!subId) return;

      const waId = await redisGet(`subscription_to_wa:${subId}`);
      if (!waId) return;

      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, "⚠️ Sua assinatura foi inativada. Para continuar, escolha um plano novamente:\n\n" + plansMenuText());
    }
  } catch (err) {
    console.error("Erro webhook Asaas:", err);
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log("USE_UPSTASH =", USE_UPSTASH);
  console.log("PHONE_NUMBER_ID =", PHONE_NUMBER_ID);
});
