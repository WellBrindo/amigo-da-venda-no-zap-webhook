// src/services/identity.js
// Camada central de identidade canônica do sistema.
// Objetivo:
// - Resolver usuários por aliases externos (waId / bsuid)
// - Criar internalUserId canônico do sistema
// - Vincular aliases ao mesmo usuário
// - Persistir conflitos de identidade para revisão manual no Admin
// - Expor helpers de leitura para os demais serviços

import {
  redisGet,
  redisSet,
  redisDel,
  redisSAdd,
  redisSRem,
  redisSMembers,
  redisUserIdentifiersKey,
  redisAliasWaIdKey,
  redisAliasBsuidKey,
  redisNextUserSequence,
  redisIdentityConflictKey,
  redisIdentityConflictPendingIndexKey,
  redisIdentityConflictResolvedIndexKey,
  redisIdentityConflictStatusIndexKey,
  redisIdentityConflictUserIndexKey,
  redisIdentityConflictWaIdIndexKey,
  redisIdentityConflictBsuidIndexKey,
  redisNextIdentityConflictSequence,
  redisSafeGet,
  redisSafeSMembers,
  getRedisHealthSnapshot,
} from "./redis.js";
import * as audit from "./audit.js";
import { raiseSystemIncident } from "./alerts.js";

export const IDENTITY_CONFLICT_STATUS = Object.freeze({
  PENDING_REVIEW: "PENDING_REVIEW",
  RESOLVED: "RESOLVED",
  DISMISSED: "DISMISSED",
  ARCHIVED: "ARCHIVED",
});

const IDENTITY_CONFLICT_AUDIT_EVENT = Object.freeze({
  DETECTED: "IDENTITY_CONFLICT_DETECTED",
  REOPENED: "IDENTITY_CONFLICT_REOPENED",
  REVIEWED: "IDENTITY_CONFLICT_REVIEWED",
  RESOLVED: "IDENTITY_CONFLICT_RESOLVED",
  DISMISSED: "IDENTITY_CONFLICT_DISMISSED",
  ARCHIVED: "IDENTITY_CONFLICT_ARCHIVED",
  SENSITIVE_OP_BLOCKED: "IDENTITY_CONFLICT_SENSITIVE_OP_BLOCKED",
  MERGED: "IDENTITY_CONFLICT_MERGED",
  ALIASES_REASSIGNED: "IDENTITY_CONFLICT_ALIASES_REASSIGNED",
  USERS_SEPARATED: "IDENTITY_CONFLICT_USERS_SEPARATED",
  USER_BLOCKED: "IDENTITY_CONFLICT_USER_BLOCKED",
});

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(value) {
  return String(value ?? "").trim();
}

function toNullable(value) {
  const text = safeStr(value);
  return text || null;
}

function normalizeWaId(value) {
  const text = safeStr(value).replace(/\D+/g, "");
  return text || null;
}

function normalizeBsuid(value) {
  const text = safeStr(value);
  return text || null;
}

function tryJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function normalizeConflictStatus(value) {
  const status = safeStr(value).toUpperCase();
  return Object.values(IDENTITY_CONFLICT_STATUS).includes(status)
    ? status
    : IDENTITY_CONFLICT_STATUS.PENDING_REVIEW;
}

function formatInternalUserId(sequence) {
  const n = Number(sequence);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`formatInternalUserId: invalid sequence=${sequence}`);
  }
  return `usr_${String(Math.trunc(n)).padStart(6, "0")}`;
}

function formatIdentityConflictId(sequence) {
  const n = Number(sequence);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`formatIdentityConflictId: invalid sequence=${sequence}`);
  }
  return `icf_${String(Math.trunc(n)).padStart(6, "0")}`;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => safeStr(item)).filter(Boolean))];
}

function buildIdentifiersRecord({
  internalUserId,
  waId = null,
  bsuid = null,
  primaryDeliveryId = null,
  createdAt = null,
  updatedAt = null,
  lastSeenWaId = null,
  lastSeenBsuid = null,
} = {}) {
  const now = nowMs();
  const record = {
    internalUserId: safeStr(internalUserId),
    waId: toNullable(waId),
    bsuid: toNullable(bsuid),
    primaryDeliveryId: toNullable(primaryDeliveryId),
    createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : now,
    updatedAt: Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : now,
    lastSeenWaId: toNullable(lastSeenWaId),
    lastSeenBsuid: toNullable(lastSeenBsuid),
  };

  if (!record.primaryDeliveryId) {
    record.primaryDeliveryId = record.waId || record.bsuid || null;
  }
  if (!record.lastSeenWaId && record.waId) {
    record.lastSeenWaId = record.waId;
  }
  if (!record.lastSeenBsuid && record.bsuid) {
    record.lastSeenBsuid = record.bsuid;
  }

  return record;
}

function buildIdentityConflictRecord({
  conflictId,
  status = IDENTITY_CONFLICT_STATUS.PENDING_REVIEW,
  waId = null,
  bsuid = null,
  waUserId = null,
  bsuidUserId = null,
  detectedAt = null,
  updatedAt = null,
  lastSeenAt = null,
  timesDetected = 1,
  reviewDecision = null,
  reviewedBy = null,
  reviewedAt = null,
  notes = null,
  allowConversation = true,
  blockSensitiveOps = true,
} = {}) {
  const now = nowMs();
  const normalizedStatus = normalizeConflictStatus(status);
  return {
    conflictId: safeStr(conflictId),
    status: normalizedStatus,
    waId: normalizeWaId(waId),
    bsuid: normalizeBsuid(bsuid),
    waUserId: toNullable(waUserId),
    bsuidUserId: toNullable(bsuidUserId),
    detectedAt: Number.isFinite(Number(detectedAt)) ? Number(detectedAt) : now,
    updatedAt: Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : now,
    lastSeenAt: Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : now,
    timesDetected: Math.max(1, Number.isFinite(Number(timesDetected)) ? Math.trunc(Number(timesDetected)) : 1),
    reviewDecision: toNullable(reviewDecision),
    reviewedBy: toNullable(reviewedBy),
    reviewedAt: Number.isFinite(Number(reviewedAt)) ? Number(reviewedAt) : null,
    notes: toNullable(notes),
    allowConversation: allowConversation !== false,
    blockSensitiveOps: blockSensitiveOps !== false,
  };
}

async function safeLogIdentityConflictAudit(input = {}) {
  try {
    if (typeof audit?.logIdentityConflictAudit === "function") {
      await audit.logIdentityConflictAudit(input);
      return;
    }
    if (typeof audit?.logAdminAudit === "function") {
      await audit.logAdminAudit({
        module: "IDENTITY_CONFLICT",
        action: safeStr(input.action || input.event),
        targetId: safeStr(input.conflictId || input.targetId),
        targetLabel: "identity_conflict",
        summary: safeStr(input.summary || input.message || input.action),
        actor: input.actor && typeof input.actor === "object" ? input.actor : {},
        meta: {
          conflictId: safeStr(input.conflictId),
          waUserId: safeStr(input.waUserId),
          bsuidUserId: safeStr(input.bsuidUserId),
          status: safeStr(input.status),
          reviewDecision: safeStr(input.reviewDecision),
          reviewedBy: safeStr(input.reviewedBy),
          waId: safeStr(input.waId),
          bsuid: safeStr(input.bsuid),
          ...(input.meta && typeof input.meta === "object" ? input.meta : {}),
        },
        before: input.before && typeof input.before === "object" ? input.before : {},
        after: input.after && typeof input.after === "object" ? input.after : {},
      });
    }
  } catch {
    // best effort
  }
}

