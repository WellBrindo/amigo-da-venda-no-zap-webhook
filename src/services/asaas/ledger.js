// src/services/asaas/ledger.js
// Histórico (ledger) de eventos do Asaas para reconciliação no Admin.
// - Não altera status do usuário (isso continua no webhook handler).
// - Dedup por evento + id (payment/subscription)
// - Capped lists (não cresce infinito)

import { redisLPush, redisLTrim, redisLRange, redisSIsMember, redisSAdd } from "../redis.js";

const KEY_EVENT_IDS = "asaas:event_ids"; // SET
const KEY_EVENTS_GLOBAL = "asaas:events"; // LIST (JSON)

const keyUserEvents = (waId) => `asaas:events:user:${waId}`;

function safeStr(v) {
  return String(v || "").trim();
}

function pickPayment(p) {
  if (!p || typeof p !== "object") return null;
  return {
    id: safeStr(p.id),
    status: safeStr(p.status),
    billingType: safeStr(p.billingType),
    value: typeof p.value === "number" ? p.value : Number(p.value || 0),
    netValue: typeof p.netValue === "number" ? p.netValue : Number(p.netValue || 0),
    dueDate: safeStr(p.dueDate),
    paymentDate: safeStr(p.paymentDate || p.receivedDate || p.confirmedDate),
    invoiceUrl: safeStr(p.invoiceUrl),
    externalReference: safeStr(p.externalReference),
    description: safeStr(p.description),
  };
}

function pickSubscription(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: safeStr(s.id),
    status: safeStr(s.status),
    cycle: safeStr(s.cycle),
    value: typeof s.value === "number" ? s.value : Number(s.value || 0),
    nextDueDate: safeStr(s.nextDueDate || s.nextPaymentDate),
    externalReference: safeStr(s.externalReference),
  };
}

function makeDedupKey({ event, payment, subscription }) {
  const ev = safeStr(event);
  const pid = safeStr(payment?.id);
  const sid = safeStr(subscription?.id);
  if (pid) return `${ev}:payment:${pid}`;
  if (sid) return `${ev}:subscription:${sid}`;
  // fallback (raríssimo)
  return `${ev}:generic:${Date.now()}`;
}

export async function recordAsaasEvent({ event, waId, payment, subscription, source = "webhook" }) {
  const wa = safeStr(waId);
  if (!wa) return { ok: false, reason: "no_waId" };

  const entry = {
    ts: new Date().toISOString(),
    source: safeStr(source) || "webhook",
    event: safeStr(event),
    waId: wa,
    payment: pickPayment(payment),
    subscription: pickSubscription(subscription),
  };

  const dedupKey = makeDedupKey({ event, payment, subscription });
  const already = await redisSIsMember(KEY_EVENT_IDS, dedupKey);
  if (already) return { ok: true, dedup: true };

  await redisSAdd(KEY_EVENT_IDS, dedupKey);

  const json = JSON.stringify(entry);
  await redisLPush(KEY_EVENTS_GLOBAL, json);
  await redisLTrim(KEY_EVENTS_GLOBAL, 0, 1999);

  const userKey = keyUserEvents(wa);
  await redisLPush(userKey, json);
  await redisLTrim(userKey, 0, 499);

  return { ok: true };
}

export async function listAsaasEvents({ waId = "", offset = 0, limit = 50 } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const start = off;
  const stop = off + lim - 1;

  const key = waId ? keyUserEvents(String(waId).trim()) : KEY_EVENTS_GLOBAL;
  const rows = await redisLRange(key, start, stop);

  const items = [];
  for (const r of rows || []) {
    try {
      items.push(JSON.parse(r));
    } catch {
      // ignora
    }
  }

  return { ok: true, items };
}
