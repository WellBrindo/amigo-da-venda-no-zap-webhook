import {
  redisSafeGet,
  redisSafeSet,
  redisSafeDel,
  redisSafeZAdd,
  redisSafeZRem,
  redisSafeZCount,
  redisSafeZRangeByScore,
  getRedisHealthSnapshot,
} from "./redis.js";
import { indexUser } from "./state.js";
import { raiseSystemIncident } from "./alerts.js";
import * as audit from "./audit.js";
import { trackRedisDegraded, trackRedisDown, trackRedisFallbackRead } from "./metrics.js";

const KEY_Z_WINDOW_24H = "z:window24h";
const WINDOW_MS = 24 * 60 * 60 * 1000;

function keyLastInboundTs(waId) {
  return `last_inbound_ts:${waId}`;
}

export function nowMs() {
  return Date.now();
}

export function windowEndsAtMs(now = nowMs()) {
  return now + WINDOW_MS;
}

function safeStr(value) {
  return String(value ?? "").trim();
}

async function logWindow24hDegraded({
  event = "window24h_degraded",
  step = "",
  waId = "",
  errorCode = "WINDOW24H_REDIS_DEGRADED",
  message = "",
  impact = "",
  severity = "MEDIUM",
  fallbackUsed = false,
  meta = {},
} = {}) {
  const redisStatus = typeof getRedisHealthSnapshot === "function"
    ? safeStr(getRedisHealthSnapshot()?.status) || "DEGRADED"
    : "DEGRADED";

  try {
    if (redisStatus === "DOWN" && typeof trackRedisDown === "function") {
      await trackRedisDown({
        userId: safeStr(waId),
        waId: safeStr(waId),
        source: "window24h",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact),
        severity: safeStr(severity),
      });
    } else if (typeof trackRedisDegraded === "function") {
      await trackRedisDegraded({
        userId: safeStr(waId),
        waId: safeStr(waId),
        source: "window24h",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact),
        severity: safeStr(severity),
      });
    }

    if (fallbackUsed && typeof trackRedisFallbackRead === "function") {
      await trackRedisFallbackRead({
        userId: safeStr(waId),
        waId: safeStr(waId),
        source: "window24h",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact),
        severity: safeStr(severity),
      });
    }
  } catch {}

  try {
    if (audit && typeof audit.logOperationalEvent === "function") {
      await audit.logOperationalEvent({
        module: "window24h",
        event: safeStr(event),
        level: "warn",
        userId: safeStr(waId),
        waId: safeStr(waId),
        step: safeStr(step),
        message: safeStr(message),
        errorCode: safeStr(errorCode),
        status: "degraded",
        meta: {
          redisStatus,
          impact: safeStr(impact),
          fallbackUsed: Boolean(fallbackUsed),
          ...(meta && typeof meta === "object" ? meta : {}),
        },
      });
    }
  } catch {}

  try {
    await raiseSystemIncident({
      type: "REDIS",
      severity: safeStr(severity) || "MEDIUM",
      module: "window24h",
      step: safeStr(step),
      errorCode: safeStr(errorCode),
      message: safeStr(message) || "Window24h Redis degradation detected.",
      impact: safeStr(impact),
      dedupeKey: ["window24h", safeStr(step), safeStr(errorCode), safeStr(impact)].filter(Boolean).join("|"),
      meta: {
        redisStatus,
        waId: safeStr(waId),
        fallbackUsed: Boolean(fallbackUsed),
        ...(meta && typeof meta === "object" ? meta : {}),
      },
    });
  } catch {}
}

/**
 * Deve ser chamado quando o usuário envia QUALQUER mensagem inbound.
 * - Marca last_inbound_ts
 * - Atualiza índice z:window24h com score=agora+24h
 * - Indexa usuário em users:all
 */
export async function touch24hWindow(waId, tsMs = nowMs()) {
  if (!waId) throw new Error("Missing waId");

  try {
    await indexUser(waId);
  } catch (error) {
    await logWindow24hDegraded({
      event: "window24h_index_user_degraded",
      step: "touch24hWindow:indexUser",
      waId,
      errorCode: "WINDOW24H_INDEX_USER_DEGRADED",
      message: safeStr(error?.message || error),
      impact: "window24h_index_user_skipped",
      severity: "MEDIUM",
      meta: {
        setOk: Boolean(setResult?.ok),
        zaddOk: Boolean(zaddResult?.ok),
        setStatus: safeStr(setResult?.status),
        zaddStatus: safeStr(zaddResult?.status),
      },
    });
  }

  const end = tsMs + WINDOW_MS;

  const [setResult, zaddResult] = await Promise.all([
    redisSafeSet(keyLastInboundTs(waId), String(tsMs), {
      fallbackValue: false,
      critical: false,
      module: "window24h",
      step: "touch24hWindow:setLastInboundTs",
      suppressThrow: true,
    }),
    redisSafeZAdd(KEY_Z_WINDOW_24H, end, waId, {
      fallbackValue: false,
      critical: false,
      module: "window24h",
      step: "touch24hWindow:zadd",
      suppressThrow: true,
    }),
  ]);

  if (!setResult?.ok || !zaddResult?.ok) {
    await logWindow24hDegraded({
      event: "window24h_touch_degraded",
      step: "touch24hWindow",
      waId,
      errorCode: "WINDOW24H_TOUCH_DEGRADED",
      message: "Window24h touch degraded; conversation may continue without full Redis persistence.",
      impact: "window24h_touch_skipped",
      severity: "MEDIUM",
    });
  }

  return {
    waId,
    lastInboundAtMs: tsMs,
    windowEndsAtMs: end,
    degraded: Boolean(!setResult?.ok || !zaddResult?.ok),
  };
}