function getIdentityRedisStatus() {
  try {
    return safeStr(getRedisHealthSnapshot?.()?.status) || "DEGRADED";
  } catch {
    return "DEGRADED";
  }
}

async function reportIdentityRedisIncident({
  step = "",
  errorCode = "IDENTITY_REDIS_DEGRADED",
  message = "",
  internalUserId = "",
  waId = "",
  bsuid = "",
  impact = "",
  severity = "HIGH",
  fallbackUsed = false,
  criticalBlocked = false,
  meta = {},
} = {}) {
  const redisStatus = getIdentityRedisStatus();

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent({
        module: "identity",
        event: criticalBlocked ? "identity_redis_critical_blocked" : "identity_redis_degraded",
        level: criticalBlocked ? "error" : "warn",
        userId: safeStr(internalUserId),
        step: safeStr(step),
        message: safeStr(message) || "Identity Redis degradation detected.",
        errorCode: safeStr(errorCode),
        status: criticalBlocked ? "blocked" : "degraded",
        meta: {
          waId: safeStr(waId),
          bsuid: safeStr(bsuid),
          impact: safeStr(impact),
          redisStatus,
          fallbackUsed: Boolean(fallbackUsed),
          criticalBlocked: Boolean(criticalBlocked),
          ...(meta && typeof meta === "object" ? meta : {}),
        },
      });
    }
  } catch {}

  try {
    await raiseSystemIncident({
      type: "REDIS",
      severity: safeStr(severity) || "HIGH",
      module: "identity",
      step: safeStr(step),
      errorCode: safeStr(errorCode),
      message: safeStr(message) || "Identity Redis degradation detected.",
      impact: safeStr(impact),
      dedupeKey: ["identity", safeStr(step), safeStr(errorCode), safeStr(impact), safeStr(internalUserId), safeStr(waId), safeStr(bsuid)].filter(Boolean).join("|"),
      meta: {
        internalUserId: safeStr(internalUserId),
        waId: safeStr(waId),
        bsuid: safeStr(bsuid),
        redisStatus,
        fallbackUsed: Boolean(fallbackUsed),
        criticalBlocked: Boolean(criticalBlocked),
        ...(meta && typeof meta === "object" ? meta : {}),
      },
    });
  } catch {}
}

async function safeIdentityRead(action, fallback, context = {}) {
  try {
    const result = await action();

    if (context.critical && (result === null || result === undefined || result === fallback)) {
      await reportIdentityRedisIncident({
        step: safeStr(context.step || "identity_read"),
        errorCode: safeStr(context.errorCode || "IDENTITY_CRITICAL_READ_UNCERTAIN"),
        message: "Critical identity read returned fallback/empty value.",
        internalUserId: safeStr(context.internalUserId),
        waId: safeStr(context.waId),
        bsuid: safeStr(context.bsuid),
        impact: safeStr(context.impact || "identity_critical_read_uncertain"),
        severity: safeStr(context.severity || "CRITICAL"),
        fallbackUsed: true,
        criticalBlocked: true,
        meta: context.meta && typeof context.meta === "object" ? context.meta : {},
      });
      throw new Error("Critical identity read could not be trusted.");
    }

    return result;
  } catch (error) {
    await reportIdentityRedisIncident({
      step: safeStr(context.step || "identity_read"),
      errorCode: safeStr(context.errorCode || (context.critical ? "IDENTITY_CRITICAL_READ_BLOCKED" : "IDENTITY_READ_FALLBACK")),
      message: safeStr(error?.message || error),
      internalUserId: safeStr(context.internalUserId),
      waId: safeStr(context.waId),
      bsuid: safeStr(context.bsuid),
      impact: safeStr(context.impact || (context.critical ? "identity_critical_read_blocked" : "identity_read_fallback")),
      severity: safeStr(context.severity || (context.critical ? "CRITICAL" : "MEDIUM")),
      fallbackUsed: !context.critical,
      criticalBlocked: Boolean(context.critical),
      meta: context.meta && typeof context.meta === "object" ? context.meta : {},
    });

    if (context.critical) {
      throw error;
    }

    return fallback;
  }
}

async function criticalIdentityWrite(action, context = {}) {
  try {
    const result = await action();

    if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "ok") && result.ok === false) {
      throw new Error(safeStr(result.message) || "Critical identity write returned ok=false.");
    }

    return result;
  } catch (error) {
    await reportIdentityRedisIncident({
      step: safeStr(context.step || "identity_write"),
      errorCode: safeStr(context.errorCode || "IDENTITY_CRITICAL_WRITE_BLOCKED"),
      message: safeStr(error?.message || error),
      internalUserId: safeStr(context.internalUserId),
      waId: safeStr(context.waId),
      bsuid: safeStr(context.bsuid),
      impact: safeStr(context.impact || "identity_consistency_blocked"),
      severity: safeStr(context.severity || "CRITICAL"),
      criticalBlocked: true,
      meta: context.meta && typeof context.meta === "object" ? context.meta : {},
    });
    throw error;
  }
}

async function readIdentifiersRecordCritical(userId, context = {}) {
  const record = await safeIdentityRead(
    () => readIdentifiersRecord(userId),
    null,
    {
      ...context,
      critical: true,
      step: safeStr(context.step || "read_identifiers_record_critical"),
      internalUserId: safeStr(userId),
      impact: safeStr(context.impact || "identity_identifiers_critical_read"),
      severity: safeStr(context.severity || "CRITICAL"),
    }
  );

  if (!record || safeStr(record.internalUserId) !== safeStr(userId)) {
    await reportIdentityRedisIncident({
      step: safeStr(context.step || "read_identifiers_record_critical"),
      errorCode: "IDENTITY_CRITICAL_IDENTIFIERS_MISSING",
      message: "Critical identifiers record missing or mismatched.",
      internalUserId: safeStr(userId),
      impact: safeStr(context.impact || "identity_identifiers_missing"),
      severity: "CRITICAL",
      criticalBlocked: true,
    });
    throw new Error("Critical identifiers record missing or mismatched.");
  }

  return record;
}

async function readIdentifiersRecord(userId) {
  const raw = await safeIdentityRead(
    () => redisSafeGet(redisUserIdentifiersKey(userId), {
      fallbackValue: "",
      critical: false,
      module: "identity",
      step: "read_identifiers_record",
      suppressThrow: true,
    }).then((result) => (result?.ok ? result.value : result?.value)),
    "",
    {
      step: "read_identifiers_record",
      internalUserId: safeStr(userId),
      impact: "identity_identifiers_read_fallback",
      severity: "MEDIUM",
    }
  );
  if (!raw) return null;

  const parsed = tryJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") return null;

  return buildIdentifiersRecord({
    internalUserId: safeStr(parsed.internalUserId || userId),
    waId: normalizeWaId(parsed.waId),
    bsuid: normalizeBsuid(parsed.bsuid),
    primaryDeliveryId: parsed.primaryDeliveryId,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    lastSeenWaId: normalizeWaId(parsed.lastSeenWaId),
    lastSeenBsuid: normalizeBsuid(parsed.lastSeenBsuid),
  });
}

