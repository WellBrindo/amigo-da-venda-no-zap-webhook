// src/services/redis.js
// Upstash Redis REST helpers (Node.js ESM)
// ✅ V16.4.5 — Produção definitiva + Diagnóstico:
// - redisSet SEMPRE usa body (POST /SET/<key> + body=value)
// - Em erro, inclui cmdPath e bodyLen na mensagem (sem vazar token/URL base)

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function assertRedisEnv() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
}

/**
 * Upstash REST:
 * - Args no path
 * - Body do POST é anexado como último argumento quando presente
 */
async function upstash(path, bodyValue) {
  assertRedisEnv();

  const url = `${UPSTASH_REDIS_REST_URL}${path}`;
  const hasBody = bodyValue !== undefined;

  // body SEMPRE em texto puro quando enviado.
  const bodyText = hasBody ? String(bodyValue) : undefined;

  let res;
  let data = {};

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": hasBody ? "text/plain" : "application/json",
      },
      body: bodyText,
    });

    data = await res.json().catch(() => ({}));
  } catch (err) {
    // erro de rede/timeout
    throw new Error(
      `Upstash: NETWORK_ERROR cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0} msg=${String(
        err?.message || err
      )}`
    );
  }

  // padroniza erro HTTP
  if (!res.ok) {
    const base = data?.error ? `Upstash: ${data.error}` : `Upstash: HTTP ${res.status}`;
    throw new Error(`${base} cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0}`);
  }

  // erro do redis
  if (data?.error) {
    throw new Error(
      `Upstash: ${data.error} cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0}`
    );
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
 * ✅ V16.4.5: redisSet SEMPRE usa body, evitando qualquer problema com path/value.
 * POST /SET/<key> (body="<value>") => SET key value
 */
export async function redisSet(key, value) {
  if (value === undefined) {
    // Isso pega bug de chamada sem value (muito comum em reset/admin)
    throw new Error(`redisSet: value is required (got undefined) key=${key}`);
  }
  const k = encodeURIComponent(key);
  const v = String(value); // pode ser "" e está OK
  return upstash(`/SET/${k}`, v);
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

export async function redisType(key) {
  return upstash(`/TYPE/${encodeURIComponent(key)}`);
}

// -----------------
// Sets
// -----------------

export async function redisSAdd(key, ...members) {
  const list = members.length === 1 && Array.isArray(members[0]) ? members[0] : members;

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
    `/ZADD/${encodeURIComponent(key)}/${encodeURIComponent(String(score))}/${encodeURIComponent(
      String(member)
    )}`
  );
}

export async function redisZScore(key, member) {
  return upstash(
    `/ZSCORE/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`
  );
}

export async function redisZCount(key, min, max) {
  return upstash(
    `/ZCOUNT/${encodeURIComponent(key)}/${encodeURIComponent(String(min))}/${encodeURIComponent(
      String(max)
    )}`
  );
}

export async function redisZRangeByScore(key, min, max, limit = 1000) {
  return upstash(
    `/ZRANGEBYSCORE/${encodeURIComponent(key)}/${encodeURIComponent(
      String(min)
    )}/${encodeURIComponent(String(max))}/LIMIT/0/${encodeURIComponent(String(limit))}`
  );
}

// -----------------
// Lists + TTL (alerts)
// -----------------

export async function redisExpire(key, seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) throw new Error("redisExpire: seconds must be >= 0");
  return upstash(
    `/EXPIRE/${encodeURIComponent(key)}/${encodeURIComponent(String(Math.trunc(s)))}`
  );
}

export async function redisLPush(key, ...values) {
  const list = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;

  const filtered = (list || []).map((v) => String(v)).filter((v) => v.length > 0);
  if (filtered.length === 0) return 0;

  const encoded = filtered.map((v) => encodeURIComponent(v)).join("/");
  return upstash(`/LPUSH/${encodeURIComponent(key)}/${encoded}`);
}

export async function redisLRange(key, start = 0, stop = 49) {
  return upstash(
    `/LRANGE/${encodeURIComponent(key)}/${encodeURIComponent(
      String(Math.trunc(start))
    )}/${encodeURIComponent(String(Math.trunc(stop)))}`
  );
}

export async function redisLLen(key) {
  return upstash(`/LLEN/${encodeURIComponent(key)}`);
}