export async function getLastInboundTs(waId) {
  const result = await redisSafeGet(keyLastInboundTs(waId), {
    fallbackValue: "0",
    critical: false,
    module: "window24h",
    step: "getLastInboundTs",
    suppressThrow: true,
  });

  if (!result?.ok) {
    await logWindow24hDegraded({
      event: "window24h_last_inbound_fallback",
      step: "getLastInboundTs",
      waId,
      errorCode: "WINDOW24H_LAST_INBOUND_FALLBACK",
      message: safeStr(result?.message) || "Failed to read last inbound timestamp; fallback applied.",
      impact: "window24h_last_inbound_fallback",
      severity: "LOW",
      fallbackUsed: true,
    });
  }

  const v = Number(result?.value || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Quantos usuários estão na janela (score >= agora)
 */
export async function countWindow24hActive(tsMs = nowMs()) {
  const INF = "9999999999999";
  const result = await redisSafeZCount(KEY_Z_WINDOW_24H, String(tsMs), INF, {
    fallbackValue: 0,
    critical: false,
    module: "window24h",
    step: "countWindow24hActive",
    suppressThrow: true,
  });

  if (!result?.ok) {
    await logWindow24hDegraded({
      event: "window24h_count_fallback",
      step: "countWindow24hActive",
      errorCode: "WINDOW24H_COUNT_FALLBACK",
      message: safeStr(result?.message) || "Failed to count active 24h window users; fallback applied.",
      impact: "window24h_count_fallback",
      severity: "LOW",
      fallbackUsed: true,
    });
  }

  const count = Number(result?.value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Lista usuários na janela.
 * (No começo, simples: busca scores entre agora e +inf)
 */
export async function listWindow24hActive(tsMs = nowMs(), limit = 500) {
  const INF = "9999999999999";
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const result = await redisSafeZRangeByScore(KEY_Z_WINDOW_24H, String(tsMs), INF, safeLimit, {
    fallbackValue: [],
    critical: false,
    module: "window24h",
    step: "listWindow24hActive",
    suppressThrow: true,
  });

  if (!result?.ok) {
    await logWindow24hDegraded({
      event: "window24h_list_fallback",
      step: "listWindow24hActive",
      errorCode: "WINDOW24H_LIST_FALLBACK",
      message: safeStr(result?.message) || "Failed to list active 24h window users; fallback applied.",
      impact: "window24h_list_fallback",
      severity: "LOW",
      fallbackUsed: true,
    });
  }

  const items = Array.isArray(result?.value) ? result.value : [];
  return items.map((item) => safeStr(item)).filter(Boolean);
}

export async function clear24hWindowForUser(waId) {
  const id = String(waId ?? '').trim();
  if (!id) throw new Error('Missing waId');

  const [delResult, zremResult] = await Promise.allSettled([
    redisSafeDel(keyLastInboundTs(id), {
      fallbackValue: false,
      critical: false,
      module: "window24h",
      step: "clear24hWindowForUser:deleteTs",
      suppressThrow: true,
    }),
    redisSafeZRem(KEY_Z_WINDOW_24H, id, {
      fallbackValue: false,
      critical: false,
      module: "window24h",
      step: "clear24hWindowForUser:zrem",
      suppressThrow: true,
    }),
  ]);

  const degraded =
    delResult.status === "rejected" ||
    zremResult.status === "rejected" ||
    (delResult.status === "fulfilled" && delResult.value && delResult.value.ok === false) ||
    (zremResult.status === "fulfilled" && zremResult.value && zremResult.value.ok === false);

  if (degraded) {
    await logWindow24hDegraded({
      event: "window24h_clear_degraded",
      step: "clear24hWindowForUser",
      waId: id,
      errorCode: "WINDOW24H_CLEAR_DEGRADED",
      message: "Failed to fully clear 24h window state for user; best-effort applied.",
      impact: "window24h_clear_partial",
      severity: "LOW",
      meta: {
        delStatus: delResult.status,
        zremStatus: zremResult.status,
      },
    });
  }

  return { ok: true, waId: id, degraded };
}