async function writeIdentifiersRecord(userId, payload) {
  const record = buildIdentifiersRecord({
    internalUserId: userId,
    ...(payload || {}),
  });
  await criticalIdentityWrite(() => redisSet(redisUserIdentifiersKey(userId), JSON.stringify(record)), { step: "write_identifiers_record", internalUserId: userId, waId: record.waId, bsuid: record.bsuid, impact: "identity_identifiers_write_blocked" });
  return record;
}

async function createInternalUserId() {
  const seq = await criticalIdentityWrite(() => redisNextUserSequence(), { step: "create_internal_user_sequence", impact: "identity_sequence_blocked", severity: "CRITICAL" });
  return formatInternalUserId(seq);
}

async function createIdentityConflictId() {
  const seq = await criticalIdentityWrite(() => redisNextIdentityConflictSequence(), { step: "create_identity_conflict_sequence", impact: "identity_conflict_sequence_blocked", severity: "HIGH" });
  return formatIdentityConflictId(seq);
}

async function readIdentityConflictRecord(conflictId) {
  const id = safeStr(conflictId);
  if (!id) return null;
  const raw = await safeIdentityRead(
    () => redisSafeGet(redisIdentityConflictKey(id), {
      fallbackValue: "",
      critical: false,
      module: "identity",
      step: "read_identity_conflict_record",
      suppressThrow: true,
    }).then((result) => (result?.ok ? result.value : result?.value)),
    "",
    {
      step: "read_identity_conflict_record",
      impact: "identity_conflict_read_fallback",
      severity: "LOW",
    }
  );
  if (!raw) return null;
  const parsed = tryJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") return null;
  return buildIdentityConflictRecord(parsed);
}

async function writeIdentityConflictRecord(record) {
  const next = buildIdentityConflictRecord(record);
  await criticalIdentityWrite(() => redisSet(redisIdentityConflictKey(next.conflictId), JSON.stringify(next)), { step: "write_identity_conflict_record", internalUserId: next.waUserId || next.bsuidUserId, waId: next.waId, bsuid: next.bsuid, impact: "identity_conflict_write_blocked", severity: "HIGH" });
  return next;
}

