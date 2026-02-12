import express from "express";

const app = express();
app.use(express.json());

// ====== CONFIG ======
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo da Venda no Zap webhook rodando");
});

/**
 * Webhook de verificação (Meta chama via GET)
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

// ====== FUNÇÃO PARA ENVIAR MENSAGEM ======
async function sendWhatsAppText(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltou ACCESS_TOKEN ou PHONE_NUMBER_ID no Render.");
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

  const data = await resp.json();

  if (!resp.ok) {
    console.error("Erro ao enviar mensagem:", resp.status, data);
  } else {
    console.log("Mensagem enviada com sucesso:", data);
  }
}

/**
 * Webhook de eventos (mensagens e status)
 */
app.post("/webhook", async (req, res) => {
  try {
    console.log("Evento recebido:", JSON.stringify(req.body));

    // Confirma recebimento rápido (Meta gosta disso)
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Se não for mensagem, sai
    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const metaPhoneId = value?.metadata?.phone_number_id;

if (metaPhoneId !== process.env.PHONE_NUMBER_ID) {
  console.log("Evento de teste ignorado (phone_number_id diferente):", metaPhoneId);
  return;
}
    
    const msg = messages[0];

    // Evita responder coisas que não são texto (por enquanto)
    if (msg.type !== "text") {
      const from = msg.from;
      await sendWhatsAppText(from, "Por enquanto eu respondo só texto 🙂 Me manda o que você quer vender em mensagem!");
      return;
    }

    const from = msg.from; // número do cliente (formato wa_id)
    const text = msg.text?.body?.trim() || "";

    // Resposta simples de teste
    const reply =
      `Fechado! ✅\n` +
      `Recebi: "${text}"\n\n` +
      `Agora me diga:\n` +
      `1) O que é o produto?\n` +
      `2) Preço?\n` +
      `3) Cidade/entrega?\n` +
      `4) Tom (direto / técnico / emocional)\n`;

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("Erro no webhook:", err);
    // Se der erro antes do res.sendStatus(200), pode responder 200 mesmo assim
    // mas como já respondemos acima, aqui só loga.
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
