// src/services/alerts.js
// ✅ V16.4.7 — Alertas persistidos no Redis (para diagnóstico rápido em produção)
// - Armazena eventos em LIST alerts:system (LPUSH)
// - Mantém histórico com LTRIM e TTL
// - Nunca inclui dados sensíveis

import { redisLPush, redisLRange, redisLTrim, redisExpire, redisLLen } from "./redis.js";

const ALERTS_KEY = "alerts:system";
const ALERTS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dias
const ALERTS_MAX = 300; // mantém os últimos 300

function safeStr(v) {
  return String(v ?? "").trim();
}

export async function pushSystemAlert(event, payload = {}) {
  const entry = {
    id: `al_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    ts: new Date().toISOString(),
    event: safeStr(event) || "UNKNOWN",
    payload: payload && typeof payload === "object" ? payload : { info: safeStr(payload) },
  };

  try {
    await redisLPush(ALERTS_KEY, JSON.stringify(entry));
    await redisLTrim(ALERTS_KEY, 0, ALERTS_MAX - 1);
    await redisExpire(ALERTS_KEY, ALERTS_TTL_SECONDS);
  } catch (err) {
    // alerta não pode derrubar o sistema
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "alerts_push_failed",
        event: entry.event,
        error: safeStr(err?.message || err),
      })
    );
  }

  return entry;
}

export async function listSystemAlerts(limit = 50) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const items = await redisLRange(ALERTS_KEY, 0, lim - 1);
  const arr = Array.isArray(items) ? items : [];
  const out = [];
  for (const raw of arr) {
    try {
      out.push(JSON.parse(String(raw)));
    } catch {
      out.push({ ts: "", event: "PARSE_ERROR", payload: { raw: String(raw) } });
    }
  }
  return out;
}

export async function getSystemAlertsCount() {
  const n = await redisLLen(ALERTS_KEY);
  return Number(n || 0);
}