async function addConflictToIndexes(record) {
  const jobs = [
    criticalIdentityWrite(() => redisSAdd(redisIdentityConflictStatusIndexKey(record.status), record.conflictId), { step: "add_conflict_status_index", internalUserId: record.waUserId || record.bsuidUserId, waId: record.waId, bsuid: record.bsuid, impact: "identity_conflict_index_blocked", severity: "HIGH" }),
    criticalIdentityWrite(() => redisSAdd(redisIdentityConflictUserIndexKey(record.waUserId), record.conflictId), { step: "add_conflict_user_index_wa", internalUserId: record.waUserId, waId: record.waId, impact: "identity_conflict_index_blocked", severity: "HIGH" }),
    criticalIdentityWrite(() => redisSAdd(redisIdentityConflictUserIndexKey(record.bsuidUserId), record.conflictId), { step: "add_conflict_user_index_bsuid", internalUserId: record.bsuidUserId, bsuid: record.bsuid, impact: "identity_conflict_index_blocked", severity: "HIGH" }),
  ];

  if (record.waId) jobs.push(criticalIdentityWrite(() => redisSAdd(redisIdentityConflictWaIdIndexKey(record.waId), record.conflictId), { step: "add_conflict_wa_index", waId: record.waId, internalUserId: record.waUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  if (record.bsuid) jobs.push(criticalIdentityWrite(() => redisSAdd(redisIdentityConflictBsuidIndexKey(record.bsuid), record.conflictId), { step: "add_conflict_bsuid_index", bsuid: record.bsuid, internalUserId: record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));

  if (record.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) {
    jobs.push(criticalIdentityWrite(() => redisSAdd(redisIdentityConflictPendingIndexKey(), record.conflictId), { step: "add_conflict_pending_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictResolvedIndexKey(), record.conflictId), { step: "remove_conflict_resolved_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  } else if (record.status === IDENTITY_CONFLICT_STATUS.RESOLVED) {
    jobs.push(criticalIdentityWrite(() => redisSAdd(redisIdentityConflictResolvedIndexKey(), record.conflictId), { step: "add_conflict_resolved_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictPendingIndexKey(), record.conflictId), { step: "remove_conflict_pending_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  } else {
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictPendingIndexKey(), record.conflictId), { step: "remove_conflict_pending_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictResolvedIndexKey(), record.conflictId), { step: "remove_conflict_resolved_index", internalUserId: record.waUserId || record.bsuidUserId, impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  }

  await Promise.all(jobs);
}

async function removeConflictFromStatusIndexes(conflictId, previousStatus) {
  const id = safeStr(conflictId);
  const prev = normalizeConflictStatus(previousStatus);
  const jobs = [criticalIdentityWrite(() => redisSRem(redisIdentityConflictStatusIndexKey(prev), id), { step: "remove_conflict_status_index", impact: "identity_conflict_index_blocked", severity: "HIGH" })];

  if (prev === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) {
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictPendingIndexKey(), id), { step: "remove_pending_index", impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  }
  if (prev === IDENTITY_CONFLICT_STATUS.RESOLVED) {
    jobs.push(criticalIdentityWrite(() => redisSRem(redisIdentityConflictResolvedIndexKey(), id), { step: "remove_resolved_index", impact: "identity_conflict_index_blocked", severity: "HIGH" }));
  }

  await Promise.all(jobs);
}

async function resolveExistingConflictId({ waId = null, bsuid = null, waUserId = null, bsuidUserId = null } = {}) {
  const candidates = new Set();

  if (waId) {
    const ids = await safeIdentityRead(
      () => redisSafeSMembers(redisIdentityConflictWaIdIndexKey(waId), {
        fallbackValue: [],
        critical: false,
        module: "identity",
        step: "resolve_existing_conflict:wa_index",
        suppressThrow: true,
      }).then((result) => (result?.ok ? result.value : result?.value)),
      [],
      { step: "resolve_existing_conflict:wa_index", waId, impact: "identity_conflict_index_fallback", severity: "LOW" }
    );
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (bsuid) {
    const ids = await safeIdentityRead(
      () => redisSafeSMembers(redisIdentityConflictBsuidIndexKey(bsuid), {
        fallbackValue: [],
        critical: false,
        module: "identity",
        step: "resolve_existing_conflict:bsuid_index",
        suppressThrow: true,
      }).then((result) => (result?.ok ? result.value : result?.value)),
      [],
      { step: "resolve_existing_conflict:bsuid_index", bsuid, impact: "identity_conflict_index_fallback", severity: "LOW" }
    );
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (waUserId) {
    const ids = await safeIdentityRead(
      () => redisSafeSMembers(redisIdentityConflictUserIndexKey(waUserId), {
        fallbackValue: [],
        critical: false,
        module: "identity",
        step: "resolve_existing_conflict:wa_user_index",
        suppressThrow: true,
      }).then((result) => (result?.ok ? result.value : result?.value)),
      [],
      { step: "resolve_existing_conflict:wa_user_index", internalUserId: waUserId, impact: "identity_conflict_index_fallback", severity: "LOW" }
    );
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (bsuidUserId) {
    const ids = await safeIdentityRead(
      () => redisSafeSMembers(redisIdentityConflictUserIndexKey(bsuidUserId), {
        fallbackValue: [],
        critical: false,
        module: "identity",
        step: "resolve_existing_conflict:bsuid_user_index",
        suppressThrow: true,
      }).then((result) => (result?.ok ? result.value : result?.value)),
      [],
      { step: "resolve_existing_conflict:bsuid_user_index", internalUserId: bsuidUserId, impact: "identity_conflict_index_fallback", severity: "LOW" }
    );
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }

  for (const conflictId of candidates) {
    const conflict = await readIdentityConflictRecord(conflictId);
    if (!conflict) continue;

    const sameWaId = safeStr(conflict.waId) && safeStr(conflict.waId) === safeStr(waId);
    const sameBsuid = safeStr(conflict.bsuid) && safeStr(conflict.bsuid) === safeStr(bsuid);
    const samePair =
      safeStr(conflict.waUserId) === safeStr(waUserId) &&
      safeStr(conflict.bsuidUserId) === safeStr(bsuidUserId);

    if (samePair || (sameWaId && sameBsuid) || sameWaId || sameBsuid) {
      return conflict;
    }
  }

  return null;
}

function buildConflictResolutionResult(conflict) {
  const record = buildIdentityConflictRecord(conflict);
  return {
    conflict: true,
    created: false,
    reviewRequired: record.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW,
    conflictId: record.conflictId,
    allowConversation: record.allowConversation !== false,
    blockSensitiveOps: record.blockSensitiveOps !== false,
    conflictStatus: record.status,
    conflictRecord: record,
  };
}

export function extractInboundIdentifiers(payloadOrMessage = {}) {
  const root = payloadOrMessage || {};

  const directWaId = normalizeWaId(
    root?.waId ||
      root?.wa_id ||
      root?.from ||
      root?.message?.from ||
      root?.messages?.[0]?.from ||
      root?.contacts?.[0]?.wa_id ||
      root?.value?.contacts?.[0]?.wa_id
  );

  const directBsuid = normalizeBsuid(
    root?.bsuid ||
      root?.bsuId ||
      root?.business_scoped_user_id ||
      root?.businessScopedUserId ||
      root?.user_id ||
      root?.userId ||
      root?.message?.user_id ||
      root?.message?.business_scoped_user_id ||
      root?.messages?.[0]?.user_id ||
      root?.messages?.[0]?.business_scoped_user_id ||
      root?.contacts?.[0]?.user_id ||
      root?.contacts?.[0]?.business_scoped_user_id ||
      root?.value?.contacts?.[0]?.user_id ||
      root?.value?.contacts?.[0]?.business_scoped_user_id
  );

  const deliveryId = directWaId || directBsuid || null;
  const rawFrom = safeStr(root?.from || root?.message?.from || root?.messages?.[0]?.from);

  return {
    waId: directWaId,
    bsuid: directBsuid,
    deliveryId,
    rawFrom: rawFrom || null,
    source: "whatsapp_webhook",
  };
}

export async function getInternalUserIdByWaId(waId, options = {}) {
  const normalized = normalizeWaId(waId);
  if (!normalized) return null;
  const critical = Boolean(options.critical);
  const value = await safeIdentityRead(
    async () => {
      const result = await redisSafeGet(redisAliasWaIdKey(normalized), {
        fallbackValue: "",
        critical,
        module: "identity",
        step: "get_internal_user_by_waid",
        suppressThrow: !critical,
      });
      if (!result?.ok && critical) {
        throw new Error(safeStr(result?.message) || "Critical waId alias lookup failed.");
      }
      return result?.ok ? result.value : result?.value;
    },
    "",
    {
      step: "get_internal_user_by_waid",
      waId: normalized,
      impact: critical ? "identity_alias_lookup_critical_blocked" : "identity_alias_lookup_fallback",
      severity: critical ? "CRITICAL" : "MEDIUM",
      critical,
    }
  );
  return toNullable(value);
}

export async function getInternalUserIdByBsuid(bsuid, options = {}) {
  const normalized = normalizeBsuid(bsuid);
  if (!normalized) return null;
  const critical = Boolean(options.critical);
  const value = await safeIdentityRead(
    async () => {
      const result = await redisSafeGet(redisAliasBsuidKey(normalized), {
        fallbackValue: "",
        critical,
        module: "identity",
        step: "get_internal_user_by_bsuid",
        suppressThrow: !critical,
      });
      if (!result?.ok && critical) {
        throw new Error(safeStr(result?.message) || "Critical bsuid alias lookup failed.");
      }
      return result?.ok ? result.value : result?.value;
    },
    "",
    {
      step: "get_internal_user_by_bsuid",
      bsuid: normalized,
      impact: critical ? "identity_alias_lookup_critical_blocked" : "identity_alias_lookup_fallback",
      severity: critical ? "CRITICAL" : "MEDIUM",
      critical,
    }
  );
  return toNullable(value);
}

export async function getUserIdentifiers(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return null;
  return readIdentifiersRecord(userId);
}

export async function getIdentityConflict(conflictId) {
  return readIdentityConflictRecord(conflictId);
}

export async function listIdentityConflicts({ status = "", limit = 100 } = {}) {
  const normalizedStatus = safeStr(status).toUpperCase();
  const key = normalizedStatus
    ? redisIdentityConflictStatusIndexKey(normalizedStatus)
    : redisIdentityConflictPendingIndexKey();

  const ids = uniqueStrings(await safeIdentityRead(
    () => redisSafeSMembers(key, {
      fallbackValue: [],
      critical: false,
      module: "identity",
      step: "list_identity_conflicts",
      suppressThrow: true,
    }).then((result) => (result?.ok ? result.value : result?.value)),
    [],
    { step: "list_identity_conflicts", impact: "identity_conflict_list_fallback", severity: "LOW" }
  ));
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));

  const rows = [];
  for (const conflictId of ids) {
    if (rows.length >= lim) break;
    const row = await readIdentityConflictRecord(conflictId);
    if (row) rows.push(row);
  }

  return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function hasPendingIdentityConflictForUser(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return false;
  const ids = uniqueStrings(await safeIdentityRead(
    () => redisSafeSMembers(redisIdentityConflictUserIndexKey(userId), {
      fallbackValue: [],
      critical: false,
      module: "identity",
      step: "has_pending_conflict_for_user",
      suppressThrow: true,
    }).then((result) => (result?.ok ? result.value : result?.value)),
    [],
    { step: "has_pending_conflict_for_user", internalUserId: userId, impact: "identity_user_conflict_index_fallback", severity: "LOW" }
  ));
  for (const conflictId of ids) {
    const conflict = await readIdentityConflictRecord(conflictId);
    if (conflict?.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) return true;
  }
  return false;
}

export async function getPendingIdentityConflictForUser(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return null;
  const ids = uniqueStrings(await safeIdentityRead(
    () => redisSafeSMembers(redisIdentityConflictUserIndexKey(userId), {
      fallbackValue: [],
      critical: false,
      module: "identity",
      step: "get_pending_conflict_for_user",
      suppressThrow: true,
    }).then((result) => (result?.ok ? result.value : result?.value)),
    [],
    { step: "get_pending_conflict_for_user", internalUserId: userId, impact: "identity_user_conflict_index_fallback", severity: "LOW" }
  ));
  for (const conflictId of ids) {
    const conflict = await readIdentityConflictRecord(conflictId);
    if (conflict?.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) return conflict;
  }
  return null;
}

export async function shouldBlockSensitiveIdentityOps(internalUserId) {
  const conflict = await getPendingIdentityConflictForUser(internalUserId);
  if (!conflict) return false;

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.SENSITIVE_OP_BLOCKED,
    conflictId: conflict.conflictId,
    waUserId: conflict.waUserId,
    bsuidUserId: conflict.bsuidUserId,
    status: conflict.status,
    waId: conflict.waId,
    bsuid: conflict.bsuid,
    summary: "Operação sensível bloqueada por conflito de identidade pendente.",
  });

  return conflict.blockSensitiveOps !== false;
}

export async function updateIdentityConflictStatus(conflictId, input = {}) {
  const current = await readIdentityConflictRecord(conflictId);
  if (!current) throw new Error("Identity conflict not found.");

  const previous = { ...current };
  const nextStatus = normalizeConflictStatus(input.status || current.status);
  const now = nowMs();

  const next = buildIdentityConflictRecord({
    ...current,
    status: nextStatus,
    reviewDecision: input.reviewDecision ?? current.reviewDecision,
    reviewedBy: input.reviewedBy ?? current.reviewedBy,
    reviewedAt: input.reviewedBy || input.reviewedAt ? (Number(input.reviewedAt) || now) : current.reviewedAt,
    notes: input.notes ?? current.notes,
    updatedAt: now,
    lastSeenAt: current.lastSeenAt,
    allowConversation: input.allowConversation ?? current.allowConversation,
    blockSensitiveOps: input.blockSensitiveOps ?? current.blockSensitiveOps,
  });

  if (current.status !== next.status) {
    await removeConflictFromStatusIndexes(next.conflictId, current.status);
  }

  await writeIdentityConflictRecord(next);
  await addConflictToIndexes(next);

  const actionByStatus = {
    [IDENTITY_CONFLICT_STATUS.RESOLVED]: IDENTITY_CONFLICT_AUDIT_EVENT.RESOLVED,
    [IDENTITY_CONFLICT_STATUS.DISMISSED]: IDENTITY_CONFLICT_AUDIT_EVENT.DISMISSED,
    [IDENTITY_CONFLICT_STATUS.ARCHIVED]: IDENTITY_CONFLICT_AUDIT_EVENT.ARCHIVED,
  };

  await safeLogIdentityConflictAudit({
    action: actionByStatus[next.status] || IDENTITY_CONFLICT_AUDIT_EVENT.REVIEWED,
    conflictId: next.conflictId,
    waUserId: next.waUserId,
    bsuidUserId: next.bsuidUserId,
    status: next.status,
    reviewDecision: next.reviewDecision,
    reviewedBy: next.reviewedBy,
    waId: next.waId,
    bsuid: next.bsuid,
    summary: "Conflito de identidade atualizado manualmente.",
    before: previous,
    after: next,
  });

  return next;
}


function joinNotes(...parts) {
  return parts
    .map((part) => safeStr(part))
    .filter(Boolean)
    .join("\n\n")
    .trim() || null;
}

function appendConflictNote(existingNotes, nextNote) {
  return joinNotes(existingNotes, nextNote);
}

async function requireIdentityConflict(conflictId) {
  const id = safeStr(conflictId);
  const conflict = await safeIdentityRead(
    () => readIdentityConflictRecord(id),
    null,
    {
      critical: true,
      step: "require_identity_conflict",
      impact: "identity_conflict_required_for_manual_decision",
      severity: "CRITICAL",
      meta: { conflictId: id },
    }
  );
  if (!conflict) {
    throw new Error("Identity conflict not found.");
  }
  return conflict;
}

function ensureConflictTargetUser(conflict, targetUserId) {
  const target = safeStr(targetUserId);
  const waUserId = safeStr(conflict?.waUserId);
  const bsuidUserId = safeStr(conflict?.bsuidUserId);

  if (!target) {
    throw new Error("targetUserId is required.");
  }
  if (target !== waUserId && target !== bsuidUserId) {
    throw new Error("targetUserId must belong to the identity conflict.");
  }

  return {
    targetUserId: target,
    waUserId,
    bsuidUserId,
    otherUserId: target === waUserId ? bsuidUserId : waUserId,
  };
}

async function clearIdentifiersForUser(userId, { clearWaId = false, clearBsuid = false } = {}) {
  const targetUserId = safeStr(userId);
  if (!targetUserId) return null;

  const current = await readIdentifiersRecordCritical(targetUserId, {
    step: "clear_identifiers_for_user",
    impact: "identity_clear_alias_requires_trusted_record",
  });

  const next = {
    ...current,
    waId: clearWaId ? null : current.waId,
    bsuid: clearBsuid ? null : current.bsuid,
    lastSeenWaId: clearWaId ? null : current.lastSeenWaId,
    lastSeenBsuid: clearBsuid ? null : current.lastSeenBsuid,
    updatedAt: nowMs(),
  };

  next.primaryDeliveryId =
    next.waId ||
    next.bsuid ||
    null;

  await writeIdentifiersRecord(targetUserId, next);
  return next;
}

async function relinkConflictAliasesToUser(conflict, targetUserId, options = {}) {
  const winnerUserId = safeStr(targetUserId);
  const {
    waUserId,
    bsuidUserId,
  } = ensureConflictTargetUser(conflict, winnerUserId);

  const moveWaId = options.moveWaId !== false && Boolean(conflict?.waId);
  const moveBsuid = options.moveBsuid !== false && Boolean(conflict?.bsuid);

  const winnerBefore = await readIdentifiersRecordCritical(winnerUserId, {
    step: "relink_conflict_aliases:winner_precheck",
    impact: "identity_relink_requires_trusted_winner",
  });
  const waBefore = waUserId
    ? await readIdentifiersRecordCritical(waUserId, {
        step: "relink_conflict_aliases:wa_precheck",
        impact: "identity_relink_requires_trusted_wa_user",
      })
    : null;
  const bsuidBefore = bsuidUserId
    ? await readIdentifiersRecordCritical(bsuidUserId, {
        step: "relink_conflict_aliases:bsuid_precheck",
        impact: "identity_relink_requires_trusted_bsuid_user",
      })
    : null;

  if (moveWaId && conflict?.waId) {
    await linkWaIdToUser(winnerUserId, conflict.waId);
  }
  if (moveBsuid && conflict?.bsuid) {
    await linkBsuidToUser(winnerUserId, conflict.bsuid);
  }

  if (moveWaId && waUserId && waUserId !== winnerUserId) {
    await clearIdentifiersForUser(waUserId, { clearWaId: true, clearBsuid: false });
  }
  if (moveBsuid && bsuidUserId && bsuidUserId !== winnerUserId) {
    await clearIdentifiersForUser(bsuidUserId, { clearWaId: false, clearBsuid: true });
  }

  const winnerIdentifiers = await readIdentifiersRecordCritical(winnerUserId, {
    step: "relink_conflict_aliases:winner_after",
    impact: "identity_relink_winner_after_read",
  });
  const waIdentifiers = waUserId ? await readIdentifiersRecord(waUserId) : null;
  const bsuidIdentifiers = bsuidUserId ? await readIdentifiersRecord(bsuidUserId) : null;

  return {
    winnerIdentifiers,
    waUserIdentifiers: waIdentifiers,
    bsuidUserIdentifiers: bsuidIdentifiers,
    moveWaId,
    moveBsuid,
    before: {
      winner: winnerBefore,
      waUser: waBefore,
      bsuidUser: bsuidBefore,
    },
  };
}

export async function mergeIdentityConflictToUser(conflictId, targetUserId, options = {}) {
  const current = await requireIdentityConflict(conflictId);
  const { targetUserId: winnerUserId, otherUserId: losingUserId } = ensureConflictTargetUser(current, targetUserId);
  const reviewedBy = safeStr(options.reviewedBy);
  const reviewDecision = safeStr(options.reviewDecision || "merge");
  const now = nowMs();

  const relinkResult = await relinkConflictAliasesToUser(current, winnerUserId, {
    moveWaId: options.moveWaId !== false,
    moveBsuid: options.moveBsuid !== false,
  });

  const note = appendConflictNote(
    current.notes,
    joinNotes(
      safeStr(options.notes),
      `[${nowIso()}] Merge administrativo aplicado. Usuário vencedor: ${winnerUserId}. Usuário referenciado para rastreabilidade: ${safeStr(losingUserId)}.`
    )
  );

  const next = buildIdentityConflictRecord({
    ...current,
    status: IDENTITY_CONFLICT_STATUS.RESOLVED,
    reviewDecision,
    reviewedBy: reviewedBy || current.reviewedBy,
    reviewedAt: now,
    notes: note,
    updatedAt: now,
    allowConversation: true,
    blockSensitiveOps: false,
  });

  if (current.status !== next.status) {
    await removeConflictFromStatusIndexes(next.conflictId, current.status);
  }
  await writeIdentityConflictRecord(next);
  await addConflictToIndexes(next);

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.MERGED,
    conflictId: next.conflictId,
    waUserId: next.waUserId,
    bsuidUserId: next.bsuidUserId,
    status: next.status,
    reviewDecision: next.reviewDecision,
    reviewedBy: next.reviewedBy,
    waId: next.waId,
    bsuid: next.bsuid,
    summary: `Conflito de identidade consolidado manualmente no usuário ${winnerUserId}.`,
    before: current,
    after: next,
    meta: {
      mergedIntoUserId: winnerUserId,
      losingUserId: safeStr(losingUserId),
      moveWaId: relinkResult.moveWaId,
      moveBsuid: relinkResult.moveBsuid,
      winnerIdentifiers: relinkResult.winnerIdentifiers || {},
    },
  });

  return {
    ok: true,
    action: "merge",
    mergedIntoUserId: winnerUserId,
    losingUserId: safeStr(losingUserId),
    conflict: next,
    identifiers: relinkResult,
  };
}

export async function reassignIdentityConflictAliases(conflictId, options = {}) {
  const current = await requireIdentityConflict(conflictId);
  const reviewedBy = safeStr(options.reviewedBy);
  const reviewDecision = safeStr(options.reviewDecision || "reassign_aliases");
  const moveWaIdToUserId = safeStr(options.moveWaIdToUserId || options.waTargetUserId);
  const moveBsuidToUserId = safeStr(options.moveBsuidToUserId || options.bsuidTargetUserId);

  if (!moveWaIdToUserId && !moveBsuidToUserId) {
    throw new Error("At least one alias target must be provided.");
  }

  if (moveWaIdToUserId) {
    ensureConflictTargetUser(current, moveWaIdToUserId);
    await readIdentifiersRecordCritical(moveWaIdToUserId, {
      step: "reassign_aliases:wa_target_precheck",
      impact: "identity_reassign_requires_trusted_wa_target",
    });
  }

  if (moveBsuidToUserId) {
    ensureConflictTargetUser(current, moveBsuidToUserId);
    await readIdentifiersRecordCritical(moveBsuidToUserId, {
      step: "reassign_aliases:bsuid_target_precheck",
      impact: "identity_reassign_requires_trusted_bsuid_target",
    });
  }

  if (moveWaIdToUserId) {
    if (current.waId) {
      await linkWaIdToUser(moveWaIdToUserId, current.waId);
    }
    const previousWaOwner = safeStr(current.waUserId);
    if (previousWaOwner && previousWaOwner !== moveWaIdToUserId) {
      await clearIdentifiersForUser(previousWaOwner, { clearWaId: true, clearBsuid: false });
    }
  }

  if (moveBsuidToUserId) {
    if (current.bsuid) {
      await linkBsuidToUser(moveBsuidToUserId, current.bsuid);
    }
    const previousBsuidOwner = safeStr(current.bsuidUserId);
    if (previousBsuidOwner && previousBsuidOwner !== moveBsuidToUserId) {
      await clearIdentifiersForUser(previousBsuidOwner, { clearWaId: false, clearBsuid: true });
    }
  }

  const now = nowMs();
  const next = buildIdentityConflictRecord({
    ...current,
    waUserId: moveWaIdToUserId || current.waUserId,
    bsuidUserId: moveBsuidToUserId || current.bsuidUserId,
    status: IDENTITY_CONFLICT_STATUS.RESOLVED,
    reviewDecision,
    reviewedBy: reviewedBy || current.reviewedBy,
    reviewedAt: now,
    updatedAt: now,
    notes: appendConflictNote(
      current.notes,
      joinNotes(
        safeStr(options.notes),
        `[${nowIso()}] Reatribuição administrativa de aliases aplicada. waId=>${safeStr(moveWaIdToUserId || current.waUserId)} bsuid=>${safeStr(moveBsuidToUserId || current.bsuidUserId)}.`
      )
    ),
    allowConversation: true,
    blockSensitiveOps: false,
  });

  if (current.status !== next.status) {
    await removeConflictFromStatusIndexes(next.conflictId, current.status);
  }
  await writeIdentityConflictRecord(next);
  await addConflictToIndexes(next);

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.ALIASES_REASSIGNED,
    conflictId: next.conflictId,
    waUserId: next.waUserId,
    bsuidUserId: next.bsuidUserId,
    status: next.status,
    reviewDecision: next.reviewDecision,
    reviewedBy: next.reviewedBy,
    waId: next.waId,
    bsuid: next.bsuid,
    summary: "Conflito de identidade resolvido por reatribuição manual de aliases.",
    before: current,
    after: next,
    meta: {
      moveWaIdToUserId,
      moveBsuidToUserId,
    },
  });

  return {
    ok: true,
    action: "reassign_aliases",
    conflict: next,
  };
}

export async function separateIdentityConflictUsers(conflictId, options = {}) {
  const current = await requireIdentityConflict(conflictId);
  const now = nowMs();
  const next = buildIdentityConflictRecord({
    ...current,
    status: IDENTITY_CONFLICT_STATUS.RESOLVED,
    reviewDecision: safeStr(options.reviewDecision || "separate_users"),
    reviewedBy: safeStr(options.reviewedBy || current.reviewedBy),
    reviewedAt: now,
    updatedAt: now,
    notes: appendConflictNote(
      current.notes,
      joinNotes(
        safeStr(options.notes),
        `[${nowIso()}] Revisão administrativa concluiu que os usuários devem permanecer separados.`
      )
    ),
    allowConversation: true,
    blockSensitiveOps: false,
  });

  if (current.status !== next.status) {
    await removeConflictFromStatusIndexes(next.conflictId, current.status);
  }
  await writeIdentityConflictRecord(next);
  await addConflictToIndexes(next);

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.USERS_SEPARATED,
    conflictId: next.conflictId,
    waUserId: next.waUserId,
    bsuidUserId: next.bsuidUserId,
    status: next.status,
    reviewDecision: next.reviewDecision,
    reviewedBy: next.reviewedBy,
    waId: next.waId,
    bsuid: next.bsuid,
    summary: "Conflito de identidade encerrado com decisão de manter usuários separados.",
    before: current,
    after: next,
  });

  return {
    ok: true,
    action: "separate_users",
    conflict: next,
  };
}

export async function blockIdentityConflictUser(conflictId, targetUserId, options = {}) {
  const current = await requireIdentityConflict(conflictId);
  const { targetUserId: blockedUserId } = ensureConflictTargetUser(current, targetUserId);
  const now = nowMs();

  const next = buildIdentityConflictRecord({
    ...current,
    status: IDENTITY_CONFLICT_STATUS.RESOLVED,
    reviewDecision: safeStr(options.reviewDecision || "block_user"),
    reviewedBy: safeStr(options.reviewedBy || current.reviewedBy),
    reviewedAt: now,
    updatedAt: now,
    notes: appendConflictNote(
      current.notes,
      joinNotes(
        safeStr(options.notes),
        `[${nowIso()}] Revisão administrativa indicou bloqueio do usuário ${blockedUserId}.`
      )
    ),
    allowConversation: true,
    blockSensitiveOps: false,
  });

  if (current.status !== next.status) {
    await removeConflictFromStatusIndexes(next.conflictId, current.status);
  }
  await writeIdentityConflictRecord(next);
  await addConflictToIndexes(next);

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.USER_BLOCKED,
    conflictId: next.conflictId,
    waUserId: next.waUserId,
    bsuidUserId: next.bsuidUserId,
    status: next.status,
    reviewDecision: next.reviewDecision,
    reviewedBy: next.reviewedBy,
    waId: next.waId,
    bsuid: next.bsuid,
    summary: `Conflito de identidade encerrado com indicação de bloqueio do usuário ${blockedUserId}.`,
    before: current,
    after: next,
    meta: {
      blockedUserId,
      requiresAdminStateAction: true,
    },
  });

  return {
    ok: true,
    action: "block_user",
    blockedUserId,
    requiresAdminStateAction: true,
    nextStatus: "BLOCKED",
    conflict: next,
  };
}

export async function resolveIdentityConflictDecision(conflictId, decision, options = {}) {
  const normalizedDecision = safeStr(decision).toLowerCase();

  if (normalizedDecision === "merge_into_wa_user") {
    const conflict = await requireIdentityConflict(conflictId);
    return mergeIdentityConflictToUser(conflictId, conflict.waUserId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "merge_into_wa_user"),
    });
  }

  if (normalizedDecision === "merge_into_bsuid_user") {
    const conflict = await requireIdentityConflict(conflictId);
    return mergeIdentityConflictToUser(conflictId, conflict.bsuidUserId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "merge_into_bsuid_user"),
    });
  }

  if (normalizedDecision === "reassign_aliases") {
    return reassignIdentityConflictAliases(conflictId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "reassign_aliases"),
    });
  }

  if (normalizedDecision === "separate_users") {
    return separateIdentityConflictUsers(conflictId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "separate_users"),
    });
  }

  if (normalizedDecision === "block_wa_user") {
    const conflict = await requireIdentityConflict(conflictId);
    return blockIdentityConflictUser(conflictId, conflict.waUserId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "block_wa_user"),
    });
  }

  if (normalizedDecision === "block_bsuid_user") {
    const conflict = await requireIdentityConflict(conflictId);
    return blockIdentityConflictUser(conflictId, conflict.bsuidUserId, {
      ...options,
      reviewDecision: safeStr(options.reviewDecision || "block_bsuid_user"),
    });
  }

  if (normalizedDecision === "dismiss") {
    return updateIdentityConflictStatus(conflictId, {
      ...options,
      status: IDENTITY_CONFLICT_STATUS.DISMISSED,
      reviewDecision: safeStr(options.reviewDecision || "dismiss"),
      reviewedBy: safeStr(options.reviewedBy),
      notes: safeStr(options.notes),
      blockSensitiveOps: false,
    });
  }

  if (normalizedDecision === "archive") {
    return updateIdentityConflictStatus(conflictId, {
      ...options,
      status: IDENTITY_CONFLICT_STATUS.ARCHIVED,
      reviewDecision: safeStr(options.reviewDecision || "archive"),
      reviewedBy: safeStr(options.reviewedBy),
      notes: safeStr(options.notes),
      blockSensitiveOps: false,
    });
  }

  throw new Error(`Unsupported identity conflict decision: ${decision}`);
}


