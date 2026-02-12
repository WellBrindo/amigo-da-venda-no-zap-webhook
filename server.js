/**
 * Amigo das Vendas no Zap — webhook WhatsApp Cloud API + Upstash + Asaas
 * Fluxo:
 * - TRIAL: 5 utilizações grátis (FREE_USES_LIMIT)
 * - BLOCKED: mostra menu de planos 1/2/3 e cria assinatura no Asaas
 * - ACTIVE: aplica limites por plano (P1/P2 diário, P3 mensal)
 *
 * ENV obrigatórias (Render):
 * - ACCESS_TOKEN              (Meta / WhatsApp Cloud API)
 * - PHONE_NUMBER_ID           (Meta)
 * - VERIFY_TOKEN              (Meta Webhook Verify)
 * - APP_SECRET                (Meta App Secret)  [recomendado]
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 * - ASAAS_API_KEY
 * - ASAAS_WEBHOOK_TOKEN       (o mesmo que você cadastrou no Webhook do Asaas)
 *
 * Opcional:
 * - FREE_USES_LIMIT (default 5)
 * - ASAAS_BASE_URL  (default https://api.asaas.com)
 */

import express from "express";
import crypto from "crypto";

const app = express();

/** Captura raw body (para validar assinatura da Meta) */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
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
  P1: {
    code: "P1",
    name: "De Vez em Quando",
    price: 24.9,
    limitType: "DAILY",
    dailyLimit: 5,
    monthlyLimit: null,
  },
  P2: {
    code: "P2",
    name: "Sempre por Perto",
    price: 34.9,
    limitType: "DAILY",
    dailyLimit: 10,
    monthlyLimit: null,
  },
  P3: {
    code: "P3",
    name: "Melhor Amigo",
    price: 54.9,
    limitType: "MONTHLY",
    dailyLimit: null,
    monthlyLimit: 500,
  },
};

// TTLs “folgados” para garantir virada
const TTL_DAY_SECONDS = 26 * 60 * 60; // 26h
const TTL_MONTH_SECONDS = 40 * 24 * 60 * 60; // ~40 dias

// ====== HEALTH ======
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap rodando");
});

// ====== META VERIFY (GET /webhook) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== META SIGNATURE ======
function isValidMetaSignature(req) {
  // Se não tiver APP_SECRET, não bloqueia (mas recomendo configurar!)
  if (!APP_SECRET) {
    console.warn("⚠️ APP_SECRET não configurado: assinatura da Meta NÃO será validada.");
    return true;
  }

  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ====== UPSTASH HELPERS ======
async function upstashCmd(cmdArr) {
  if (!USE_UPSTASH) throw new Error("Upstash não configurado.");
  const url = `${UPSTASH_REDIS_REST_URL}/${cmdArr.map(encodeURIComponent).join("/")}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upstash ${resp.status}: ${JSON.stringify(data)}`);
  return data?.result;
}

async function redisGet(key) {
  const v = await upstashCmd(["GET", key]);
  return v ?? null;
}

async function redisSet(key, value) {
  await upstashCmd(["SET", key, String(value)]);
}

async function redisSetEx(key, value, exSeconds) {
  await upstashCmd(["SET", key, String(value), "EX", String(exSeconds)]);
}

async function redisExists(key) {
  const n = await upstashCmd(["EXISTS", key]);
  return Number(n || 0) > 0;
}

async function redisIncr(key) {
  const n = await upstashCmd(["INCR", key]);
  return Number(n || 0);
}

async function redisDel(key) {
  await upstashCmd(["DEL", key]);
}

// ====== DATA SP ======
function getSPDateParts() {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { yyyy: map.year, mm: map.month, dd: map.day };
}

function spYYYYMMDD() {
  const { yyyy, mm, dd } = getSPDateParts();
  return `${yyyy}${mm}${dd}`;
}

function spYYYYMM() {
  const { yyyy, mm } = getSPDateParts();
  return `${yyyy}${mm}`;
}

// ====== WHATSAPP SEND ======
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID.", {
      hasAccessToken: Boolean(ACCESS_TOKEN),
      phoneNumberId: PHONE_NUMBER_ID || null,
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
      console.error("Erro ao enviar mensagem:", resp.status, data);
    } else {
      console.log("Mensagem enviada com sucesso:", data);
    }
  } catch (err) {
    console.error("Erro de rede ao enviar mensagem:", err);
  }
}

