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

const REDIS_OPERATIONAL_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  DOWN: "DOWN",
});

const REDIS_ERROR_CODE = Object.freeze({
  ENV: "REDIS_ENV_ERROR",
  NETWORK: "REDIS_NETWORK_ERROR",
  HTTP: "REDIS_HTTP_ERROR",
  PARSE: "REDIS_PARSE_ERROR",
  UNKNOWN: "REDIS_UNKNOWN_ERROR",
});

const REDIS_DEGRADED_FAILURE_THRESHOLD = 1;
const REDIS_DOWN_FAILURE_THRESHOLD = 3;
const REDIS_RECOVERY_SUCCESS_THRESHOLD = 2;

const redisHealthState = {
  status: REDIS_OPERATIONAL_STATUS.HEALTHY,
  lastErrorAt: 0,
  lastSuccessAt: 0,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  lastErrorCode: "",
  lastErrorMessage: "",
  lastFailingCommand: "",
  lastRecoveredAt: 0,
};

function nowMs() {
  return Date.now();
}

function safeStr(value) {
  return String(value ?? "").trim();
}

function buildRedisErrorMessage(prefix, detail, { path = "", bodyLen = 0 } = {}) {
  const parts = [safeStr(prefix), safeStr(detail)].filter(Boolean);
  const base = parts.join(": ") || "Redis error";
  return `${base} cmdPath=${path} bodyLen=${Number(bodyLen) || 0}`;
}

function buildRedisOperationalError({
  errorCode = REDIS_ERROR_CODE.UNKNOWN,
  message = "Redis operation failed",
  path = "",
  bodyLen = 0,
  cause = null,
} = {}) {
  const err = new Error(buildRedisErrorMessage("Upstash", message, { path, bodyLen }));
  err.name = "RedisOperationalError";
  err.errorCode = safeStr(errorCode) || REDIS_ERROR_CODE.UNKNOWN;
  err.cmdPath = safeStr(path);
  err.bodyLen = Number(bodyLen) || 0;
  if (cause) err.cause = cause;
  return err;
}

function classifyRedisError(err) {
  const message = safeStr(err?.message || err);
  if (message.includes("UPSTASH_REDIS_REST_URL") || message.includes("UPSTASH_REDIS_REST_TOKEN") || message.includes("Missing UPSTASH")) {
    return REDIS_ERROR_CODE.ENV;
  }
  if (message.includes("NETWORK_ERROR")) {
    return REDIS_ERROR_CODE.NETWORK;
  }
  if (message.includes("HTTP")) {
    return REDIS_ERROR_CODE.HTTP;
  }
  if (message.includes("PARSE_ERROR")) {
    return REDIS_ERROR_CODE.PARSE;
  }
  return REDIS_ERROR_CODE.UNKNOWN;
}

function markRedisSuccess() {
  const previousStatus = redisHealthState.status;
  redisHealthState.lastSuccessAt = nowMs();
  redisHealthState.consecutiveSuccesses += 1;
  redisHealthState.consecutiveFailures = 0;

  if (
    previousStatus !== REDIS_OPERATIONAL_STATUS.HEALTHY &&
    redisHealthState.consecutiveSuccesses >= REDIS_RECOVERY_SUCCESS_THRESHOLD
  ) {
    redisHealthState.status = REDIS_OPERATIONAL_STATUS.HEALTHY;
    redisHealthState.lastRecoveredAt = redisHealthState.lastSuccessAt;
  }
}

function markRedisFailure({ errorCode = "", message = "", command = "" } = {}) {
  redisHealthState.lastErrorAt = nowMs();
  redisHealthState.consecutiveFailures += 1;
  redisHealthState.consecutiveSuccesses = 0;
  redisHealthState.lastErrorCode = safeStr(errorCode);
  redisHealthState.lastErrorMessage = safeStr(message);
  redisHealthState.lastFailingCommand = safeStr(command);

  if (redisHealthState.consecutiveFailures >= REDIS_DOWN_FAILURE_THRESHOLD) {
    redisHealthState.status = REDIS_OPERATIONAL_STATUS.DOWN;
    return;
  }

  if (redisHealthState.consecutiveFailures >= REDIS_DEGRADED_FAILURE_THRESHOLD) {
    redisHealthState.status = REDIS_OPERATIONAL_STATUS.DEGRADED;
  }
}