export async function deleteIdentityForUser(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) throw new Error("internalUserId required");

  const identifiers = await getUserIdentifiers(userId);
  const jobs = [criticalIdentityWrite(() => redisDel(redisUserIdentifiersKey(userId)), { step: "delete_identity_user_record", internalUserId: userId, impact: "identity_delete_blocked", severity: "CRITICAL" })];

  if (identifiers?.waId) jobs.push(criticalIdentityWrite(() => redisDel(redisAliasWaIdKey(identifiers.waId)), { step: "delete_identity_wa_alias", internalUserId: userId, waId: identifiers.waId, impact: "identity_delete_blocked", severity: "CRITICAL" }));
  if (identifiers?.bsuid) jobs.push(criticalIdentityWrite(() => redisDel(redisAliasBsuidKey(identifiers.bsuid)), { step: "delete_identity_bsuid_alias", internalUserId: userId, bsuid: identifiers.bsuid, impact: "identity_delete_blocked", severity: "CRITICAL" }));

  await Promise.all(jobs);
  return { ok: true, userId, waId: identifiers?.waId || null, bsuid: identifiers?.bsuid || null };
}

export async function linkWaIdToUser(internalUserId, waId) {
  const userId = safeStr(internalUserId);
  const normalizedWaId = normalizeWaId(waId);
  if (!userId || !normalizedWaId) return null;

  await criticalIdentityWrite(() => redisSet(redisAliasWaIdKey(normalizedWaId), userId), { step: "link_waid_to_user", internalUserId: userId, waId: normalizedWaId, impact: "identity_alias_link_blocked", severity: "CRITICAL" });

  const current = (await readIdentifiersRecord(userId)) || buildIdentifiersRecord({ internalUserId: userId });
  const next = {
    ...current,
    waId: normalizedWaId,
    lastSeenWaId: normalizedWaId,
    updatedAt: nowMs(),
  };

  if (!next.primaryDeliveryId) {
    next.primaryDeliveryId = normalizedWaId;
  }

  return writeIdentifiersRecord(userId, next);
}