// ====== TEXTOS ======
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
    return (
      `✅ Você atingiu o limite de hoje do plano ${plan.name} (${plan.dailyLimit} envios/dia).\n` +
      "Amanhã os envios liberam automaticamente."
    );
  }
  return (
    `✅ Você atingiu o limite do mês do plano ${plan.name} (${plan.monthlyLimit} envios/mês).\n` +
    "No próximo mês os envios liberam automaticamente."
  );
}

// ====== STATE (REDIS) ======
async function getStatus(waId) {
  return (await redisGet(`status:${waId}`)) || "TRIAL"; // TRIAL | BLOCKED | PENDING | ACTIVE
}

async function setStatus(waId, status) {
  await redisSet(`status:${waId}`, status);
}

async function getPlan(waId) {
  return (await redisGet(`plan:${waId}`)) || null;
}

async function setPlan(waId, planCode) {
  await redisSet(`plan:${waId}`, planCode);
}

async function getTrialUses(waId) {
  return Number((await redisGet(`trial_uses:${waId}`)) || 0);
}

async function incrTrialUses(waId) {
  return await redisIncr(`trial_uses:${waId}`);
}

// ====== LIMIT CHECK + INCR (sem “comer” crédito quando já passou) ======
async function canConsumePlanUsage(waId, planCode) {
  const plan = PLANS[planCode];
  if (!plan) return { ok: false, reason: "no_plan" };

  if (plan.limitType === "DAILY") {
    const key = `uses_day:${waId}:${spYYYYMMDD()}`;

    // garante TTL quando chave nasce
    const exists = await redisExists(key);
    if (!exists) {
      await redisSetEx(key, 0, TTL_DAY_SECONDS);
    }

    const current = Number((await redisGet(key)) || 0);
    if (current >= plan.dailyLimit) return { ok: false, reason: "daily_limit", current };

    const next = await redisIncr(key);
    return { ok: true, current: next };
  }

  // MONTHLY
  const key = `uses_month:${waId}:${spYYYYMM()}`;

  const exists = await redisExists(key);
  if (!exists) {
    await redisSetEx(key, 0, TTL_MONTH_SECONDS);
  }

  const current = Number((await redisGet(key)) || 0);
  if (current >= plan.monthlyLimit) return { ok: false, reason: "monthly_limit", current };

  const next = await redisIncr(key);
  return { ok: true, current: next };
}

