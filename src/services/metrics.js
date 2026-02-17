// src/services/metrics.js
// ✅ V16.4.8 — Métricas de uso (descrições) global e por usuário
// Objetivo:
// - Contadores baratos e estáveis (INCRBY) para:
//   - Global por dia e por mês
//   - Por usuário por dia e por mês
// - Com TTL para não crescer infinito
//
// Chaves:
// - metrics:desc:global:day:{YYYY-MM-DD}   => INT
// - metrics:desc:global:month:{YYYY-MM}    => INT
// - metrics:desc:user:{waId}:day:{YYYY-MM-DD}   => INT
// - metrics:desc:user:{waId}:month:{YYYY-MM}    => INT
//
// Observação:
// - Esse contador é "descrições geradas com sucesso" (após resposta da OpenAI).
// - Não substitui trialUsed/quotaUsed; é complementar para dashboard.

import { redisGet, redisIncrBy, redisExpire } from "./redis.js";

const TTL_DAY_SECONDS = 60 * 60 * 24 * 90;    // 90 dias
const TTL_MONTH_SECONDS = 60 * 60 * 24 * 450; // ~15 meses

function safeStr(v) {
  return String(v ?? "").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Retorna datas no fuso do servidor.
 * (No Render, normalmente UTC; para métricas é OK e estável)
 */
export function getDayKeyParts(date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}

function kGlobalDay(day) {
  return `metrics:desc:global:day:${day}`;
}
function kGlobalMonth(month) {
  return `metrics:desc:global:month:${month}`;
}
function kUserDay(waId, day) {
  return `metrics:desc:user:${waId}:day:${day}`;
}
function kUserMonth(waId, month) {
  return `metrics:desc:user:${waId}:month:${month}`;
}

/**
 * Incrementa contadores de "descrições geradas"
 * - Global (day/month)
 * - Por usuário (day/month)
 */
export async function incDescriptionMetrics(waId, by = 1, date = new Date()) {
  const id = safeStr(waId);
  const inc = Number(by) || 1;
  if (!id) return { ok: true, skipped: true };

  const { day, month } = getDayKeyParts(date);

  const keys = {
    gd: kGlobalDay(day),
    gm: kGlobalMonth(month),
    ud: kUserDay(id, day),
    um: kUserMonth(id, month),
  };

  // incrementa
  const [gd, gm, ud, um] = await Promise.all([
    redisIncrBy(keys.gd, inc),
    redisIncrBy(keys.gm, inc),
    redisIncrBy(keys.ud, inc),
    redisIncrBy(keys.um, inc),
  ]);

  // TTL best-effort (não quebra se falhar)
  await Promise.allSettled([
    redisExpire(keys.gd, TTL_DAY_SECONDS),
    redisExpire(keys.gm, TTL_MONTH_SECONDS),
    redisExpire(keys.ud, TTL_DAY_SECONDS),
    redisExpire(keys.um, TTL_MONTH_SECONDS),
  ]);

  return { ok: true, keys, values: { gd, gm, ud, um } };
}

/**
 * Lê contadores globais
 */
export async function getGlobalDescriptionMetrics(date = new Date()) {
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kGlobalDay(day)),
    redisGet(kGlobalMonth(month)),
  ]);
  return {
    ok: true,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

/**
 * Lê contadores por usuário
 */
export async function getUserDescriptionMetrics(waId, date = new Date()) {
  const id = safeStr(waId);
  const { day, month } = getDayKeyParts(date);
  if (!id) return { ok: false, error: "waId required" };

  const [d, m] = await Promise.all([
    redisGet(kUserDay(id, day)),
    redisGet(kUserMonth(id, month)),
  ]);

  return {
    ok: true,
    waId: id,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}
