// src/services/redis.js
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function assertRedisEnv() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
}

async function upstash(path, bodyObj) {
  assertRedisEnv();

  const url = `${UPSTASH_REDIS_REST_URL}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
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

export async function redisSet(key, value) {
  return upstash(
    `/SET/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`
  );
}

export async function redisDel(key) {
  return upstash(`/DEL/${encodeURIComponent(key)}`);
}

// -----------------
// Sets
// -----------------

export async function redisSAdd(key, members) {
  const list = Array.isArray(members) ? members : [members];
  const encoded = list.map((m) => encodeURIComponent(String(m))).join("/");
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
    )}/${encodeURIComponent(String(max))}/LIMIT/0/${encodeURIComponent(
      String(limit)
    )}`
  );
}
