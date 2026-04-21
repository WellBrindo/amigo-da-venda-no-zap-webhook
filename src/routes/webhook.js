// src/routes/webhook.js
// ✅ V16.6.0 — Webhook hardened for malformed payloads, per-message isolation and operational failure tracking
import { Router } from "express";

import { touch24hWindow } from "../services/window24h.js";
import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import { handleInboundText } from "../services/flow.js";
import { resolveOrCreateUserFromInbound } from "../services/identity.js";
import { processPendingForWaId } from "../services/broadcast.js";
import { redisGet, redisSet, redisExpire } from "../services/redis.js";
import * as audit from "../services/audit.js";
import {
  trackWebhookError,
  trackFlowError,
  trackWhatsappSendError,
} from "../services/metrics.js";

const WEBHOOK_ERROR = Object.freeze({
  PAYLOAD_ERROR: "WEBHOOK_PAYLOAD_ERROR",
  IDENTITY_ERROR: "WEBHOOK_IDENTITY_ERROR",
  IDENTITY_REVIEW_REQUIRED: "WEBHOOK_IDENTITY_REVIEW_REQUIRED",
  DEDUPE_ERROR: "WEBHOOK_DEDUPE_ERROR",
  FLOW_ERROR: "WEBHOOK_FLOW_ERROR",
  SEND_ERROR: "WEBHOOK_SEND_ERROR",
  PENDING_PROCESS_ERROR: "WEBHOOK_PENDING_PROCESS_ERROR",
  WINDOW24H_ERROR: "WEBHOOK_WINDOW24H_ERROR",
  RUNTIME_ERROR: "WEBHOOK_RUNTIME_ERROR",
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStr(value) {
  return String(value ?? "").trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildWebhookMetricContext(extra = {}) {
  const context = {
    source: "webhook_route",
    ...extra,
  };

  Object.keys(context).forEach((key) => {
    if (context[key] === undefined || context[key] === null || context[key] === "") {
      delete context[key];
    }
  });

  return context;
}

async function emitMetricSafe(tracker, payload = {}) {
  if (typeof tracker !== "function") return null;
  try {
    return await tracker(payload);
  } catch {
    return null;
  }
}

async function logWebhookEvent(level, event, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: safeStr(level || "info").toLowerCase(),
    source: "webhook_route",
    module: "webhook_route",
    event: safeStr(event),
    ...payload,
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent({
        module: "webhook_route",
        event: entry.event,
        level: entry.level,
        userId: safeStr(entry.internalUserId || entry.userId),
        waId: safeStr(entry.waId || entry.deliveryId),
        step: safeStr(entry.step),
        message: safeStr(entry.message || entry.reason),
        errorCode: safeStr(entry.errorCode),
        status: safeStr(entry.status),
        meta: {
          messageId: safeStr(entry.messageId),
          deliveryId: safeStr(entry.deliveryId),
          ...((entry.meta && typeof entry.meta === "object") ? entry.meta : {}),
        },
      });
      return;
    }
    if (typeof audit?.logRuntimeError === "function" && (entry.level === "warn" || entry.level === "error" || entry.level === "fatal")) {
      await audit.logRuntimeError({
        module: "webhook_route",
        event: entry.event,
        level: entry.level,
        userId: safeStr(entry.internalUserId || entry.userId),
        waId: safeStr(entry.waId || entry.deliveryId),
        step: safeStr(entry.step),
        message: safeStr(entry.message || entry.reason),
        errorCode: safeStr(entry.errorCode),
        status: safeStr(entry.status),
        meta: {
          messageId: safeStr(entry.messageId),
          deliveryId: safeStr(entry.deliveryId),
          ...((entry.meta && typeof entry.meta === "object") ? entry.meta : {}),
        },
      });
      return;
    }
  } catch {
    // fallback below
  }

  const line = JSON.stringify(entry);
  if (entry.level === "error" || entry.level === "fatal") {
    console.error(line);
    return;
  }
  if (entry.level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

async function reportWebhookError({
  errorCode = WEBHOOK_ERROR.RUNTIME_ERROR,
  message = "",
  step = "",
  userId = "",
  waId = "",
  deliveryId = "",
  messageId = "",
  internalUserId = "",
  metric = trackWebhookError,
  extra = {},
} = {}) {
  const context = buildWebhookMetricContext({
    userId: safeStr(userId || internalUserId || waId),
    waId: safeStr(waId || deliveryId),
    step: safeStr(step),
    errorCode: safeStr(errorCode),
    messageId: safeStr(messageId),
    ...extra,
  });

  await emitMetricSafe(metric, context);
  await logWebhookEvent("warn", "webhook_error", {
    errorCode: safeStr(errorCode),
    message: safeStr(message),
    step: safeStr(step),
    messageId: safeStr(messageId),
    waId: safeStr(waId),
    deliveryId: safeStr(deliveryId),
    internalUserId: safeStr(internalUserId || userId),
    ...extra,
  });
}

async function reportWebhookSuppressed({
  event = "webhook_suppressed",
  errorCode = "",
  message = "",
  step = "",
  userId = "",
  waId = "",
  deliveryId = "",
  messageId = "",
  internalUserId = "",
  extra = {},
} = {}) {
  await logWebhookEvent("info", safeStr(event) || "webhook_suppressed", {
    errorCode: safeStr(errorCode),
    message: safeStr(message),
    step: safeStr(step),
    messageId: safeStr(messageId),
    waId: safeStr(waId),
    deliveryId: safeStr(deliveryId),
    internalUserId: safeStr(internalUserId || userId),
    status: "suppressed",
    ...extra,
  });
}

async function markMessageSeen(messageId) {
  const dedupeKey = `wa:msg:${messageId}`;
  const seen = await redisGet(dedupeKey);
  if (seen) return true;
  await redisSet(dedupeKey, "1");
  await redisExpire(dedupeKey, 60 * 60 * 24 * 2);
  return false;
}

async function sendReplies({ replies = [], deliveryId = "", inboundWaId = "", inboundBsuid = "", internalUserId = "", messageId = "" } = {}) {
  for (const reply of safeArray(replies)) {
    const msgText = safeStr(reply);
    if (!msgText) continue;

    try {
      await sendWhatsAppText({ to: deliveryId, text: msgText });
    } catch (err) {
      await reportWebhookError({
        errorCode: WEBHOOK_ERROR.SEND_ERROR,
        message: err?.message || String(err),
        step: "send_reply",
        waId: inboundWaId,
        deliveryId,
        messageId,
        internalUserId,
        metric: trackWhatsappSendError,
        extra: {
          bsuid: safeStr(inboundBsuid),
        },
      });
    }

    await sleep(80);
  }
}

async function processInboundMessage({ value = {}, msg = {} } = {}) {
  const messageId = safeStr(msg?.id);
  const rawWaId = safeStr(msg?.from || value?.contacts?.[0]?.wa_id);
  const messageType = safeStr(msg?.type).toLowerCase();

  let identity = null;
  let internalUserId = "";
  let inboundWaId = rawWaId;
  let inboundBsuid = "";
  let deliveryId = "";
  let identityConflictId = "";
  let identityReviewRequired = false;
  let identityBlockSensitiveOps = false;
  let identityAllowConversation = true;

  try {
    identity = await resolveOrCreateUserFromInbound({
      value,
      message: msg,
      messages: [msg],
      waId: rawWaId || null,
    });

    internalUserId = safeStr(identity?.internalUserId);
    inboundWaId = safeStr(identity?.inbound?.waId || rawWaId);
    inboundBsuid = safeStr(identity?.inbound?.bsuid);
    deliveryId = safeStr(identity?.inbound?.deliveryId || inboundWaId || inboundBsuid);
    identityConflictId = safeStr(identity?.conflictId);
    identityReviewRequired = Boolean(identity?.reviewRequired);
    identityBlockSensitiveOps = Boolean(identity?.blockSensitiveOps);
    identityAllowConversation = identity?.allowConversation !== false;
  } catch (err) {
    await reportWebhookError({
      errorCode: WEBHOOK_ERROR.IDENTITY_ERROR,
      message: err?.message || String(err),
      step: "resolve_identity",
      waId: rawWaId,
      messageId,
      extra: { messageType },
    });
    return;
  }

  if (!internalUserId || !deliveryId) {
    await reportWebhookError({
      errorCode: WEBHOOK_ERROR.IDENTITY_ERROR,
      message: "Identity resolution returned incomplete identifiers",
      step: "validate_identity",
      waId: inboundWaId || rawWaId,
      deliveryId,
      messageId,
      internalUserId,
      extra: { messageType },
    });
    return;
  }

  if (identityReviewRequired) {
    await reportWebhookSuppressed({
      event: "identity_conflict_pending_review",
      errorCode: WEBHOOK_ERROR.IDENTITY_REVIEW_REQUIRED,
      message: "Identity conflict pending manual review; conversation allowed and sensitive ops blocked.",
      step: "identity_review_pending",
      waId: inboundWaId || rawWaId,
      deliveryId,
      messageId,
      internalUserId,
      extra: {
        messageType,
        conflictId: identityConflictId,
        allowConversation: identityAllowConversation ? "true" : "false",
        blockSensitiveOps: identityBlockSensitiveOps ? "true" : "false",
        bsuid: inboundBsuid,
      },
    });
  }

  if (!identityAllowConversation) {
    await logWebhookEvent("warn", "identity_conversation_blocked", {
      step: "identity_allow_conversation_check",
      messageId,
      waId: inboundWaId,
      deliveryId,
      internalUserId,
      status: "blocked",
      errorCode: WEBHOOK_ERROR.IDENTITY_REVIEW_REQUIRED,
      meta: {
        conflictId: identityConflictId,
      },
    });
    return;
  }

  if (messageId) {
    try {
      const seen = await markMessageSeen(messageId);
      if (seen) return;
    } catch (err) {
      await reportWebhookError({
        errorCode: WEBHOOK_ERROR.DEDUPE_ERROR,
        message: err?.message || String(err),
        step: "message_dedupe",
        waId: inboundWaId,
        deliveryId,
        messageId,
        internalUserId,
      });
      // fallback explícito: processa a mensagem mesmo sem dedupe confirmado
    }
  }

  if (inboundWaId) {
    try {
      await touch24hWindow(inboundWaId);
    } catch (err) {
      await reportWebhookError({
        errorCode: WEBHOOK_ERROR.WINDOW24H_ERROR,
        message: err?.message || String(err),
        step: "touch_24h_window",
        waId: inboundWaId,
        deliveryId,
        messageId,
        internalUserId,
      });
    }
  }

  if (messageType !== "text") {
    await logWebhookEvent("info", "webhook_message_skipped", {
      step: "message_type_filter",
      messageType,
      messageId,
      waId: inboundWaId,
      internalUserId,
    });
    return;
  }

  const inboundText = safeStr(msg?.text?.body);
  if (!inboundText) {
    await logWebhookEvent("info", "webhook_message_skipped", {
      step: "empty_text_message",
      messageType,
      messageId,
      waId: inboundWaId,
      internalUserId,
    });
    return;
  }

  let flowResult = null;
  try {
    flowResult = await handleInboundText({
      waId: internalUserId,
      text: inboundText,
      identityContext: {
        reviewRequired: identityReviewRequired,
        conflictId: identityConflictId,
        allowConversation: identityAllowConversation,
        blockSensitiveOps: identityBlockSensitiveOps,
      },
    });
  } catch (err) {
    await reportWebhookError({
      errorCode: WEBHOOK_ERROR.FLOW_ERROR,
      message: err?.message || String(err),
      step: "handle_inbound_text",
      waId: inboundWaId,
      deliveryId,
      messageId,
      internalUserId,
      metric: trackFlowError,
    });

    await reportWebhookError({
      errorCode: WEBHOOK_ERROR.FLOW_ERROR,
      message: err?.message || String(err),
      step: "handle_inbound_text",
      waId: inboundWaId,
      deliveryId,
      messageId,
      internalUserId,
      metric: trackWebhookError,
    });
    return;
  }

  if (flowResult?.shouldReply) {
    const replies = safeArray(flowResult?.replies).length
      ? safeArray(flowResult.replies)
      : (flowResult?.replyText ? [flowResult.replyText] : []);

    await sendReplies({
      replies,
      deliveryId,
      inboundWaId,
      inboundBsuid,
      internalUserId,
      messageId,
    });
  }

  if (inboundWaId) {
    if (identityBlockSensitiveOps) {
      await logWebhookEvent("info", "pending_campaigns_suppressed_by_identity_review", {
        step: "process_pending_campaigns",
        messageId,
        waId: inboundWaId,
        deliveryId,
        internalUserId,
        status: "suppressed",
        errorCode: WEBHOOK_ERROR.IDENTITY_REVIEW_REQUIRED,
        meta: {
          conflictId: identityConflictId,
          bsuid: safeStr(inboundBsuid),
        },
      });
    } else {
      try {
        await processPendingForWaId(inboundWaId);
      } catch (err) {
        await reportWebhookError({
          errorCode: WEBHOOK_ERROR.PENDING_PROCESS_ERROR,
          message: err?.message || String(err),
          step: "process_pending_campaigns",
          waId: inboundWaId,
          deliveryId,
          messageId,
          internalUserId,
          extra: {
            bsuid: safeStr(inboundBsuid),
          },
        });
      }
    }
  }
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

    const body = req.body || {};
    const entries = safeArray(body.entry);

    if (!entries.length) {
      await reportWebhookError({
        errorCode: WEBHOOK_ERROR.PAYLOAD_ERROR,
        message: "Webhook payload received without entry array",
        step: "parse_body_entry",
        metric: trackWebhookError,
      });
      return;
    }

    for (const entry of entries) {
      try {
        const changes = safeArray(entry?.changes);
        if (!changes.length) {
          await reportWebhookError({
            errorCode: WEBHOOK_ERROR.PAYLOAD_ERROR,
            message: "Webhook entry received without changes array",
            step: "parse_entry_changes",
            metric: trackWebhookError,
          });
          continue;
        }

        for (const change of changes) {
          try {
            const value = change?.value && typeof change.value === "object" ? change.value : {};
            const messages = safeArray(value?.messages);

            if (!messages.length) {
              await logWebhookEvent("info", "webhook_change_skipped", {
                step: "parse_change_messages",
                reason: "no_messages",
              });
              continue;
            }

            for (const msg of messages) {
              try {
                await processInboundMessage({ value, msg });
              } catch (err) {
                await reportWebhookError({
                  errorCode: WEBHOOK_ERROR.RUNTIME_ERROR,
                  message: err?.message || String(err),
                  step: "process_single_message",
                  waId: safeStr(msg?.from || value?.contacts?.[0]?.wa_id),
                  messageId: safeStr(msg?.id),
                });
              }
            }
          } catch (err) {
            await reportWebhookError({
              errorCode: WEBHOOK_ERROR.RUNTIME_ERROR,
              message: err?.message || String(err),
              step: "process_change",
              metric: trackWebhookError,
            });
          }
        }
      } catch (err) {
        await reportWebhookError({
          errorCode: WEBHOOK_ERROR.RUNTIME_ERROR,
          message: err?.message || String(err),
          step: "process_entry",
          metric: trackWebhookError,
        });
      }
    }
  });

  return router;
}
