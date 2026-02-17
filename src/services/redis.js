// src/services/redis.js
// Upstash Redis REST helpers (Node.js ESM)
//
// ⚠️ Importante:
// - Nunca logamos tokens/URLs aqui.
// - Funções são finas e previsíveis, usadas por state/flow/plans/window24h.

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function assertRedisEnv() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
}

async function upstash(path) {
  assertRedisEnv();

  const url = `${UPSTASH_REDIS_REST_URL}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error ? `Upstash: ${data.error}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  if (data?.error) {
    throw new Error(`Upstash: ${data.error}`);
  }

  return data?.result;
}

function enc(v) {
  return encodeURIComponent(String(v));
}

// -----------------
// Basic Commands
// -----------------

export async function redisPing() {
  return upstash("/PING");
}

export async function redisGet(key) {
  return upstash(`/GET/${enc(key)}`);
}

export async function redisSet(key, value) {
  // value pode ser string/number/boolean/JSON stringificado pelo caller
  return upstash(`/SET/${enc(key)}/${enc(value)}`);
}

export async function redisDel(key) {
  return upstash(`/DEL/${enc(key)}`);
}

export async function redisIncrBy(key, increment = 1) {
  const inc = Number(increment);
  if (!Number.isFinite(inc)) throw new Error("Invalid increment");
  return upstash(`/INCRBY/${enc(key)}/${enc(Math.trunc(inc))}`);
}

// -----------------
// Sets
// -----------------

// Compatível com:
// - redisSAdd(key, "a")
// - redisSAdd(key, "a", "b")
// - redisSAdd(key, ["a","b"])
export async function redisSAdd(key, ...members) {
  const list =
    members.length === 1 && Array.isArray(members[0]) ? members[0] : members;

  const filtered = (list || []).map((m) => String(m)).filter(Boolean);
  if (filtered.length === 0) return 0;

  const encoded = filtered.map(enc).join("/");
  return upstash(`/SADD/${enc(key)}/${encoded}`);
}

export async function redisSCard(key) {
  return upstash(`/SCARD/${enc(key)}`);
}

export async function redisSMembers(key) {
  return upstash(`/SMEMBERS/${enc(key)}`);
}

// -----------------
// Sorted Sets
// -----------------

export async function redisZAdd(key, score, member) {
  return upstash(`/ZADD/${enc(key)}/${enc(score)}/${enc(member)}`);
}

export async function redisZScore(key, member) {
  return upstash(`/ZSCORE/${enc(key)}/${enc(member)}`);
}

export async function redisZCount(key, min, max) {
  return upstash(`/ZCOUNT/${enc(key)}/${enc(min)}/${enc(max)}`);
}

export async function redisZRangeByScore(key, min, max, limit = 1000) {
  return upstash(
    `/ZRANGEBYSCORE/${enc(key)}/${enc(min)}/${enc(max)}/LIMIT/0/${enc(limit)}`
  );
}