export async function linkBsuidToUser(internalUserId, bsuid) {
  const userId = safeStr(internalUserId);
  const normalizedBsuid = normalizeBsuid(bsuid);
  if (!userId || !normalizedBsuid) return null;

  await criticalIdentityWrite(() => redisSet(redisAliasBsuidKey(normalizedBsuid), userId), { step: "link_bsuid_to_user", internalUserId: userId, bsuid: normalizedBsuid, impact: "identity_alias_link_blocked", severity: "CRITICAL" });

  const current = (await readIdentifiersRecord(userId)) || buildIdentifiersRecord({ internalUserId: userId });
  const next = {
    ...current,
    bsuid: normalizedBsuid,
    lastSeenBsuid: normalizedBsuid,
    updatedAt: nowMs(),
  };

  if (!next.primaryDeliveryId) {
    next.primaryDeliveryId = current.waId || normalizedBsuid;
  }

  return writeIdentifiersRecord(userId, next);
}

async function upsertIdentityConflict({ waId = null, bsuid = null, waUserId = null, bsuidUserId = null } = {}) {
  const normalizedWaId = normalizeWaId(waId);
  const normalizedBsuid = normalizeBsuid(bsuid);
  const userA = safeStr(waUserId);
  const userB = safeStr(bsuidUserId);

  if (!userA || !userB || userA === userB) return null;

  const existing = await resolveExistingConflictId({
    waId: normalizedWaId,
    bsuid: normalizedBsuid,
    waUserId: userA,
    bsuidUserId: userB,
  });

  const now = nowMs();

  if (existing) {
    const previous = { ...existing };
    const reopened = existing.status !== IDENTITY_CONFLICT_STATUS.PENDING_REVIEW;

    const next = buildIdentityConflictRecord({
      ...existing,
      status: IDENTITY_CONFLICT_STATUS.PENDING_REVIEW,
      waId: normalizedWaId || existing.waId,
      bsuid: normalizedBsuid || existing.bsuid,
      waUserId: userA,
      bsuidUserId: userB,
      updatedAt: now,
      lastSeenAt: now,
      timesDetected: Number(existing.timesDetected || 0) + 1,
      allowConversation: true,
      blockSensitiveOps: true,
    });

    if (existing.status !== next.status) {
      await removeConflictFromStatusIndexes(next.conflictId, existing.status);
    }

    await writeIdentityConflictRecord(next);
    await addConflictToIndexes(next);

    await safeLogIdentityConflictAudit({
      action: reopened ? IDENTITY_CONFLICT_AUDIT_EVENT.REOPENED : IDENTITY_CONFLICT_AUDIT_EVENT.DETECTED,
      conflictId: next.conflictId,
      waUserId: next.waUserId,
      bsuidUserId: next.bsuidUserId,
      status: next.status,
      waId: next.waId,
      bsuid: next.bsuid,
      summary: reopened
        ? "Conflito de identidade reaberto para revisão manual."
        : "Conflito de identidade detectado novamente.",
      before: previous,
      after: next,
    });

    return next;
  }

  const conflictId = await createIdentityConflictId();
  const record = buildIdentityConflictRecord({
    conflictId,
    status: IDENTITY_CONFLICT_STATUS.PENDING_REVIEW,
    waId: normalizedWaId,
    bsuid: normalizedBsuid,
    waUserId: userA,
    bsuidUserId: userB,
    detectedAt: now,
    updatedAt: now,
    lastSeenAt: now,
    timesDetected: 1,
    allowConversation: true,
    blockSensitiveOps: true,
  });

  await writeIdentityConflictRecord(record);
  await addConflictToIndexes(record);

  await safeLogIdentityConflictAudit({
    action: IDENTITY_CONFLICT_AUDIT_EVENT.DETECTED,
    conflictId: record.conflictId,
    waUserId: record.waUserId,
    bsuidUserId: record.bsuidUserId,
    status: record.status,
    waId: record.waId,
    bsuid: record.bsuid,
    summary: "Conflito de identidade detectado e enviado para revisão manual.",
    after: record,
  });

  return record;
}

