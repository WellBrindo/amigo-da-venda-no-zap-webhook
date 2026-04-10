// src/services/redis.js
// Upstash Redis REST helpers (Node.js ESM)
// ✅ V16.4.5 — Produção definitiva + Diagnóstico:
// - redisSet SEMPRE usa body (POST /SET/<key> + body=value)
// - Em erro, inclui cmdPath e bodyLen na mensagem (sem vazar token/URL base)
// ✅ V16.4.7 — List/Expire/Set helpers para Broadcast/Campanhas/Alertas:
// - LPUSH/LRANGE/LTRIM/LLEN/EXPIRE
// - SREM/SISMEMBER

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
    throw new Error(
      `Upstash: NETWORK_ERROR cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0} msg=${String(
        err?.message || err
      )}`
    );
  }

  if (!res.ok) {
    const base = data?.error ? `Upstash: ${data.error}` : `Upstash: HTTP ${res.status}`;
    throw new Error(`${base} cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0}`);
  }

  if (data?.error) {
    throw new Error(`Upstash: ${data.error} cmdPath=${path} bodyLen=${hasBody ? bodyText.length : 0}`);
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
    throw new Error(`redisSet: value is required (got undefined) key=${key}`);
  }
  const k = encodeURIComponent(key);
  const v = String(value);
  return upstash(`/SET/${k}`, v);
}

export async function redisDel(key) {
  return upstash(`/DEL/${encodeURIComponent(key)}`);
}

export async function redisIncrBy(key, delta = 1) {
  const d = Number(delta);
  if (!Number.isFinite(d)) throw new Error("redisIncrBy: delta must be a number");
  return upstash(`/INCRBY/${encodeURIComponent(key)}/${encodeURIComponent(String(Math.trunc(d)))}`);
}

export async function redisType(key) {
  return upstash(`/TYPE/${encodeURIComponent(key)}`);
}

export async function redisExpire(key, seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) throw new Error("redisExpire: seconds must be > 0");
  return upstash(`/EXPIRE/${encodeURIComponent(key)}/${encodeURIComponent(String(Math.trunc(s)))}`);
}

// -----------------
// Lists
// -----------------

/**
 * LPUSH key value
 * (value vai no body para permitir JSON grande sem quebrar o path)
 */
export async function redisLPush(key, value) {
  const k = encodeURIComponent(key);
  const v = String(value ?? "");
  return upstash(`/LPUSH/${k}`, v);
}

export async function redisLRange(key, start = 0, stop = 49) {
  return upstash(`/LRANGE/${encodeURIComponent(key)}/${encodeURIComponent(String(start))}/${encodeURIComponent(String(stop))}`);
}

export async function redisLTrim(key, start = 0, stop = 99) {
  return upstash(`/LTRIM/${encodeURIComponent(key)}/${encodeURIComponent(String(start))}/${encodeURIComponent(String(stop))}`);
}

export async function redisLLen(key) {
  return upstash(`/LLEN/${encodeURIComponent(key)}`);
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

export async function redisSRem(key, ...members) {
  const list = members.length === 1 && Array.isArray(members[0]) ? members[0] : members;

  const filtered = (list || []).map((m) => String(m)).filter(Boolean);
  if (filtered.length === 0) return 0;

  const encoded = filtered.map((m) => encodeURIComponent(m)).join("/");
  return upstash(`/SREM/${encodeURIComponent(key)}/${encoded}`);
}

export async function redisSIsMember(key, member) {
  if (!member) return 0;
  return upstash(`/SISMEMBER/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`);
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
    `/ZADD/${encodeURIComponent(key)}/${encodeURIComponent(String(score))}/${encodeURIComponent(String(member))}`
  );
}

export async function redisZScore(key, member) {
  return upstash(`/ZSCORE/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`);
}

export async function redisZRem(key, member) {
  return upstash(`/ZREM/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`);
}

export async function redisZCount(key, min, max) {
  return upstash(
    `/ZCOUNT/${encodeURIComponent(key)}/${encodeURIComponent(String(min))}/${encodeURIComponent(String(max))}`
  );
}

export async function redisZRangeByScore(key, min, max, limit = 1000) {
  return upstash(
    `/ZRANGEBYSCORE/${encodeURIComponent(key)}/${encodeURIComponent(String(min))}/${encodeURIComponent(
      String(max)
    )}/LIMIT/0/${encodeURIComponent(String(limit))}`
  );
}

// -----------------
// Identity Keys
// -----------------

function requireKeyPart(name, value) {
  const part = String(value ?? "").trim();
  if (!part) throw new Error(`redis key part "${name}" is required`);
  return part;
}

export function redisUserSequenceKey() {
  return "seq:user";
}

export function redisUserKey(userId, suffix = "") {
  const uid = requireKeyPart("userId", userId);
  const tail = String(suffix ?? "").trim();
  return tail ? `user:${uid}:${tail}` : `user:${uid}`;
}

export function redisUserIdentifiersKey(userId) {
  return redisUserKey(userId, "identifiers");
}

