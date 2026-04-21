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
} from "./redis.js";
import * as audit from "./audit.js";

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

async function readIdentifiersRecord(userId) {
  const raw = await redisGet(redisUserIdentifiersKey(userId));
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
  await redisSet(redisUserIdentifiersKey(userId), JSON.stringify(record));
  return record;
}

async function createInternalUserId() {
  const seq = await redisNextUserSequence();
  return formatInternalUserId(seq);
}

async function createIdentityConflictId() {
  const seq = await redisNextIdentityConflictSequence();
  return formatIdentityConflictId(seq);
}

async function readIdentityConflictRecord(conflictId) {
  const id = safeStr(conflictId);
  if (!id) return null;
  const raw = await redisGet(redisIdentityConflictKey(id));
  if (!raw) return null;
  const parsed = tryJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") return null;
  return buildIdentityConflictRecord(parsed);
}

async function writeIdentityConflictRecord(record) {
  const next = buildIdentityConflictRecord(record);
  await redisSet(redisIdentityConflictKey(next.conflictId), JSON.stringify(next));
  return next;
}

async function addConflictToIndexes(record) {
  const jobs = [
    redisSAdd(redisIdentityConflictStatusIndexKey(record.status), record.conflictId),
    redisSAdd(redisIdentityConflictUserIndexKey(record.waUserId), record.conflictId),
    redisSAdd(redisIdentityConflictUserIndexKey(record.bsuidUserId), record.conflictId),
  ];

  if (record.waId) jobs.push(redisSAdd(redisIdentityConflictWaIdIndexKey(record.waId), record.conflictId));
  if (record.bsuid) jobs.push(redisSAdd(redisIdentityConflictBsuidIndexKey(record.bsuid), record.conflictId));

  if (record.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) {
    jobs.push(redisSAdd(redisIdentityConflictPendingIndexKey(), record.conflictId));
    jobs.push(redisSRem(redisIdentityConflictResolvedIndexKey(), record.conflictId));
  } else if (record.status === IDENTITY_CONFLICT_STATUS.RESOLVED) {
    jobs.push(redisSAdd(redisIdentityConflictResolvedIndexKey(), record.conflictId));
    jobs.push(redisSRem(redisIdentityConflictPendingIndexKey(), record.conflictId));
  } else {
    jobs.push(redisSRem(redisIdentityConflictPendingIndexKey(), record.conflictId));
    jobs.push(redisSRem(redisIdentityConflictResolvedIndexKey(), record.conflictId));
  }

  await Promise.allSettled(jobs);
}

async function removeConflictFromStatusIndexes(conflictId, previousStatus) {
  const id = safeStr(conflictId);
  const prev = normalizeConflictStatus(previousStatus);
  const jobs = [redisSRem(redisIdentityConflictStatusIndexKey(prev), id)];

  if (prev === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) {
    jobs.push(redisSRem(redisIdentityConflictPendingIndexKey(), id));
  }
  if (prev === IDENTITY_CONFLICT_STATUS.RESOLVED) {
    jobs.push(redisSRem(redisIdentityConflictResolvedIndexKey(), id));
  }

  await Promise.allSettled(jobs);
}

async function resolveExistingConflictId({ waId = null, bsuid = null, waUserId = null, bsuidUserId = null } = {}) {
  const candidates = new Set();

  if (waId) {
    const ids = await redisSMembers(redisIdentityConflictWaIdIndexKey(waId)).catch(() => []);
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (bsuid) {
    const ids = await redisSMembers(redisIdentityConflictBsuidIndexKey(bsuid)).catch(() => []);
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (waUserId) {
    const ids = await redisSMembers(redisIdentityConflictUserIndexKey(waUserId)).catch(() => []);
    uniqueStrings(ids).forEach((id) => candidates.add(id));
  }
  if (bsuidUserId) {
    const ids = await redisSMembers(redisIdentityConflictUserIndexKey(bsuidUserId)).catch(() => []);
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

export async function getInternalUserIdByWaId(waId) {
  const normalized = normalizeWaId(waId);
  if (!normalized) return null;
  return toNullable(await redisGet(redisAliasWaIdKey(normalized)));
}

export async function getInternalUserIdByBsuid(bsuid) {
  const normalized = normalizeBsuid(bsuid);
  if (!normalized) return null;
  return toNullable(await redisGet(redisAliasBsuidKey(normalized)));
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

  const ids = uniqueStrings(await redisSMembers(key).catch(() => []));
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
  const ids = uniqueStrings(await redisSMembers(redisIdentityConflictUserIndexKey(userId)).catch(() => []));
  for (const conflictId of ids) {
    const conflict = await readIdentityConflictRecord(conflictId);
    if (conflict?.status === IDENTITY_CONFLICT_STATUS.PENDING_REVIEW) return true;
  }
  return false;
}

export async function getPendingIdentityConflictForUser(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return null;
  const ids = uniqueStrings(await redisSMembers(redisIdentityConflictUserIndexKey(userId)).catch(() => []));
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
  const conflict = await readIdentityConflictRecord(conflictId);
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

  const current = await readIdentifiersRecord(targetUserId);
  if (!current) return null;

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

  const winnerIdentifiers = await getUserIdentifiers(winnerUserId);
  const waIdentifiers = waUserId ? await getUserIdentifiers(waUserId) : null;
  const bsuidIdentifiers = bsuidUserId ? await getUserIdentifiers(bsuidUserId) : null;

  return {
    winnerIdentifiers,
    waUserIdentifiers: waIdentifiers,
    bsuidUserIdentifiers: bsuidIdentifiers,
    moveWaId,
    moveBsuid,
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
    if (current.waId) {
      await linkWaIdToUser(moveWaIdToUserId, current.waId);
    }
    const previousWaOwner = safeStr(current.waUserId);
    if (previousWaOwner && previousWaOwner !== moveWaIdToUserId) {
      await clearIdentifiersForUser(previousWaOwner, { clearWaId: true, clearBsuid: false });
    }
  }

  if (moveBsuidToUserId) {
    ensureConflictTargetUser(current, moveBsuidToUserId);
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
  const jobs = [redisDel(redisUserIdentifiersKey(userId))];

  if (identifiers?.waId) jobs.push(redisDel(redisAliasWaIdKey(identifiers.waId)));
  if (identifiers?.bsuid) jobs.push(redisDel(redisAliasBsuidKey(identifiers.bsuid)));

  await Promise.allSettled(jobs);
  return { ok: true, userId, waId: identifiers?.waId || null, bsuid: identifiers?.bsuid || null };
}

export async function linkWaIdToUser(internalUserId, waId) {
  const userId = safeStr(internalUserId);
  const normalizedWaId = normalizeWaId(waId);
  if (!userId || !normalizedWaId) return null;

  await redisSet(redisAliasWaIdKey(normalizedWaId), userId);

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

  await redisSet(redisAliasBsuidKey(normalizedBsuid), userId);

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
    await redisSet(redisAliasWaIdKey(normalizedWaId), internalUserId);
  }
  if (normalizedBsuid) {
    await redisSet(redisAliasBsuidKey(normalizedBsuid), internalUserId);
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

  const waUserId = normalizedWaId ? await getInternalUserIdByWaId(normalizedWaId) : null;
  const bsuidUserId = normalizedBsuid ? await getInternalUserIdByBsuid(normalizedBsuid) : null;

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