async function createCanonicalUser({ waId = null, bsuid = null } = {}) {
  const internalUserId = await createInternalUserId();
  const normalizedWaId = normalizeWaId(waId);
  const normalizedBsuid = normalizeBsuid(bsuid);
  const primaryDeliveryId = normalizedWaId || normalizedBsuid || null;

  const record = await writeIdentifiersRecord(internalUserId, {
    internalUserId,
    waId: normalizedWaId,
    bsuid: normalizedBsuid,
    primaryDeliveryId,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    lastSeenWaId: normalizedWaId,
    lastSeenBsuid: normalizedBsuid,
  });

  if (normalizedWaId) {
    await criticalIdentityWrite(() => redisSet(redisAliasWaIdKey(normalizedWaId), internalUserId), { step: "create_canonical_user_wa_alias", internalUserId, waId: normalizedWaId, impact: "identity_create_alias_blocked", severity: "CRITICAL" });
  }
  if (normalizedBsuid) {
    await criticalIdentityWrite(() => redisSet(redisAliasBsuidKey(normalizedBsuid), internalUserId), { step: "create_canonical_user_bsuid_alias", internalUserId, bsuid: normalizedBsuid, impact: "identity_create_alias_blocked", severity: "CRITICAL" });
  }

  return {
    internalUserId,
    identifiers: record,
    created: true,
    conflict: false,
    reviewRequired: false,
    allowConversation: true,
    blockSensitiveOps: false,
  };
}