// ====== ASAAS HELPERS ======
async function asaasFetch(path, { method = "GET", body = null } = {}) {
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY não configurada no Render.");

  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Asaas usa header access_token
      access_token: ASAAS_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Asaas ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

function nextDueDateISO() {
  // amanhã (evita “vencer hoje” dependendo do horário)
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function getOrCreateAsaasCustomer(waId, name) {
  const key = `asaas_customer:${waId}`;
  const saved = await redisGet(key);
  if (saved) return saved;

  // mínimo necessário
  const created = await asaasFetch("/v3/customers", {
    method: "POST",
    body: {
      name: name || "Cliente WhatsApp",
      phone: waId,
    },
  });

  if (!created?.id) throw new Error("Asaas não retornou customer id.");
  await redisSet(key, created.id);
  return created.id;
}

async function createSubscriptionAndGetPayLink(waId, planCode, profileName) {
  const plan = PLANS[planCode];
  if (!plan) throw new Error("Plano inválido.");

  const customerId = await getOrCreateAsaasCustomer(waId, profileName);

  // cria assinatura (mensal)
  const sub = await asaasFetch("/v3/subscriptions", {
    method: "POST",
    body: {
      customer: customerId,
      billingType: "UNDEFINED", // deixa o Asaas oferecer métodos se habilitado
      nextDueDate: nextDueDateISO(),
      value: plan.price,
      cycle: "MONTHLY",
      description: `Amigo das Vendas no Zap - ${plan.name}`,
    },
  });

  if (!sub?.id) throw new Error("Asaas não retornou subscription id.");

  // salva relação subscription -> waId (essencial pro webhook ativar o cliente certo)
  await redisSet(`subscription_to_wa:${sub.id}`, waId);
  await redisSet(`asaas_subscription:${waId}`, sub.id);

  // pega a 1ª cobrança da assinatura
  const payments = await asaasFetch(`/v3/subscriptions/${sub.id}/payments`, { method: "GET" });
  const first = payments?.data?.[0] || null;

  const invoiceUrl = first?.invoiceUrl || null;
  return { subscriptionId: sub.id, paymentId: first?.id || null, invoiceUrl };
}

// ====== META WEBHOOK (POST /webhook) ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("[POST] /webhook");
    console.log("USE_UPSTASH =", USE_UPSTASH);

    if (!USE_UPSTASH) {
      console.error("❌ Upstash não configurado.");
      return;
    }

    if (!isValidMetaSignature(req)) {
      console.log("❌ Assinatura inválida da Meta. Ignorando evento.");
      return;
    }

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value) return;

    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();
    if (metaPhoneId === "123456123") return; // mock do painel
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) return;

    // STATUS (sent/read/delivered etc.)
    if (value?.statuses?.length) {
      console.log("Status recebido:", value.statuses[0]);
      return;
    }

    const messages = value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    const waId = msg.from;
    const messageId = msg.id;

    console.log("Evento recebido:", JSON.stringify(req.body));

    // idempotência: não processar a mesma msg duas vezes
    if (messageId) {
      const k = `processed:${messageId}`;
      if (await redisExists(k)) return;
      await redisSetEx(k, "1", 48 * 60 * 60);
    }

    const profileName = value?.contacts?.[0]?.profile?.name || null;
    if (profileName) await redisSet(`profile_name:${waId}`, profileName);

    const text = msg.type === "text" ? (msg.text?.body?.trim() || "") : "";

    // ====== STATE MACHINE ======
    const status = await getStatus(waId);
    const planCode = await getPlan(waId);

    // ---------- ACTIVE ----------
    if (status === "ACTIVE") {
      const plan = PLANS[planCode];
      if (!plan) {
        await sendWhatsAppText(waId, "Sua assinatura está ativa, mas não identifiquei seu plano. Fale com o suporte.");
        return;
      }

      const consume = await canConsumePlanUsage(waId, planCode);
      if (!consume.ok) {
        await sendWhatsAppText(waId, limitReachedText(plan));
        return;
      }

      // resposta “base” (você vai evoluir depois)
      if (msg.type !== "text") {
        await sendWhatsAppText(waId, "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!");
        return;
      }

      const reply =
        `Fechado! ✅\n` +
        `Recebi: "${text}"\n\n` +
        `Agora me diga:\n` +
        `1) O que é o produto?\n` +
        `2) Preço?\n` +
        `3) Cidade/entrega?\n` +
        `4) Tom (direto / técnico / emocional)\n`;

      await sendWhatsAppText(waId, reply);
      return;
    }

    // ---------- BLOCKED ou PENDING ----------
    if (status === "BLOCKED" || status === "PENDING") {
      const choice = text.replace(/[^\d]/g, "");
      const chosen =
        choice === "1" ? "P1" : choice === "2" ? "P2" : choice === "3" ? "P3" : null;

      if (!chosen) {
        await sendWhatsAppText(waId, plansMenuText());
        return;
      }

      // cria assinatura e manda link
      try {
        await setPlan(waId, chosen);
        await setStatus(waId, "PENDING");

        const pay = await createSubscriptionAndGetPayLink(waId, chosen, profileName);

        let msgPay =
          `Perfeito! Você escolheu o plano ${PLANS[chosen].name} (R$ ${PLANS[chosen].price.toFixed(2)}/mês).\n\n`;

        if (pay.invoiceUrl) {
          msgPay += `Pague pelo link para ativar:\n${pay.invoiceUrl}\n\n`;
        } else {
          msgPay +=
            "Eu criei sua assinatura, mas não consegui obter o link automaticamente.\n" +
            "Me avise aqui que eu verifico no Asaas e te envio o link.\n\n";
        }

        msgPay += "Assim que o pagamento for confirmado, eu libero automaticamente ✅";

        await sendWhatsAppText(waId, msgPay);
      } catch (e) {
        console.error("Erro criando assinatura Asaas:", e);
        await sendWhatsAppText(
          waId,
          "Tive um problema ao gerar o pagamento agora. Tente novamente em instantes (responda 1, 2 ou 3)."
        );
      }
      return;
    }

    // ---------- TRIAL ----------
    // Se passou dos grátis, bloqueia e mostra menu
    const used = await getTrialUses(waId);
    if (used >= FREE_USES_LIMIT) {
      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(waId, plansMenuText());
      return;
    }

    // Conta uma utilização por mensagem recebida (texto ou não)
    const newUsed = await incrTrialUses(waId);

    if (msg.type !== "text") {
      await sendWhatsAppText(waId, "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!");
    } else {
      const reply =
        `Fechado! ✅\n` +
        `Recebi: "${text}"\n\n` +
        `Agora me diga:\n` +
        `1) O que é o produto?\n` +
        `2) Preço?\n` +
        `3) Cidade/entrega?\n` +
        `4) Tom (direto / técnico / emocional)\n`;

      await sendWhatsAppText(waId, reply);
    }

    // Se acabou o trial agora, avisa e bloqueia na próxima
    if (newUsed >= FREE_USES_LIMIT) {
      await sendWhatsAppText(
        waId,
        `✅ Utilização registrada: ${newUsed}/${FREE_USES_LIMIT}.\nA próxima interação exigirá um plano para continuar.`
      );
    }
  } catch (err) {
    console.error("Erro no webhook Meta:", err);
  }
});

