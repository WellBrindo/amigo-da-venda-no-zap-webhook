// src/routes/webhook.js
// ✅ V16.4.8 — Webhook robusto + campanhas padronizadas no broadcast.js
import { Router } from "express";

import { touch24hWindow } from "../services/window24h.js";
import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import { handleInboundText } from "../services/flow.js";
import { processPendingForWaId } from "../services/broadcast.js";
import { redisGet, redisSet, redisExpire } from "../services/redis.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
            // ✅ Deduplicação (Meta pode reenviar o mesmo message.id)
            const messageId = String(msg?.id || "").trim();
            if (messageId) {
              const dedupeKey = `wa:msg:${messageId}`;
              try {
                const seen = await redisGet(dedupeKey);
                if (seen) continue;
                await redisSet(dedupeKey, "1");
                await redisExpire(dedupeKey, 60 * 60 * 24 * 2); // 2 dias
              } catch (err) {
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    tag: "wa_dedupe_failed",
                    waId: String(waId),
                    messageId,
                    error: String(err?.message || err),
                  })
                );
              }
            }

            // 1) marca janela 24h
            await touch24hWindow(String(waId));

            // ✅ 1.1) processa campanhas pendentes (padronizado em broadcast.js)
            // (não interfere no fluxo: envia mensagens adicionais se houver)
            try {
              await processPendingForWaId(String(waId));
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

            // 4) responde se necessário (suporta múltiplas mensagens)
            if (r?.shouldReply) {
              const replies = Array.isArray(r?.replies) && r.replies.length
                ? r.replies
                : (r?.replyText ? [r.replyText] : []);

              for (const t of replies) {
                const msgText = String(t || "").trim();
                if (!msgText) continue;

                try {
                  await sendWhatsAppText({ to: String(waId), text: msgText });
                } catch (err) {
                  console.warn(
                    JSON.stringify({
                      level: "warn",
                      tag: "send_whatsapp_reply_failed",
                      waId: String(waId),
                      error: String(err?.message || err),
                    })
                  );
                }

                // pequena pausa para evitar rate-limit e manter a ordem
                await sleep(80);
              }
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