export async function resolveOrCreateUserByIdentifiers({ waId = null, bsuid = null } = {}) {
  const normalizedWaId = normalizeWaId(waId);
  const normalizedBsuid = normalizeBsuid(bsuid);

  const requiresCriticalAliasRead = Boolean(normalizedWaId && normalizedBsuid);
  const waUserId = normalizedWaId
    ? await getInternalUserIdByWaId(normalizedWaId, { critical: requiresCriticalAliasRead })
    : null;
  const bsuidUserId = normalizedBsuid
    ? await getInternalUserIdByBsuid(normalizedBsuid, { critical: requiresCriticalAliasRead })
    : null;

  if (waUserId && bsuidUserId && waUserId !== bsuidUserId) {
    const conflict = await upsertIdentityConflict({
      waId: normalizedWaId,
      bsuid: normalizedBsuid,
      waUserId,
      bsuidUserId,
    });

    const identifiers = await getUserIdentifiers(waUserId);
    return {
      internalUserId: waUserId,
      identifiers,
      created: false,
      ...buildConflictResolutionResult(conflict),
    };
  }

  const internalUserId = waUserId || bsuidUserId;
  if (internalUserId) {
    if (normalizedWaId) {
      await linkWaIdToUser(internalUserId, normalizedWaId);
    }
    if (normalizedBsuid) {
      await linkBsuidToUser(internalUserId, normalizedBsuid);
    }

    const identifiers = await getUserIdentifiers(internalUserId);
    const pendingConflict = await getPendingIdentityConflictForUser(internalUserId);

    return {
      internalUserId,
      identifiers,
      created: false,
      conflict: Boolean(pendingConflict),
      reviewRequired: Boolean(pendingConflict),
      conflictId: safeStr(pendingConflict?.conflictId),
      allowConversation: true,
      blockSensitiveOps: pendingConflict ? pendingConflict.blockSensitiveOps !== false : false,
      conflictStatus: safeStr(pendingConflict?.status),
      conflictRecord: pendingConflict || null,
    };
  }

  return createCanonicalUser({ waId: normalizedWaId, bsuid: normalizedBsuid });
}

export async function resolveOrCreateUserFromInbound(payloadOrMessage = {}) {
  const identifiers = extractInboundIdentifiers(payloadOrMessage);
  const result = await resolveOrCreateUserByIdentifiers(identifiers);
  return {
    ...result,
    inbound: identifiers,
  };
}

export async function getPreferredOutboundRecipient(internalUserId) {
  const identifiers = await getUserIdentifiers(internalUserId);
  if (!identifiers) return null;

  const recipient = identifiers.waId || identifiers.primaryDeliveryId || identifiers.bsuid || null;
  if (!recipient) return null;

  return {
    recipient,
    channel: identifiers.waId ? "waId" : identifiers.bsuid ? "bsuid" : "unknown",
    internalUserId: safeStr(internalUserId),
    identifiers,
  };
}