// ====== ASAAS WEBHOOK (POST /asaas/webhook) ======
app.post("/asaas/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("[POST] /asaas/webhook", JSON.stringify(req.body));

    // valida token do Asaas (se você configurou no painel)
    if (ASAAS_WEBHOOK_TOKEN) {
      const token = req.get("asaas-access-token");
      if (token !== ASAAS_WEBHOOK_TOKEN) {
        console.log("❌ Asaas webhook rejeitado: token inválido.");
        return;
      }
    } else {
      console.warn("⚠️ ASAAS_WEBHOOK_TOKEN não configurado: webhook Asaas sem validação.");
    }

    // idempotência simples por hash do evento
    const hash = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
    const evtKey = `asaas_evt:${hash}`;
    if (await redisExists(evtKey)) return;
    await redisSetEx(evtKey, "1", 7 * 24 * 60 * 60);

    const eventType = req.body?.event; // PAYMENT_RECEIVED, PAYMENT_CONFIRMED, SUBSCRIPTION_INACTIVATED, etc.
    const payment = req.body?.payment;

    // Ativar quando pagamento confirmar/receber
    if (
      eventType === "PAYMENT_RECEIVED" ||
      eventType === "PAYMENT_CONFIRMED"
    ) {
      const subscriptionId = payment?.subscription;
      if (!subscriptionId) return;

      const waId = await redisGet(`subscription_to_wa:${subscriptionId}`);
      if (!waId) {
        console.log("Não achei waId para subscription:", subscriptionId);
        return;
      }

      await setStatus(waId, "ACTIVE");

      const planCode = await getPlan(waId);
      const plan = planCode ? PLANS[planCode] : null;

      await sendWhatsAppText(
        waId,
        `✅ Pagamento confirmado! Sua assinatura foi ativada.\n` +
          (plan
            ? `Plano: ${plan.name}\n` +
              (plan.limitType === "DAILY"
                ? `Limite: ${plan.dailyLimit} envios/dia\n\n`
                : `Limite: ${plan.monthlyLimit} envios/mês\n\n`)
            : "\n") +
          "Pode me mandar sua próxima solicitação 🙂"
      );

      return;
    }

    // Se assinatura inativar, bloqueia
    if (eventType === "SUBSCRIPTION_INACTIVATED") {
      const subscription = req.body?.subscription;
      const subId = subscription?.id || null;
      if (!subId) return;

      const waId = await redisGet(`subscription_to_wa:${subId}`);
      if (!waId) return;

      await setStatus(waId, "BLOCKED");
      await sendWhatsAppText(
        waId,
        "⚠️ Sua assinatura foi inativada. Para continuar, escolha um plano novamente:\n\n" + plansMenuText()
      );
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
