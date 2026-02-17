// src/services/redis.js
// Upstash Redis REST helpers (Node.js ESM)
// ✅ V16.4.4 — Produção definitiva:
// - redisSet suporta value="" sem quebrar (evita ERR wrong number of arguments for 'set')
// - Mantém compatibilidade com chamadas atuais (path-based) quando value não é vazio

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function assertRedisEnv() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
}

/**
 * Upstash REST:
 * - Args são segmentos do path
 * - Body do POST é anexado como último argumento do comando (quando enviado)
 *
 * Ex:
 * POST /SET/foo/bar           -> SET foo bar
 * POST /SET/foo  (body:"")    -> SET foo ""
 */
async function upstash(path, bodyValue) {
  assertRedisEnv();

  const url = `${UPSTASH_REDIS_REST_URL}${path}`;

  const hasBody = bodyValue !== undefined;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      // Quando manda body, manda como texto puro (o Upstash usa como argumento final)
      "Content-Type": hasBody ? "text/plain" : "application/json",
    },
    body: hasBody ? String(bodyValue) : undefined,
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

// -----------------
// Basic Commands
// -----------------

export async function redisPing() {
  return upstash("/PING");
}

export async function redisGet(key) {
  return upstash(`/GET/${encodeURIComponent(key)}`);
}

/**
 * ✅ Produção definitiva:
 * - value === "" => envia no body (POST /SET/<key> com body vazio)
 * - value !== "" => usa path (POST /SET/<key>/<value>)
 */
export async function redisSet(key, value) {
  const k = encodeURIComponent(key);

  if (value === undefined) {
    throw new Error("redisSet: value is required (can be empty string, but not undefined)");
  }

  const v = String(value);

  // value vazio: não pode virar segmento vazio no path
  if (v.length === 0) {
    return upstash(`/SET/${k}`, "");
  }

  return upstash(`/SET/${k}/${encodeURIComponent(v)}`);
}

export async function redisDel(key) {
  return upstash(`/DEL/${encodeURIComponent(key)}`);
}

export async function redisIncrBy(key, delta = 1) {
  const d = Number(delta);
  if (!Number.isFinite(d)) throw new Error("redisIncrBy: delta must be a number");
  return upstash(
    `/INCRBY/${encodeURIComponent(key)}/${encodeURIComponent(String(Math.trunc(d)))}`
  );
}

// 🔹 detectar tipo da chave
export async function redisType(key) {
  return upstash(`/TYPE/${encodeURIComponent(key)}`);
}

// -----------------
// Sets
// -----------------

export async function redisSAdd(key, ...members) {
  const list =
    members.length === 1 && Array.isArray(members[0]) ? members[0] : members;

  const filtered = (list || []).map((m) => String(m)).filter(Boolean);
  if (filtered.length === 0) return 0;

  const encoded = filtered.map((m) => encodeURIComponent(m)).join("/");
  return upstash(`/SADD/${encodeURIComponent(key)}/${encoded}`);
}

export async function redisSCard(key) {
  return upstash(`/SCARD/${encodeURIComponent(key)}`);
}

export async function redisSMembers(key) {
  return upstash(`/SMEMBERS/${encodeURIComponent(key)}`);
}

// -----------------
// Sorted Sets
// -----------------

export async function redisZAdd(key, score, member) {
  return upstash(
    `/ZADD/${encodeURIComponent(key)}/${encodeURIComponent(
      String(score)
    )}/${encodeURIComponent(String(member))}`
  );
}

export async function redisZScore(key, member) {
  return upstash(
    `/ZSCORE/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`
  );
}

export async function redisZCount(key, min, max) {
  return upstash(
    `/ZCOUNT/${encodeURIComponent(key)}/${encodeURIComponent(
      String(min)
    )}/${encodeURIComponent(String(max))}`
  );
}

export async function redisZRangeByScore(key, min, max, limit = 1000) {
  return upstash(
    `/ZRANGEBYSCORE/${encodeURIComponent(key)}/${encodeURIComponent(
      String(min)
    )}/${encodeURIComponent(String(max))}/LIMIT/0/${encodeURIComponent(String(limit))}`
  );
}
