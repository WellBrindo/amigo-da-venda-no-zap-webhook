import express from "express";

const app = express();
app.use(express.json());

// ====== CONFIG (com trim para evitar espaços/quebras de linha no Render) ======
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo da Venda no Zap webhook rodando");
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

/**
 * Webhook de eventos (mensagens e status)
 */
app.post("/webhook", async (req, res) => {
  // Responde 200 rápido (Meta gosta disso)
  res.sendStatus(200);

  try {
    console.log("Evento recebido:", JSON.stringify(req.body));

    // Logs úteis para diagnosticar ENV (aparece no Render)
    console.log("ENV PHONE_NUMBER_ID =", JSON.stringify(process.env.PHONE_NUMBER_ID));
    console.log("PHONE_NUMBER_ID (trim) =", PHONE_NUMBER_ID);

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Se não tiver value, sai
    if (!value) return;

    // Pega phone_number_id do evento
    const metaPhoneId = String(value?.metadata?.phone_number_id || "").trim();

    // 1) Ignora apenas o MOCK do painel (teste "Incoming Message" etc.)
    //    Esses eventos usam phone_number_id tipo 123456123 e NÃO representam o seu número real.
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

    // Se não for mensagem, sai (ex.: status)
    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];

    // Evita loop: não responda mensagens que você mesmo enviou
    // (alguns cenários podem retornar eco dependendo da config)
    if (msg.from === PHONE_NUMBER_ID) {
      console.log("Ignorado: mensagem originada do próprio número.");
      return;
    }

    const from = msg.from; // número do cliente (wa_id)

    // Por enquanto: responde só texto
    if (msg.type !== "text") {
      await sendWhatsAppText(
        from,
        "Por enquanto eu respondo só texto 🙂 Me manda em texto o que você quer vender!"
      );
      return;
    }

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
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
