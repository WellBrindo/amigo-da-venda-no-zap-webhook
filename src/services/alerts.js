// src/services/alerts.js
// Blindagem operacional:
// - Mantém compatibilidade com o histórico simples de alertas
// - Evolui para incidentes operacionais deduplicados
// - Suporta cooldown e notificação externa best-effort
// - Nunca derruba o sistema por falha de alerta

import {
  redisGet,
  redisSet,
  redisDel,
  redisLPush,
  redisLRange,
  redisLTrim,
  redisExpire,
  redisLLen,
  redisSAdd,
  redisSRem,
  redisSMembers,
} from "./redis.js";

const ALERTS_KEY = "alerts:system";
const ALERTS_TTL_SECONDS = 7 * 24 * 60 * 60;
const ALERTS_MAX = 300;

const INCIDENT_KEY_PREFIX = "incident:system:";
const INCIDENT_OPEN_INDEX_KEY = "idx:incident:system:open";
const INCIDENT_RESOLVED_INDEX_KEY = "idx:incident:system:resolved";
const INCIDENT_DEDUPE_PREFIX = "incident:system:dedupe:";
const INCIDENT_TTL_SECONDS = 30 * 24 * 60 * 60;

const GLOBAL_SETTINGS_PREFIX = "cfg:global:";
const ALERT_RECIPIENTS_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalRecipients`;
const ALERT_CHANNELS_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalChannels`;
const ALERT_COOLDOWN_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalCooldowns`;

const INCIDENT_SEVERITY = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

const INCIDENT_STATUS = Object.freeze({
  OPEN: "OPEN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
});

const DEFAULT_CHANNEL_RULES = Object.freeze({
  whatsapp: "CRITICAL",
  email: "HIGH",
});

const DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS = Object.freeze({
  LOW: 30 * 60,
  MEDIUM: 15 * 60,
  HIGH: 5 * 60,
  CRITICAL: 60,
});

function safeStr(v) {
  return String(v ?? "").trim();
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function makeIncidentId() {
  return `inc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return fallback;
  }
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeSeverity(value) {
  const severity = safeStr(value).toUpperCase();
  return INCIDENT_SEVERITY[severity] || INCIDENT_SEVERITY.MEDIUM;
}

function normalizeIncidentStatus(value) {
  const status = safeStr(value).toUpperCase();
  return INCIDENT_STATUS[status] || INCIDENT_STATUS.OPEN;
}

function severityRank(value) {
  const severity = normalizeSeverity(value);
  if (severity === INCIDENT_SEVERITY.CRITICAL) return 4;
  if (severity === INCIDENT_SEVERITY.HIGH) return 3;
  if (severity === INCIDENT_SEVERITY.MEDIUM) return 2;
  return 1;
}

function compareSeverity(a, b) {
  return severityRank(a) - severityRank(b);
}

