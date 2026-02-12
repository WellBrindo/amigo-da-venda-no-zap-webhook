import express from "express";
import crypto from "crypto";

const app = express();

/**
 * Precisamos capturar o "raw body" para validar assinatura (x-hub-signature-256)
 * Por isso usamos o verify do express.json.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // guarda corpo bruto
    },
  })
);

// ====== CONFIG (com trim para evitar espaços/quebras de linha no Render) ======
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const APP_SECRET = (process.env.APP_SECRET || "").trim();

// Trial por uso
const FREE_USES_LIMIT = Number(process.env.FREE_USES_LIMIT || 5); // default 5

// ====== (OPCIONAL) UPSTASH REDIS VIA REST API ======
// Se você configurar estas env vars no Render, tudo fica persistente:
const UPSTASH_REDIS_REST_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

// ====== FALLBACK EM MEMÓRIA (se não usar Upstash) ======
const memory = {
  processedMsgIds: new Map(), // msgId -> expiresAt (ms)
  userUses: new Map(), // wa_id -> number of used uses
};

// TTLs (fallback)
const PROCESSED_MSG_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10min

setInterval(() => {
  // limpa mensagens processadas vencidas (apenas fallback em memória)
  const now = Date.now();
  for (const [k, exp] of memory.processedMsgIds.entries()) {
    if (exp <= now) memory.processedMsgIds.delete(k);
  }
}, CLEANUP_INTERVAL_MS);

// ====== Health check ======
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo das Vendas no Zap webhook rodando");
});

/**
 * Webhook de verificação (Meta chama via GET)
 * "Verificar token" na tela da Meta = VERIFY_TOKEN (não é ACCESS_TOKEN)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== ASSINATURA (SEGURANÇA) ======
function isValidSignature(req) {
  // Se você ainda não configurou APP_SECRET, não dá pra validar.
  // Recomendo fortemente configurar. Enquanto isso, deixa passar e loga aviso.
  if (!APP_SECRET) {
    console.warn(
      "⚠️ APP_SECRET não configurado. Assinatura não será validada (inseguro). Configure APP_SECRET no Render."
    );
    return true;
  }

  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ====== UPSTASH HELPERS ======
async function upstashCmd(cmdArr) {
  // cmdArr exemplo: ["GET", "key"] ou ["INCR", "key"]
  const url = `${UPSTASH_REDIS_REST_URL}/${cmdArr.map(encodeURIComponent).join("/")}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upstash error ${resp.status}: ${JSON.stringify(data)}`);
  return data?.result;
}

async function getProcessed(incomingMessageId) {
  const key = `processed:${incomingMessageId}`;
  if (USE_UPSTASH) {
    const val = await upstashCmd(["GET", key]);
    return Boolean(val);
  }
  const exp = memory.processedMsgIds.get(incomingMessageId);
  if (!exp) return false;
  if (exp <= Date.now()) {
    memory.processedMsgIds.delete(incomingMessageId);
    return false;
  }
  return true;
}

async function markProcessed(incomingMessageId) {
  const key = `processed:${incomingMessageId}`;
  if (USE_UPSTASH) {
    // SET key "1" EX 172800 (48h)
    await upstashCmd(["SET", key, "1", "EX", String(48 * 60 * 60)]);
    return;
  }
  memory.processedMsgIds.set(incomingMessageId, Date.now() + PROCESSED_MSG_TTL_MS);
}

async function getUses(waId) {
  const key = `uses:${waId}`;
  if (USE_UPSTASH) {
    const val = await upstashCmd(["GET", key]);
    return Number(val || 0);
  }
  return Number(memory.userUses.get(waId) || 0);
}

async function incrementUses(waId) {
  const key = `uses:${waId}`;
  if (USE_UPSTASH) {
    // INCR key
    const newVal = await upstashCmd(["INCR", key]);
    // opcional: manter por muito tempo (não expira). Se quiser expirar em X dias, dá pra setar TTL.
    return Number(newVal || 0);
  }
  const current = Number(memory.userUses.get(waId) || 0);
  const next = current + 1;
  memory.userUses.set(waId, next);
  return next;
}

// ====== FUNÇÃO PARA ENVIAR MENSAGEM ======
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID no Render.", {
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

function blockedMessage() {
  return (
    "Olá! 😊\n" +
    `Você já utilizou as ${FREE_USES_LIMIT} utilizações grátis do Amigo das Vendas no Zap.\n\n` +
    "Para continuar usando, escolha um plano:\n" +
    "1) PIX (Asaas)\n" +
    "2) Cartão\n\n" +
    "Responda com: PIX ou CARTÃO."
  );
}

/**
 * Webhook de eventos (mensagens e status)
 */
