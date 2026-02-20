import { redisGet, redisSet, redisDel, redisZAdd, redisZRem, redisZCount, redisZRangeByScore } from "./redis.js";
import { indexUser } from "./state.js";

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

/**
 * Deve ser chamado quando o usuário envia QUALQUER mensagem inbound.
 * - Marca last_inbound_ts
 * - Atualiza índice z:window24h com score=agora+24h
 * - Indexa usuário em users:all
 */
export async function touch24hWindow(waId, tsMs = nowMs()) {
  if (!waId) throw new Error("Missing waId");
  await indexUser(waId);

  const end = tsMs + WINDOW_MS;

  await Promise.all([
    redisSet(keyLastInboundTs(waId), String(tsMs)),
    redisZAdd(KEY_Z_WINDOW_24H, end, waId),
  ]);

  return {
    waId,
    lastInboundAtMs: tsMs,
    windowEndsAtMs: end,
  };
}

export async function getLastInboundTs(waId) {
  const v = await redisGet(keyLastInboundTs(waId));
  return v ? Number(v) : 0;
}

/**
 * Quantos usuários estão na janela (score >= agora)
 */
export async function countWindow24hActive(tsMs = nowMs()) {
  // ZCOUNT key min max
  // min = agora, max = +inf (no Upstash REST, usamos um número grande)
  const INF = "9999999999999";
  const count = await redisZCount(KEY_Z_WINDOW_24H, String(tsMs), INF);
  return Number(count || 0);
}

/**
 * Lista usuários na janela.
 * (No começo, simples: busca scores entre agora e +inf)
 */
export async function listWindow24hActive(tsMs = nowMs(), limit = 500) {
  const INF = "9999999999999";
  const items = await redisZRangeByScore(KEY_Z_WINDOW_24H, String(tsMs), INF, limit);
  // Upstash retorna array de members (strings)
  const waIds = Array.isArray(items) ? items : [];
  return waIds;
}

export async function clear24hWindowForUser(waId) {
  const id = String(waId ?? '').trim();
  if (!id) throw new Error('Missing waId');
  // best-effort: remove last inbound timestamp + remove member from zset
  await Promise.allSettled([
    redisDel(keyLastInboundTs(id)),
    redisZRem(KEY_Z_WINDOW_24H, id),
  ]);
  return { ok: true, waId: id };
}