function boolish(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = safeStr(value).toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function incidentKey(incidentId) {
  const id = safeStr(incidentId);
  if (!id) throw new Error("incidentId is required");
  return `${INCIDENT_KEY_PREFIX}${id}`;
}

function incidentDedupeKey(dedupeKey) {
  const key = safeStr(dedupeKey).toLowerCase();
  if (!key) throw new Error("dedupeKey is required");
  return `${INCIDENT_DEDUPE_PREFIX}${key}`;
}

function normalizeDedupeKey({
  type = "",
  module = "",
  step = "",
  errorCode = "",
  impact = "",
  dedupeKey = "",
} = {}) {
  const explicit = safeStr(dedupeKey);
  if (explicit) return explicit.toLowerCase();
  return [type, module, step, errorCode, impact]
    .map((part) => safeStr(part).toLowerCase())
    .filter(Boolean)
    .join("|") || "incident:unknown";
}

function buildLegacyAlertEntry(event, payload = {}) {
  return {
    id: `al_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    ts: nowIso(),
    event: safeStr(event) || "UNKNOWN",
    payload: payload && typeof payload === "object" ? payload : { info: safeStr(payload) },
  };
}

function buildIncidentRecord(input = {}, previous = null) {
  const prior = normalizeObject(previous);
  const now = nowMs();
  const severity = normalizeSeverity(input.severity || prior.severity);
  const status = normalizeIncidentStatus(input.status || prior.status || INCIDENT_STATUS.OPEN);

  return {
    incidentId: safeStr(input.incidentId || prior.incidentId || makeIncidentId()),
    type: safeStr(input.type || prior.type || "SYSTEM"),
    severity,
    status,
    openedAt: Number(prior.openedAt || input.openedAt || now),
    updatedAt: Number(input.updatedAt || now),
    resolvedAt: Number(input.resolvedAt || (status === INCIDENT_STATUS.RESOLVED ? now : 0)) || 0,
    module: safeStr(input.module || prior.module),
    step: safeStr(input.step || prior.step),
    errorCode: safeStr(input.errorCode || prior.errorCode),
    message: safeStr(input.message || prior.message),
    impact: safeStr(input.impact || prior.impact),
    dedupeKey: normalizeDedupeKey({
      type: input.type || prior.type,
      module: input.module || prior.module,
      step: input.step || prior.step,
      errorCode: input.errorCode || prior.errorCode,
      impact: input.impact || prior.impact,
      dedupeKey: input.dedupeKey || prior.dedupeKey,
    }),
    occurrences: Math.max(1, Number(input.occurrences || prior.occurrences || 1)),
    lastOccurrenceAt: Number(input.lastOccurrenceAt || now),
    notifyChannels: Array.isArray(input.notifyChannels)
      ? input.notifyChannels
      : Array.isArray(prior.notifyChannels)
        ? prior.notifyChannels
        : [],
    lastNotifiedAt: Number(input.lastNotifiedAt || prior.lastNotifiedAt || 0),
    cooldownUntil: Number(input.cooldownUntil || prior.cooldownUntil || 0),
    meta: normalizeObject(input.meta && typeof input.meta === "object" ? input.meta : prior.meta),
  };
}

async function appendLegacyAlert(event, payload = {}) {
  const entry = buildLegacyAlertEntry(event, payload);
  try {
    await redisLPush(ALERTS_KEY, JSON.stringify(entry));
    await redisLTrim(ALERTS_KEY, 0, ALERTS_MAX - 1);
    await redisExpire(ALERTS_KEY, ALERTS_TTL_SECONDS);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "alerts_push_failed",
        event: entry.event,
        error: safeStr(err?.message || err),
      })
    );
  }
  return entry;
}

async function getJsonConfig(key, fallback) {
  try {
    const raw = await redisGet(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    const parsed = safeJsonParse(raw, fallback);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeRecipients(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item, index) => {
      const row = normalizeObject(item);
      const channel = safeStr(row.channel).toUpperCase();
      const contact = safeStr(row.contact);
      const severity = normalizeSeverity(row.minSeverity || row.severity || INCIDENT_SEVERITY.HIGH);
      if (!contact || !["WHATSAPP", "EMAIL"].includes(channel)) return null;
      return {
        id: safeStr(row.id || `rcpt_${index + 1}`),
        name: safeStr(row.name || row.label || contact),
        channel,
        contact,
        minSeverity: severity,
        active: boolish(row.active, true),
      };
    })
    .filter(Boolean);
}


function normalizeChannelRules(value) {
  const row = normalizeObject(value);
  return {
    whatsapp: normalizeSeverity(row.whatsapp || DEFAULT_CHANNEL_RULES.whatsapp),
    email: normalizeSeverity(row.email || DEFAULT_CHANNEL_RULES.email),
    notifyResolution: boolish(row.notifyResolution, true),
  };
}

function normalizeCooldownRules(value) {
  const row = normalizeObject(value);
  return {
    LOW: Math.max(0, Number(row.LOW || row.low || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.LOW) || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.LOW),
    MEDIUM: Math.max(0, Number(row.MEDIUM || row.medium || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.MEDIUM) || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.MEDIUM),
    HIGH: Math.max(0, Number(row.HIGH || row.high || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.HIGH) || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.HIGH),
    CRITICAL: Math.max(0, Number(row.CRITICAL || row.critical || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.CRITICAL) || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.CRITICAL),
  };
}

async function getOperationalAlertConfig() {
  const [recipientsRaw, channelsRaw, cooldownRaw] = await Promise.all([
    getJsonConfig(ALERT_RECIPIENTS_KEY, []),
    getJsonConfig(ALERT_CHANNELS_KEY, DEFAULT_CHANNEL_RULES),
    getJsonConfig(ALERT_COOLDOWN_KEY, DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS),
  ]);

  return {
    recipients: normalizeRecipients(recipientsRaw),
    channels: normalizeChannelRules(channelsRaw),
    cooldowns: normalizeCooldownRules(cooldownRaw),
  };
}

async function readIncidentById(incidentId) {
  const id = safeStr(incidentId);
  if (!id) return null;
  try {
    const raw = await redisGet(incidentKey(id));
    if (!raw) return null;
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") return null;
    return buildIncidentRecord(parsed);
  } catch {
    return null;
  }
}

async function writeIncident(record) {
  const incident = buildIncidentRecord(record);
  await redisSet(incidentKey(incident.incidentId), JSON.stringify(incident));
  await redisExpire(incidentKey(incident.incidentId), INCIDENT_TTL_SECONDS);
  return incident;
}

async function updateIncidentIndexes(next, previous = null) {
  const current = buildIncidentRecord(next);
  const prior = previous ? buildIncidentRecord(previous) : null;

  try {
    if (prior && prior.status !== INCIDENT_STATUS.RESOLVED) {
      await redisSRem(INCIDENT_OPEN_INDEX_KEY, prior.incidentId);
    }
    if (prior && prior.status === INCIDENT_STATUS.RESOLVED) {
      await redisSRem(INCIDENT_RESOLVED_INDEX_KEY, prior.incidentId);
    }
  } catch {}

  try {
    if (current.status === INCIDENT_STATUS.RESOLVED) {
      await redisSAdd(INCIDENT_RESOLVED_INDEX_KEY, current.incidentId);
      await redisSRem(INCIDENT_OPEN_INDEX_KEY, current.incidentId);
    } else {
      await redisSAdd(INCIDENT_OPEN_INDEX_KEY, current.incidentId);
      await redisSRem(INCIDENT_RESOLVED_INDEX_KEY, current.incidentId);
    }
    await redisExpire(INCIDENT_OPEN_INDEX_KEY, INCIDENT_TTL_SECONDS);
    await redisExpire(INCIDENT_RESOLVED_INDEX_KEY, INCIDENT_TTL_SECONDS);
  } catch {}
}

async function writeIncidentDedupe(dedupeKey, incidentId) {
  try {
    await redisSet(incidentDedupeKey(dedupeKey), safeStr(incidentId));
    await redisExpire(incidentDedupeKey(dedupeKey), INCIDENT_TTL_SECONDS);
  } catch {}
}

async function readIncidentByDedupe(dedupeKey) {
  try {
    const id = await redisGet(incidentDedupeKey(dedupeKey));
    if (!id) return null;
    return readIncidentById(id);
  } catch {
    return null;
  }
}

function buildWhatsAppAlertText(incident, isResolution = false) {
  const icon = isResolution ? "✅" : "🚨";
  const title = isResolution ? "INCIDENTE RESOLVIDO" : "ALERTA OPERACIONAL";
  const lines = [
    `${icon} ${title} — ${safeStr(incident.severity) || "MEDIUM"}`,
    `Tipo: ${safeStr(incident.type) || "SYSTEM"}`,
    `Módulo: ${safeStr(incident.module) || "unknown"}`,
    `Etapa: ${safeStr(incident.step) || "unknown"}`,
    `Impacto: ${safeStr(incident.impact) || "operational"}`,
    `Mensagem: ${safeStr(incident.message) || "Sem descrição adicional."}`,
    `Incidente: ${safeStr(incident.incidentId)}`,
    `Status: ${safeStr(incident.status) || "OPEN"}`,
  ];
  return lines.join("\n");
}

function buildEmailPayload(incident, isResolution = false) {
  const subjectPrefix = isResolution ? "✅ [RESOLVED]" : "🚨 [ALERT]";
  return {
    subject: `${subjectPrefix} ${safeStr(incident.severity)} - ${safeStr(incident.module || incident.type || "system")}`,
    text: buildWhatsAppAlertText(incident, isResolution),
    html: "",
  };
}

async function sendWhatsAppNotification(contact, incident, isResolution = false) {
  try {
    const mod = await import("./meta/whatsapp.js").catch(() => null);
    if (!mod) return { ok: false, skipped: true, reason: "whatsapp_module_unavailable" };

    if (typeof mod.sendOperationalAlertWhatsApp === "function") {
      await mod.sendOperationalAlertWhatsApp({
        to: contact,
        title: isResolution ? "Incidente resolvido" : "Alerta operacional",
        lines: buildWhatsAppAlertText(incident, isResolution).split("\n"),
        severity: incident.severity,
        incidentId: incident.incidentId,
      });
      return { ok: true };
    }

    if (typeof mod.sendWhatsAppText === "function") {
      await mod.sendWhatsAppText(contact, buildWhatsAppAlertText(incident, isResolution));
      return { ok: true };
    }

    return { ok: false, skipped: true, reason: "whatsapp_sender_not_available" };
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "alerts_whatsapp_failed",
      incidentId: incident.incidentId,
      error: safeStr(err?.message || err),
    }));
    return { ok: false, error: safeStr(err?.message || err) };
  }
}

async function sendEmailNotification(contact, incident, isResolution = false) {
  const payload = buildEmailPayload(incident, isResolution);
  try {
    const mod = await import("./email.js").catch(() => null);
    if (mod && typeof mod.sendOperationalAlertEmail === "function") {
      await mod.sendOperationalAlertEmail({
        to: contact,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        incidentId: incident.incidentId,
        severity: incident.severity,
      });
      return { ok: true };
    }

    console.warn(JSON.stringify({
      level: "warn",
      tag: "alerts_email_sender_unavailable",
      incidentId: incident.incidentId,
      to: contact,
      subject: payload.subject,
    }));
    return { ok: false, skipped: true, reason: "email_sender_not_available" };
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "alerts_email_failed",
      incidentId: incident.incidentId,
      error: safeStr(err?.message || err),
    }));
    return { ok: false, error: safeStr(err?.message || err) };
  }
}

function shouldNotifyRecipient(recipient, incident, channelRules) {
  if (!recipient?.active) return false;
  if (compareSeverity(incident.severity, recipient.minSeverity) < 0) return false;
  const channel = safeStr(recipient.channel).toLowerCase();
  const minByChannel = channel === "whatsapp" ? channelRules.whatsapp : channelRules.email;
  return compareSeverity(incident.severity, minByChannel) >= 0;
}

async function notifyIncident(record, { force = false, isResolution = false } = {}) {
  const incident = buildIncidentRecord(record);
  const config = await getOperationalAlertConfig();
  const now = nowMs();

  if (!force && incident.cooldownUntil && now < Number(incident.cooldownUntil || 0)) {
    return { ok: true, notified: false, reason: "cooldown_active", incident };
  }

  const recipients = config.recipients.filter((recipient) => shouldNotifyRecipient(recipient, incident, config.channels));
  if (!recipients.length) {
    return { ok: true, notified: false, reason: "no_recipients", incident };
  }

  const channelsUsed = [];
  for (const recipient of recipients) {
    const channel = safeStr(recipient.channel).toUpperCase();
    if (channel === "WHATSAPP") {
      const result = await sendWhatsAppNotification(recipient.contact, incident, isResolution);
      if (result?.ok) channelsUsed.push("WHATSAPP");
      continue;
    }
    if (channel === "EMAIL") {
      const result = await sendEmailNotification(recipient.contact, incident, isResolution);
      if (result?.ok) channelsUsed.push("EMAIL");
    }
  }

  const cooldownSeconds = config.cooldowns[normalizeSeverity(incident.severity)] || DEFAULT_COOLDOWN_BY_SEVERITY_SECONDS.MEDIUM;
  const next = buildIncidentRecord({
    ...incident,
    notifyChannels: Array.from(new Set([...(incident.notifyChannels || []), ...channelsUsed])),
    lastNotifiedAt: channelsUsed.length ? now : incident.lastNotifiedAt,
    cooldownUntil: channelsUsed.length ? now + cooldownSeconds * 1000 : incident.cooldownUntil,
    updatedAt: now,
  });

  try {
    await writeIncident(next);
    await updateIncidentIndexes(next, incident);
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_notify_persist_failed",
      incidentId: next.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  await appendLegacyAlert(isResolution ? "INCIDENT_RESOLVED" : "INCIDENT_ALERT_DISPATCHED", {
    incidentId: next.incidentId,
    severity: next.severity,
    status: next.status,
    module: next.module,
    step: next.step,
    channels: channelsUsed,
    notified: channelsUsed.length > 0,
  });

  return {
    ok: true,
    notified: channelsUsed.length > 0,
    channels: channelsUsed,
    incident: next,
  };
}

export async function pushSystemAlert(event, payload = {}) {
  return appendLegacyAlert(event, payload);
}

export async function listSystemAlerts(limit = 50) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  let items = [];
  try {
    items = await redisLRange(ALERTS_KEY, 0, lim - 1);
  } catch {
    return [];
  }
  const arr = Array.isArray(items) ? items : [];
  return arr.map((raw) => {
    try {
      return JSON.parse(String(raw));
    } catch {
      return { ts: "", event: "PARSE_ERROR", payload: { raw: String(raw) } };
    }
  });
}

export async function getSystemAlertsCount() {
  try {
    const n = await redisLLen(ALERTS_KEY);
    return Number(n || 0);
  } catch {
    return 0;
  }
}

export async function raiseSystemIncident(input = {}) {
  const now = nowMs();
  const dedupeKey = normalizeDedupeKey(input);
  const current = await readIncidentByDedupe(dedupeKey);

  let incident;
  if (current && current.status !== INCIDENT_STATUS.RESOLVED) {
    incident = buildIncidentRecord({
      ...current,
      severity: compareSeverity(input.severity, current.severity) > 0 ? input.severity : current.severity,
      status: INCIDENT_STATUS.OPEN,
      updatedAt: now,
      message: safeStr(input.message || current.message),
      impact: safeStr(input.impact || current.impact),
      errorCode: safeStr(input.errorCode || current.errorCode),
      step: safeStr(input.step || current.step),
      module: safeStr(input.module || current.module),
      meta: { ...normalizeObject(current.meta), ...normalizeObject(input.meta) },
      occurrences: Number(current.occurrences || 1) + 1,
      lastOccurrenceAt: now,
    }, current);
  } else {
    incident = buildIncidentRecord({
      type: safeStr(input.type || "SYSTEM"),
      severity: normalizeSeverity(input.severity),
      status: INCIDENT_STATUS.OPEN,
      openedAt: now,
      updatedAt: now,
      resolvedAt: 0,
      module: safeStr(input.module),
      step: safeStr(input.step),
      errorCode: safeStr(input.errorCode),
      message: safeStr(input.message),
      impact: safeStr(input.impact),
      dedupeKey,
      occurrences: 1,
      lastOccurrenceAt: now,
      notifyChannels: [],
      lastNotifiedAt: 0,
      cooldownUntil: 0,
      meta: normalizeObject(input.meta),
    });
  }

  try {
    await writeIncident(incident);
    await updateIncidentIndexes(incident, current);
    await writeIncidentDedupe(dedupeKey, incident.incidentId);
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_persist_failed",
      incidentId: incident.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  await appendLegacyAlert("INCIDENT_OPENED", {
    incidentId: incident.incidentId,
    type: incident.type,
    severity: incident.severity,
    status: incident.status,
    module: incident.module,
    step: incident.step,
    errorCode: incident.errorCode,
    impact: incident.impact,
    occurrences: incident.occurrences,
  });

  let notifyResult = null;
  try {
    notifyResult = await notifyIncident(incident, { force: false, isResolution: false });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_notify_failed",
      incidentId: incident.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  return {
    ok: true,
    incident: notifyResult?.incident || incident,
    notified: Boolean(notifyResult?.notified),
    channels: notifyResult?.channels || [],
  };
}

export async function listSystemIncidents(options = {}) {
  const params = typeof options === "number" ? { limit: options } : normalizeObject(options);
  const { status = "", limit = 100 } = params;
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const normalizedStatus = safeStr(status).toUpperCase();
  let ids = [];
  try {
    if (normalizedStatus === INCIDENT_STATUS.RESOLVED) {
      ids = await redisSMembers(INCIDENT_RESOLVED_INDEX_KEY);
    } else if (normalizedStatus === INCIDENT_STATUS.OPEN || normalizedStatus === INCIDENT_STATUS.ACKNOWLEDGED) {
      ids = await redisSMembers(INCIDENT_OPEN_INDEX_KEY);
    } else {
      const [openIds, resolvedIds] = await Promise.all([
        redisSMembers(INCIDENT_OPEN_INDEX_KEY).catch(() => []),
        redisSMembers(INCIDENT_RESOLVED_INDEX_KEY).catch(() => []),
      ])
      ids = [...new Set([...(Array.isArray(openIds) ? openIds : []), ...(Array.isArray(resolvedIds) ? resolvedIds : [])])];
    }
  } catch {
    ids = [];
  }

  const rows = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const incident = await readIncidentById(id);
    if (!incident) continue;
    if (normalizedStatus && incident.status !== normalizedStatus) continue;
    rows.push(incident);
  }

  rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return rows.slice(0, lim);
}

export async function getOpenIncidentsCount() {
  try {
    const ids = await redisSMembers(INCIDENT_OPEN_INDEX_KEY);
    const list = Array.isArray(ids) ? ids : [];
    return list.length;
  } catch {
    return 0;
  }
}

export async function acknowledgeSystemIncident(incidentId, options = {}) {
  const current = await readIncidentById(incidentId);
  if (!current) return null;

  const next = buildIncidentRecord({
    ...current,
    status: INCIDENT_STATUS.ACKNOWLEDGED,
    updatedAt: nowMs(),
    meta: {
      ...normalizeObject(current.meta),
      acknowledgedBy: safeStr(options.acknowledgedBy),
      acknowledgedAt: nowIso(),
    },
  }, current);

  try {
    await writeIncident(next);
    await updateIncidentIndexes(next, current);
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_ack_persist_failed",
      incidentId: next.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  await appendLegacyAlert("INCIDENT_ACKNOWLEDGED", {
    incidentId: next.incidentId,
    severity: next.severity,
    module: next.module,
    step: next.step,
    acknowledgedBy: safeStr(options.acknowledgedBy),
  });

  return next;
}

export async function resolveSystemIncident(incidentId, options = {}) {
  const current = await readIncidentById(incidentId);
  if (!current) return null;

  const next = buildIncidentRecord({
    ...current,
    status: INCIDENT_STATUS.RESOLVED,
    updatedAt: nowMs(),
    resolvedAt: nowMs(),
    meta: {
      ...normalizeObject(current.meta),
      resolvedBy: safeStr(options.resolvedBy),
      resolutionNote: safeStr(options.resolutionNote),
      resolvedAtIso: nowIso(),
    },
  }, current);

  try {
    await writeIncident(next);
    await updateIncidentIndexes(next, current);
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_resolve_persist_failed",
      incidentId: next.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  try {
    await redisDel(incidentDedupeKey(next.dedupeKey));
  } catch {}

  await appendLegacyAlert("INCIDENT_RESOLVED", {
    incidentId: next.incidentId,
    severity: next.severity,
    module: next.module,
    step: next.step,
    resolvedBy: safeStr(options.resolvedBy),
    resolutionNote: safeStr(options.resolutionNote),
  });

  try {
    const config = await getOperationalAlertConfig();
    if (config.channels.notifyResolution) {
      await notifyIncident(next, { force: true, isResolution: true });
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "incident_resolution_notify_failed",
      incidentId: next.incidentId,
      error: safeStr(err?.message || err),
    }));
  }

  return next;
}
