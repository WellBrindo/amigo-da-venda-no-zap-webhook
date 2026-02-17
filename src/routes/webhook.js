// src/routes/webhook.js
import { Router } from "express";

import { touch24hWindow } from "../services/window24h.js";
import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import { handleInboundText } from "../services/flow.js";
import { processPendingCampaignsForUser } from "../services/campaigns.js";

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
      process.env.VERIFYTOKEN ||
      "";

    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(String(challenge));
    }

    return res.status(403).send("Forbidden");
  });

  // ✅ Recebimento de eventos
  router.post("/", async (req, res) => {
    // responde rápido para a Meta
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
            const waId = msg?.from || value?.contacts?.[0]?.wa_id || "";
            if (!waId) continue;

            // 1) marca janela 24h
            await touch24hWindow(String(waId));

            // ✅ 1.1) processa campanhas pendentes (se entrar na janela)
            // (não interfere no fluxo: envia mensagens adicionais se houver)
            try {
              await processPendingCampaignsForUser(String(waId));
            } catch (err) {
              console.warn(
                JSON.stringify({
                  level: "warn",
                  tag: "process_pending_campaigns_failed",
                  waId: String(waId),
                  error: String(err?.message || err),
                })
              );
            }

            // 2) pega texto inbound (só texto por enquanto)
            let inboundText = "";
            if (msg?.type === "text") {
              inboundText = String(msg?.text?.body || "").trim();
            }
            if (!inboundText) continue;

            // 3) roteia para o motor de fluxo
            const r = await handleInboundText({ waId: String(waId), text: inboundText });

            // 4) responde se necessário
            if (r?.shouldReply && r?.replyText) {
              await sendWhatsAppText({ to: String(waId), text: String(r.replyText) });
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
