import { Router } from "express";
import { touch24hWindow } from "../services/window24h.js";

export function webhookRouter() {
  const router = Router();

  // ✅ Verificação do Webhook (Meta)
  // Meta chama: GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(String(challenge));
    }

    return res.status(403).send("Forbidden");
  });

  // ✅ Recebimento de eventos
  router.post("/", async (req, res) => {
    try {
      // Sempre responde rápido para a Meta não re-tentar
      res.status(200).json({ ok: true });

      const body = req.body || {};

      // Estrutura típica:
      // body.entry[].changes[].value.messages[]
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

            if (waId) {
              // Marca janela 24h (inbound = usuário ativo)
              await touch24hWindow(String(waId));
            }
          }
        }
      }
    } catch (err) {
      // Não pode quebrar o webhook — mas aqui já respondemos 200.
      console.error("Webhook error:", err?.message || err);
    }
  });

  return router;
}