export function redisAliasKey(kind, value) {
  const k = requireKeyPart("kind", kind).toLowerCase();
  const v = requireKeyPart("value", value);
  return `alias:${k}:${v}`;
}

export function redisAliasWaIdKey(waId) {
  return redisAliasKey("waid", waId);
}

export function redisAliasBsuidKey(bsuid) {
  return redisAliasKey("bsuid", bsuid);
}

export async function redisNextUserSequence() {
  return redisIncrBy(redisUserSequenceKey(), 1);
}

function normalizeCouponCode(code) {
  return requireKeyPart("couponCode", code).toUpperCase();
}

export function redisCouponIndexKey() {
  return "idx:coupon";
}

export function redisCouponCodeKey(couponCode) {
  const code = normalizeCouponCode(couponCode);
  return `coupon:${code}`;
}

export function redisCouponStatusIndexKey(status) {
  const s = requireKeyPart("status", status).toLowerCase();
  return `idx:coupon:status:${s}`;
}

export function redisCouponReservationSequenceKey() {
  return "seq:couponReservation";
}

export function redisCouponReservationKey(reservationId) {
  const rid = requireKeyPart("reservationId", reservationId);
  return `couponReservation:${rid}`;
}

export function redisCouponReservationPendingIndexKey() {
  return "idx:couponReservation:pending";
}

export function redisCouponReservationStatusIndexKey(status) {
  const s = requireKeyPart("status", status).toLowerCase();
  return `idx:couponReservation:status:${s}`;
}

export function redisCouponReservationUserIndexKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `idx:user:${uid}:couponReservation`;
}

export function redisCouponReservationCouponIndexKey(couponCode) {
  const code = normalizeCouponCode(couponCode);
  return `idx:coupon:${code}:reservation`;
}

export function redisCouponRedemptionUserIndexKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `idx:user:${uid}:couponRedemption`;
}

export function redisCouponRedemptionCouponIndexKey(couponCode) {
  const code = normalizeCouponCode(couponCode);
  return `idx:coupon:${code}:redemption`;
}

export function redisCouponAuditListKey(couponCode) {
  const code = normalizeCouponCode(couponCode);
  return `audit:coupon:${code}`;
}

export function redisCouponUserAuditListKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `audit:user:${uid}:coupon`;
}

export function redisCouponReportIndexKey() {
  return "idx:report:coupon";
}

export function redisCouponReportKey(reportId) {
  const rid = requireKeyPart("reportId", reportId);
  return `report:coupon:${rid}`;
}

export async function redisNextCouponReservationSequence() {
  return redisIncrBy(redisCouponReservationSequenceKey(), 1);
}

function normalizeCampaignCode(code) {
  return requireKeyPart("campaignCode", code).toUpperCase();
}

export function redisCampaignSequenceKey() {
  return "seq:campaign";
}

export function redisCampaignExecutionSequenceKey() {
  return "seq:campaignExecution";
}

export function redisCampaignDefinitionKey(campaignId) {
  const cid = requireKeyPart("campaignId", campaignId);
  return `campaign:def:${cid}`;
}

export function redisCampaignIndexAllKey() {
  return "campaign:index:all";
}

export function redisCampaignIndexActiveKey() {
  return "campaign:index:active";
}

export function redisCampaignIndexCategoryKey(category) {
  const cat = requireKeyPart("category", category).toLowerCase();
  return `campaign:index:category:${cat}`;
}

export function redisCampaignIndexCodeKey(code) {
  const normalized = normalizeCampaignCode(code);
  return `campaign:index:code:${normalized}`;
}

export function redisCampaignUserStateKey(campaignId, userId) {
  const cid = requireKeyPart("campaignId", campaignId);
  const uid = requireKeyPart("userId", userId);
  return `campaign:userstate:${cid}:${uid}`;
}

export function redisCampaignLogGlobalKey() {
  return "campaign:log:global";
}

export function redisCampaignLogUserKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `campaign:log:user:${uid}`;
}

export function redisCampaignLogCampaignKey(campaignId) {
  const cid = requireKeyPart("campaignId", campaignId);
  return `campaign:log:campaign:${cid}`;
}

export function redisCampaignCooldownKey(campaignId, userId) {
  const cid = requireKeyPart("campaignId", campaignId);
  const uid = requireKeyPart("userId", userId);
  return `campaign:cooldown:${cid}:${uid}`;
}

export function redisCampaignConflictGlobalKey() {
  return "campaign:conflict:global";
}

export function redisCampaignPendingUserKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `campaign:pending:${uid}`;
}

export function redisCampaignDeliveryKey(campaignId, userId, executionId) {
  const cid = requireKeyPart("campaignId", campaignId);
  const uid = requireKeyPart("userId", userId);
  const eid = requireKeyPart("executionId", executionId);
  return `campaign:delivery:${cid}:${uid}:${eid}`;
}

export async function redisNextCampaignSequence() {
  return redisIncrBy(redisCampaignSequenceKey(), 1);
}

export async function redisNextCampaignExecutionSequence() {
  return redisIncrBy(redisCampaignExecutionSequenceKey(), 1);
}