function summarizeRedisHealth(state = redisHealthState) {
  const status = safeStr(state?.status) || REDIS_OPERATIONAL_STATUS.HEALTHY;
  if (status === REDIS_OPERATIONAL_STATUS.HEALTHY) {
    return "Redis healthy.";
  }
  if (status === REDIS_OPERATIONAL_STATUS.DOWN) {
    return `Redis down. Last error: ${safeStr(state?.lastErrorCode)} ${safeStr(state?.lastErrorMessage)}`.trim();
  }
  return `Redis degraded. Last error: ${safeStr(state?.lastErrorCode)} ${safeStr(state?.lastErrorMessage)}`.trim();
}

export function getRedisHealthSnapshot() {
  return {
    status: redisHealthState.status,
    lastErrorAt: redisHealthState.lastErrorAt || 0,
    lastSuccessAt: redisHealthState.lastSuccessAt || 0,
    consecutiveFailures: redisHealthState.consecutiveFailures || 0,
    consecutiveSuccesses: redisHealthState.consecutiveSuccesses || 0,
    lastErrorCode: safeStr(redisHealthState.lastErrorCode),
    lastErrorMessage: safeStr(redisHealthState.lastErrorMessage),
    lastFailingCommand: safeStr(redisHealthState.lastFailingCommand),
    lastRecoveredAt: redisHealthState.lastRecoveredAt || 0,
    summary: summarizeRedisHealth(redisHealthState),
  };
}

export function isRedisOperationallyDegraded() {
  return getRedisHealthSnapshot().status !== REDIS_OPERATIONAL_STATUS.HEALTHY;
}

function assertRedisEnv() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw buildRedisOperationalError({
      errorCode: REDIS_ERROR_CODE.ENV,
      message: "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN",
      path: "env",
      bodyLen: 0,
    });
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
  } catch (err) {
    const errorCode = REDIS_ERROR_CODE.NETWORK;
    const wrapped = buildRedisOperationalError({
      errorCode,
      message: `NETWORK_ERROR msg=${String(err?.message || err)}`,
      path,
      bodyLen: hasBody ? bodyText.length : 0,
      cause: err,
    });
    markRedisFailure({
      errorCode,
      message: safeStr(wrapped.message),
      command: safeStr(path),
    });
    throw wrapped;
  }

  try {
    data = await res.json().catch(() => {
      throw buildRedisOperationalError({
        errorCode: REDIS_ERROR_CODE.PARSE,
        message: "PARSE_ERROR invalid JSON response",
        path,
        bodyLen: hasBody ? bodyText.length : 0,
      });
    });
  } catch (err) {
    const errorCode = safeStr(err?.errorCode) || classifyRedisError(err);
    markRedisFailure({
      errorCode,
      message: safeStr(err?.message || err),
      command: safeStr(path),
    });
    throw err;
  }

  if (!res.ok) {
    const base = data?.error ? `${data.error}` : `HTTP ${res.status}`;
    const wrapped = buildRedisOperationalError({
      errorCode: REDIS_ERROR_CODE.HTTP,
      message: base,
      path,
      bodyLen: hasBody ? bodyText.length : 0,
    });
    markRedisFailure({
      errorCode: REDIS_ERROR_CODE.HTTP,
      message: safeStr(wrapped.message),
      command: safeStr(path),
    });
    throw wrapped;
  }

  if (data?.error) {
    const wrapped = buildRedisOperationalError({
      errorCode: REDIS_ERROR_CODE.HTTP,
      message: `${data.error}`,
      path,
      bodyLen: hasBody ? bodyText.length : 0,
    });
    markRedisFailure({
      errorCode: REDIS_ERROR_CODE.HTTP,
      message: safeStr(wrapped.message),
      command: safeStr(path),
    });
    throw wrapped;
  }

  markRedisSuccess();
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

function buildRedisSafeResult({
  ok = false,
  degraded = false,
  value = null,
  errorCode = "",
  message = "",
  status = "",
} = {}) {
  return {
    ok: Boolean(ok),
    degraded: Boolean(degraded),
    value,
    errorCode: safeStr(errorCode),
    message: safeStr(message),
    status: safeStr(status) || getRedisHealthSnapshot().status,
  };
}

async function executeRedisSafe(op, options = {}) {
  const {
    fallbackValue = null,
    critical = false,
    suppressThrow = false,
    module = "",
    step = "",
  } = options || {};

  try {
    const value = await op();
    return buildRedisSafeResult({
      ok: true,
      degraded: false,
      value,
      status: getRedisHealthSnapshot().status,
    });
  } catch (error) {
    const errorCode = safeStr(error?.errorCode) || classifyRedisError(error);
    const message = safeStr(error?.message || error);
    const status = getRedisHealthSnapshot().status;

    const shouldThrow = Boolean(critical) && !Boolean(suppressThrow);
    if (shouldThrow) {
      throw error;
    }

    try {
      console.warn(JSON.stringify({
        level: "warn",
        tag: "redis_safe_degraded",
        module: safeStr(module),
        step: safeStr(step),
        errorCode,
        status,
        message,
      }));
    } catch {}

    return buildRedisSafeResult({
      ok: false,
      degraded: true,
      value: fallbackValue,
      errorCode,
      message,
      status,
    });
  }
}