app.post("/webhook", async (req, res) => {
  // 1) Responde 200 rápido (Meta gosta disso)
  res.sendStatus(200);

  try {
    // 2) Segurança: valida assinatura
    if (!isValidSignature(req)) {
      console.log("❌ Assinatura inválida - evento rejeitado.");
      return;
    }

    console.log("Evento recebido:", JSON.stringify(req.body));

    // Logs úteis para diagnosticar ENV (aparece no Render)
    console.log("ENV PHONE_NUMBER_ID =", JSON.stringify(process.env.PHONE_NUMBER_ID));
    console.log("PHONE_NUMBER_ID (trim) =", PHONE_NUMBER_ID);
    console.log("USE_UPSTASH =", USE_UPSTASH);

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Se não tiver value, sai
    if (!value) return;

    // Pega phone_number_id do evento
    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();

    // 1) Ignora apenas o MOCK do painel (teste "Incoming Message" etc.)
    if (metaPhoneId === "123456123") {
      console.log("Evento de teste do painel ignorado (mock 123456123).");
      return;
    }

    // 2) Valida evento real: precisa bater com o seu PHONE_NUMBER_ID do Render
    if (metaPhoneId && PHONE_NUMBER_ID && metaPhoneId !== PHONE_NUMBER_ID) {
      console.log("Ignorado: phone_number_id não bate.", {
        recebido: metaPhoneId,
        esperado: PHONE_NUMBER_ID,
      });
      return;
    }

    // ====== A) STATUS (sent/delivered/read/failed) ======
    if (value?.statuses?.length) {
      const st = value.statuses[0];
      console.log("Status recebido:", {
        id: st.id,
        status: st.status,
        timestamp: st.timestamp,
        recipient_id: st.recipient_id,
        pricing: st.pricing,
      });
      // Aqui você pode futuramente salvar status em banco, se quiser.
      return;
    }

    // ====== B) MENSAGENS (entrada do usuário) ======
    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];

    // Idempotência: se já processou esse msg.id, ignora
    const incomingMessageId = msg.id;
    if (incomingMessageId) {
      const already = await getProcessed(incomingMessageId);
      if (already) {
        console.log("Ignorado: mensagem já processada (idempotência).", incomingMessageId);
        return;
      }
      await markProcessed(incomingMessageId);
    }

    // Evita loop: não responda mensagens que você mesmo enviou
    // (normalmente msg.from é o usuário; mas mantemos proteção)
    if (msg.from === PHONE_NUMBER_ID) {
      console.log("Ignorado: mensagem originada do próprio número.");
      return;
    }

    const from = msg.from; // número do cliente (wa_id)

    // ====== Regra: 5 utilizações grátis ======
    const used = await getUses(from);
    if (used >= FREE_USES_LIMIT) {
      console.log(`Bloqueado: ${from} já usou ${used}/${FREE_USES_LIMIT}.`);
      await sendWhatsAppText(from, blockedMessage());
      return;
    }

    // Se não for texto, responde e CONTA uso (você pode mudar essa regra se quiser)
    if (msg.type !== "text") {
      await sendWhatsAppText(
        from,
        "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!"
      );

      const newUsed = await incrementUses(from);
      console.log(`Uso contabilizado (não-texto): ${from} agora ${newUsed}/${FREE_USES_LIMIT}`);
      if (newUsed >= FREE_USES_LIMIT) {
        await sendWhatsAppText(from, blockedMessage());
      }
      return;
    }

    const text = msg.text?.body?.trim() || "";

    // ====== Resposta principal ======
    const reply =
      `Fechado! ✅\n` +
      `Recebi: "${text}"\n\n` +
      `Agora me diga:\n` +
      `1) O que é o produto?\n` +
      `2) Preço?\n` +
      `3) Cidade/entrega?\n` +
      `4) Tom (direto / técnico / emocional)\n`;

    await sendWhatsAppText(from, reply);

    // Conta 1 utilização (porque foi um atendimento "normal")
    const newUsed = await incrementUses(from);
    console.log(`Uso contabilizado: ${from} agora ${newUsed}/${FREE_USES_LIMIT}`);

    // Se acabou de atingir o limite, você pode avisar que a próxima será bloqueada
    if (newUsed === FREE_USES_LIMIT) {
      await sendWhatsAppText(
        from,
        `✅ Utilização registrada: ${newUsed}/${FREE_USES_LIMIT}.\nA próxima interação exigirá um plano para continuar.`
      );
    }
  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
