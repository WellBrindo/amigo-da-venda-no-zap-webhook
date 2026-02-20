// src/services/metrics.js
// ✅ V16.4.10 — Métricas de uso (descrições) global e por usuário
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

import { redisGet, redisIncrBy, redisExpire, redisDel } from "./redis.js";

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

// -----------------------------
// 📈 Histórico (global e por usuário)
// -----------------------------

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function isValidYm(s) {
  return /^\d{4}-\d{2}$/.test(String(s || ""));
}

function toDateFromYmd(ymd) {
  // Interpreta como data local do servidor (estável).
  const [y, m, d] = String(ymd).split("-").map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1);
}

function fmtYmd(dt) {
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  const d = pad2(dt.getDate());
  return `${y}-${m}-${d}`;
}

function fmtYm(dt) {
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  return `${y}-${m}`;
}

function addDays(dt, n) {
  const x = new Date(dt.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(dt, n) {
  const x = new Date(dt.getTime());
  x.setMonth(x.getMonth() + n);
  return x;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Retorna série diária global dos últimos N dias (inclui hoje).
 * Ex.: N=30 => 30 pontos.
 */
export async function getGlobalLastNDays(n = 30, endDate = new Date()) {
  const days = clampInt(n, 1, 365, 30);
  const end = new Date(endDate.getTime());
  const start = addDays(end, -(days - 1));

  const keys = [];
  const labels = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(start, i));
    labels.push(d);
    keys.push(kGlobalDay(d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Retorna série mensal global dos últimos N meses (inclui mês atual).
 * Ex.: N=12 => 12 pontos.
 */
export async function getGlobalLastNMonths(n = 12, endDate = new Date()) {
  const months = clampInt(n, 1, 36, 12);
  const end = new Date(endDate.getTime());
  // começar no primeiro dia do mês para consistência
  end.setDate(1);
  const start = addMonths(end, -(months - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < months; i++) {
    const m = fmtYm(addMonths(start, i));
    labels.push(m);
    keys.push(kGlobalMonth(m));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ month: l, count: values[i] })) };
}

/**
 * Série diária GLOBAL por intervalo personalizado (inclusive).
 * start/end no formato YYYY-MM-DD.
 * Limites: máx 366 dias para proteger produção.
 */
export async function getGlobalDaysRange({ start, end } = {}) {
  const s = safeStr(start);
  const e = safeStr(end);
  if (!isValidYmd(s) || !isValidYmd(e)) return { ok: false, error: "start/end must be YYYY-MM-DD" };

  const ds = toDateFromYmd(s);
  const de = toDateFromYmd(e);
  if (de < ds) return { ok: false, error: "end must be >= start" };

  const diffDays = Math.floor((de.getTime() - ds.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const days = clampInt(diffDays, 1, 366, 30);

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(ds, i));
    labels.push(d);
    keys.push(kGlobalDay(d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Série diária por usuário (últimos N dias).
 */
export async function getUserLastNDays(waId, n = 30, endDate = new Date()) {
  const id = safeStr(waId);
  if (!id) return { ok: false, error: "waId required" };

  const days = clampInt(n, 1, 365, 30);
  const end = new Date(endDate.getTime());
  const start = addDays(end, -(days - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(start, i));
    labels.push(d);
    keys.push(kUserDay(id, d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Série mensal por usuário (últimos N meses).
 */
export async function getUserLastNMonths(waId, n = 12, endDate = new Date()) {
  const id = safeStr(waId);
  if (!id) return { ok: false, error: "waId required" };

  const months = clampInt(n, 1, 36, 12);
  const end = new Date(endDate.getTime());
  end.setDate(1);
  const start = addMonths(end, -(months - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < months; i++) {
    const m = fmtYm(addMonths(start, i));
    labels.push(m);
    keys.push(kUserMonth(id, m));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ month: l, count: values[i] })) };
}

/**
 * Série diária por usuário por intervalo personalizado (inclusive).
 */
export async function getUserDaysRange({ waId, start, end } = {}) {
  const id = safeStr(waId);
  if (!id) return { ok: false, error: "waId required" };

  const s = safeStr(start);
  const e = safeStr(end);
  if (!isValidYmd(s) || !isValidYmd(e)) return { ok: false, error: "start/end must be YYYY-MM-DD" };

  const ds = toDateFromYmd(s);
  const de = toDateFromYmd(e);
  if (de < ds) return { ok: false, error: "end must be >= start" };

  const diffDays = Math.floor((de.getTime() - ds.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const days = clampInt(diffDays, 1, 366, 30);

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(ds, i));
    labels.push(d);
    keys.push(kUserDay(id, d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

// -----------------------------
// 🧹 Reset de métricas por usuário (sem SCAN/KEYS)
// - Remove chaves day/month do usuário em um intervalo fixo
// - Útil para “resetar como se nunca tivesse escrito” em número de teste
// -----------------------------

export async function resetUserDescriptionMetrics(waId, { days = 120, months = 18, endDate = new Date() } = {}) {
  const id = safeStr(waId);
  if (!id) return { ok: false, error: 'waId required' };

  const dN = clampInt(days, 1, 400, 120);
  const mN = clampInt(months, 1, 48, 18);

  const end = new Date(endDate.getTime());
  const dayEnd = fmtYmd(end);

  // Dias
  const startDay = addDays(end, -(dN - 1));
  const dayKeys = [];
  for (let i = 0; i < dN; i++) {
    const d = fmtYmd(addDays(startDay, i));
    dayKeys.push(kUserDay(id, d));
  }

  // Meses
  const endMonth = new Date(end.getTime());
  endMonth.setDate(1);
  const startMonth = addMonths(endMonth, -(mN - 1));
  const monthKeys = [];
  for (let i = 0; i < mN; i++) {
    const m = fmtYm(addMonths(startMonth, i));
    monthKeys.push(kUserMonth(id, m));
  }

  let delCount = 0;
  const all = [...dayKeys, ...monthKeys];
  for (const k of all) {
    try {
      await redisDel(k);
      delCount++;
    } catch (_) {
      // best-effort
    }
  }

  return { ok: true, waId: id, deleted: delCount, ranges: { days: { start: fmtYmd(startDay), end: dayEnd, count: dN }, months: { start: fmtYm(startMonth), end: fmtYm(endMonth), count: mN } } };
}
