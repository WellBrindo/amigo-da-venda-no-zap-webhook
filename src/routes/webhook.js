import { Router } from "express";
import { touch24hWindow } from "../services/window24h.js";
import { sendWhatsAppText } from "../services/meta/whatsapp.js";

export function webhookRouter() {
  const router = Router();

  // ✅ Verificação do Webhook (Meta)
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const VERIFY_TOKEN =
      process.env.WEBHOOK_VERIFY_TOKEN ||
      process.env.VERIFY_TOKEN ||
      process.env.VERIFYTOKEN;

    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(String(challenge));
    }

    return res.status(403).send("Forbidden");
  });

  // ✅ Recebimento de eventos
  router.post("/", async (req, res) => {
    // Responde rápido para a Meta não re-tentar
    res.status(200).json({ ok: true });

    try {
      const body = req.body || {};
      const entry = Array.isArray(body.entry) ? body.entry : [];

      for (const e of entry) {
        const changes = Array.isArray(e.changes) ? e.changes : [];

        for (const ch of changes) {
          const value = ch.value || {};
          const messages = Array.isArray(value.messages) ? value.messages : [];

          for (const msg of messages) {
            const waId =
              msg?.from ||
              value?.contacts?.[0]?.wa_id ||
              "";

            if (!waId) continue;

            // 1) marca janela 24h
            await touch24hWindow(String(waId));

            // 2) pega texto (se for mensagem de texto)
            let inboundText = "";
            if (msg?.type === "text") {
              inboundText = String(msg?.text?.body || "").trim();
            }

            // 3) responde (modo simples)
            // ⚠️ evitamos responder mensagens vazias ou eventos sem texto
            if (inboundText) {
              const reply =
                `👋 Oi! Recebi sua mensagem:\n\n` +
                `“${inboundText}”\n\n` +
                `✅ O sistema modular está ativo.\n` +
                `Em breve vamos ligar o gerador de descrições.`;

              await sendWhatsAppText({ to: waId, text: reply });
            }
          }
        }
      }
    } catch (err) {
      console.error("Webhook error:", err?.message || err);
    }
  });

  return router;
}
