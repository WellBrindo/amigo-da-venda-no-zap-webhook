// src/services/identity.js
// Camada central de identidade canônica do sistema.
// Objetivo:
// - Resolver usuários por aliases externos (waId / bsuid)
// - Criar internalUserId canônico do sistema
// - Vincular aliases ao mesmo usuário
// - Expor helpers de leitura para os demais serviços

import {
  redisGet,
  redisSet,
  redisDel,
  redisUserIdentifiersKey,
  redisAliasWaIdKey,
  redisAliasBsuidKey,
  redisNextUserSequence,
} from "./redis.js";

function nowMs() {
  return Date.now();
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

function formatInternalUserId(sequence) {
  const n = Number(sequence);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`formatInternalUserId: invalid sequence=${sequence}`);
  }
  return `usr_${String(Math.trunc(n)).padStart(6, "0")}`;
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

async function logIdentityConflict({ waId = null, bsuid = null, waUserId = null, bsuidUserId = null } = {}) {
  console.warn(
    JSON.stringify({
      level: "warn",
      tag: "identity_alias_conflict",
      waId: toNullable(waId),
      bsuid: toNullable(bsuid),
      waUserId: toNullable(waUserId),
      bsuidUserId: toNullable(bsuidUserId),
    })
  );
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
  };
}

export async function resolveOrCreateUserByIdentifiers({ waId = null, bsuid = null } = {}) {
  const normalizedWaId = normalizeWaId(waId);
  const normalizedBsuid = normalizeBsuid(bsuid);

  const waUserId = normalizedWaId ? await getInternalUserIdByWaId(normalizedWaId) : null;
  const bsuidUserId = normalizedBsuid ? await getInternalUserIdByBsuid(normalizedBsuid) : null;

  if (waUserId && bsuidUserId && waUserId !== bsuidUserId) {
    await logIdentityConflict({
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
      conflict: true,
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
    return {
      internalUserId,
      identifiers,
      created: false,
      conflict: false,
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