export async function redisSafeGet(key, options = {}) {
  return executeRedisSafe(() => redisGet(key), options);
}

export async function redisSafeSet(key, value, options = {}) {
  return executeRedisSafe(() => redisSet(key, value), options);
}

export async function redisSafeDel(key, options = {}) {
  return executeRedisSafe(() => redisDel(key), options);
}

export async function redisSafeIncrBy(key, delta = 1, options = {}) {
  return executeRedisSafe(() => redisIncrBy(key, delta), options);
}

export async function redisSafeType(key, options = {}) {
  return executeRedisSafe(() => redisType(key), options);
}

export async function redisSafeExpire(key, seconds, options = {}) {
  return executeRedisSafe(() => redisExpire(key, seconds), options);
}

export async function redisSafeLPush(key, value, options = {}) {
  return executeRedisSafe(() => redisLPush(key, value), options);
}

export async function redisSafeLRange(key, start = 0, stop = 49, options = {}) {
  return executeRedisSafe(() => redisLRange(key, start, stop), options);
}

export async function redisSafeLTrim(key, start = 0, stop = 99, options = {}) {
  return executeRedisSafe(() => redisLTrim(key, start, stop), options);
}

export async function redisSafeLLen(key, options = {}) {
  return executeRedisSafe(() => redisLLen(key), options);
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

export async function redisSafeSAdd(key, members, options = {}) {
  const list = Array.isArray(members) ? members : [members];
  return executeRedisSafe(() => redisSAdd(key, list), options);
}

export async function redisSafeSRem(key, members, options = {}) {
  const list = Array.isArray(members) ? members : [members];
  return executeRedisSafe(() => redisSRem(key, list), options);
}

export async function redisSafeSMembers(key, options = {}) {
  return executeRedisSafe(() => redisSMembers(key), options);
}

export async function redisSafeSIsMember(key, member, options = {}) {
  return executeRedisSafe(() => redisSIsMember(key, member), options);
}

export async function redisSafeSCard(key, options = {}) {
  return executeRedisSafe(() => redisSCard(key), options);
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

export async function redisSafeZAdd(key, score, member, options = {}) {
  return executeRedisSafe(() => redisZAdd(key, score, member), options);
}

export async function redisSafeZRem(key, member, options = {}) {
  return executeRedisSafe(() => redisZRem(key, member), options);
}

export async function redisSafeZScore(key, member, options = {}) {
  return executeRedisSafe(() => redisZScore(key, member), options);
}

export async function redisSafeZCount(key, min, max, options = {}) {
  return executeRedisSafe(() => redisZCount(key, min, max), options);
}

export async function redisSafeZRangeByScore(key, min, max, limit = 1000, options = {}) {
  return executeRedisSafe(() => redisZRangeByScore(key, min, max, limit), options);
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


// -----------------
// Identity Conflict Keys
// -----------------

export function redisIdentityConflictSequenceKey() {
  return "seq:identityConflict";
}

export function redisIdentityConflictKey(conflictId) {
  const cid = requireKeyPart("conflictId", conflictId);
  return `identityConflict:${cid}`;
}

export function redisIdentityConflictPendingIndexKey() {
  return "idx:identityConflict:pending";
}

export function redisIdentityConflictResolvedIndexKey() {
  return "idx:identityConflict:resolved";
}

export function redisIdentityConflictStatusIndexKey(status) {
  const s = requireKeyPart("status", status).toLowerCase();
  return `idx:identityConflict:status:${s}`;
}

export function redisIdentityConflictUserIndexKey(userId) {
  const uid = requireKeyPart("userId", userId);
  return `idx:user:${uid}:identityConflict`;
}

export function redisIdentityConflictAliasIndexKey(kind, value) {
  const k = requireKeyPart("kind", kind).toLowerCase();
  const v = requireKeyPart("value", value);
  return `idx:identityConflict:alias:${k}:${v}`;
}

export function redisIdentityConflictWaIdIndexKey(waId) {
  return redisIdentityConflictAliasIndexKey("waid", waId);
}

export function redisIdentityConflictBsuidIndexKey(bsuid) {
  return redisIdentityConflictAliasIndexKey("bsuid", bsuid);
}

export async function redisNextIdentityConflictSequence() {
  return redisIncrBy(redisIdentityConflictSequenceKey(), 1);
}
