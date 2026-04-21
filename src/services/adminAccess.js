import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import {
  redisGet,
  redisSet,
  redisDel,
  redisIncrBy,
  redisExpire,
  redisSAdd,
  redisSMembers,
} from "./redis.js";
import { logAdminAudit } from "./audit.js";

const ADMIN_USERS_INDEX_KEY = "admin:users:index";
const ADMIN_USER_PREFIX = "admin:user:";

const ADMIN_AUTH_FAIL_COUNTER_TTL_SECONDS = 15 * 60; // 15 min
const ADMIN_AUTH_LOCK_IP_POLICY = Object.freeze([
  { threshold: 20, ttlSeconds: 24 * 60 * 60 },
  { threshold: 10, ttlSeconds: 60 * 60 },
  { threshold: 5, ttlSeconds: 15 * 60 },
]);
const ADMIN_AUTH_LOCK_USER_POLICY = Object.freeze([
  { threshold: 12, ttlSeconds: 24 * 60 * 60 },
  { threshold: 8, ttlSeconds: 60 * 60 },
  { threshold: 5, ttlSeconds: 15 * 60 },
]);

const ADMIN_AUTH_EVENT = Object.freeze({
  MISSING_HEADER: "admin_auth_missing_header",
  INVALID_CREDENTIALS: "admin_auth_invalid_credentials",
  BLOCKED: "admin_auth_blocked",
  SUCCESS: "admin_auth_success",
  RUNTIME_ERROR: "admin_auth_runtime_error",
});

const ADMIN_AUTH_CODE = Object.freeze({
  INVALID_BASIC_AUTH: "INVALID_BASIC_AUTH",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ADMIN_NOT_FOUND_OR_INACTIVE: "ADMIN_NOT_FOUND_OR_INACTIVE",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  BLOCKED: "ADMIN_AUTH_BLOCKED",
  AUTH_RUNTIME_ERROR: "ADMIN_AUTH_RUNTIME_ERROR",
});

const ADMIN_PERMISSION_CATALOG = [
  { key: "dashboard.view", label: "Dashboard", description: "Pode acessar a visão inicial, dashboard operacional e executivo." },
  { key: "reports.view", label: "Relatórios", description: "Pode abrir relatórios e exportações do Admin." },
  { key: "users.manage", label: "Usuários", description: "Pode consultar usuários, CRM, ações em massa e janela de 24h." },
  { key: "plans.manage", label: "Planos", description: "Pode criar, editar e ativar planos comerciais." },
  { key: "finance.view", label: "Financeiro", description: "Pode acessar dashboards financeiros, reconciliação Asaas e testes financeiros." },
  { key: "marketing.manage", label: "Comunicação", description: "Pode operar broadcast e campanhas." },
  { key: "copy.manage", label: "Textos do Bot", description: "Pode editar a copy global e por usuário." },
  { key: "settings.manage", label: "Configurações", description: "Pode alterar configurações globais do sistema." },
  { key: "alerts.view", label: "Alertas", description: "Pode visualizar alertas e saúde operacional." },
  { key: "audit.view", label: "Auditoria", description: "Pode consultar a auditoria administrativa." },
  { key: "inconsistencies.view", label: "Inconsistências", description: "Pode abrir o painel de inconsistências da base." },
  { key: "admin.manage", label: "Administradores", description: "Pode gerir administradores, papéis e credenciais do painel." },
];

const ADMIN_ROLE_DEFINITIONS = [
  {
    key: "SUPER_ADMIN",
    label: "Super Admin",
    description: "Acesso total a todo o painel, incluindo gestão de credenciais administrativas.",
    permissions: ["*"],
  },
  {
    key: "FINANCEIRO",
    label: "Financeiro",
    description: "Acesso a financeiro, relatórios, inconsistências e consulta operacional para cobrança.",
    permissions: ["dashboard.view", "reports.view", "finance.view", "users.manage", "inconsistencies.view", "audit.view", "alerts.view"],
  },
  {
    key: "SUPORTE",
    label: "Suporte",
    description: "Acesso ao CRM, usuários, relatórios e textos do bot para atendimento diário.",
    permissions: ["dashboard.view", "reports.view", "users.manage", "copy.manage", "alerts.view"],
  },
  {
    key: "OPERACAO",
    label: "Operação",
    description: "Acesso a usuários, planos, inconsistências, alertas e relatórios operacionais.",
    permissions: ["dashboard.view", "reports.view", "users.manage", "plans.manage", "inconsistencies.view", "alerts.view"],
  },
  {
    key: "MARKETING",
    label: "Marketing",
    description: "Acesso à comunicação, campanhas, dashboards e relatórios necessários à operação comercial.",
    permissions: ["dashboard.view", "reports.view", "marketing.manage"],
  },
];

function safeStr(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeUsername(value) {
  const username = safeStr(value).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error("Username inválido. Use de 3 a 40 caracteres com letras minúsculas, números, ponto, hífen ou underscore.");
  }
  return username;
}

function normalizeUsernameForAuth(value) {
  const username = safeStr(value).toLowerCase();
  return /^[a-z0-9._-]{3,40}$/.test(username) ? username : "";
}

function normalizeUsernameForRateLimit(value) {
  const username = safeStr(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return username.slice(0, 80) || "unknown";
}

function normalizeIpForRateLimit(value) {
  const text = safeStr(value).split(",")[0].trim().toLowerCase();
  if (!text) return "unknown";

  const normalized = text
    .replace(/[:]/g, "_")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.slice(0, 120) || "unknown";
}

function normalizeRole(value) {
  const key = safeStr(value).toUpperCase();
  if (!ADMIN_ROLE_DEFINITIONS.some((item) => item.key === key)) {
    throw new Error("Perfil administrativo inválido.");
  }
  return key;
}

function sanitizeDisplayName(value, username) {
  const out = safeStr(value);
  return out || username;
}

function adminUserKey(username) {
  return `${ADMIN_USER_PREFIX}${normalizeUsername(username)}`;
}

function authFailIpKey(ip) {
  return `admin:auth:fail:ip:${normalizeIpForRateLimit(ip)}`;
}

function authFailUserKey(username) {
  return `admin:auth:fail:user:${normalizeUsernameForRateLimit(username)}`;
}

function authLockIpKey(ip) {
  return `admin:auth:lock:ip:${normalizeIpForRateLimit(ip)}`;
}

function authLockUserKey(username) {
  return `admin:auth:lock:user:${normalizeUsernameForRateLimit(username)}`;
}

function getRoleDefinition(role) {
  return ADMIN_ROLE_DEFINITIONS.find((item) => item.key === safeStr(role).toUpperCase()) || ADMIN_ROLE_DEFINITIONS[0];
}

function hashPassword(password) {
  const raw = String(password || "");
  if (raw.length < 8) throw new Error("A senha administrativa deve ter no mínimo 8 caracteres.");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(raw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const raw = String(password || "");
  const stored = safeStr(storedHash);
  if (!raw || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expected = parts[2];
  const actualBuffer = scryptSync(raw, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeStoredAdmin(input = {}) {
  const username = normalizeUsername(input.username);
  const role = normalizeRole(input.role || "SUPORTE");
  const roleMeta = getRoleDefinition(role);
  return {
    username,
    displayName: sanitizeDisplayName(input.displayName, username),
    role,
    permissions: Array.isArray(roleMeta.permissions) ? [...roleMeta.permissions] : [],
    isActive: input.isActive === undefined ? true : Boolean(input.isActive),
    passwordHash: safeStr(input.passwordHash),
    createdAt: safeStr(input.createdAt) || new Date().toISOString(),
    updatedAt: safeStr(input.updatedAt) || new Date().toISOString(),
  };
}

function toPublicAdmin(admin) {
  const normalized = normalizeStoredAdmin(admin);
  return {
    username: normalized.username,
    displayName: normalized.displayName,
    role: normalized.role,
    permissions: [...normalized.permissions],
    isActive: normalized.isActive,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

function serializeLockPayload(scope, subject, failCount, ttlSeconds) {
  return JSON.stringify({
    scope: safeStr(scope),
    subject: safeStr(subject),
    failCount: Math.max(0, toInt(failCount, 0)),
    ttlSeconds: Math.max(1, toInt(ttlSeconds, 1)),
    lockedAt: nowIso(),
  });
}

function tryJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function pickLockTtlSeconds(failCount, policy) {
  const count = Math.max(0, toInt(failCount, 0));
  for (const rule of policy) {
    if (count >= rule.threshold) return rule.ttlSeconds;
  }
  return 0;
}

async function safeLogAdminAuthEvent(event, payload = {}) {
  try {
    await logAdminAudit({
      module: "ADMIN_AUTH",
      action: safeStr(event || "ADMIN_AUTH_EVENT").toUpperCase(),
      targetId: safeStr(payload.username || payload.ip || ""),
      targetLabel: "admin_auth",
      summary: safeStr(payload.summary || event),
      meta: {
        event: safeStr(event),
        username: safeStr(payload.username),
        ip: safeStr(payload.ip),
        authMode: safeStr(payload.authMode),
        code: safeStr(payload.code),
        blocked: Boolean(payload.blocked),
        scope: safeStr(payload.scope),
        lockTtlSeconds: Math.max(0, toInt(payload.lockTtlSeconds, 0)),
        failCount: Math.max(0, toInt(payload.failCount, 0)),
        ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
      },
    });
  } catch {
    // best effort
  }
}

async function getManagedAdmin(username) {
  const raw = await redisGet(adminUserKey(username));
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_) {
    throw new Error("Registro administrativo corrompido no Redis.");
  }
  return toPublicAdmin(parsed);
}

async function getManagedAdminInternal(username) {
  const raw = await redisGet(adminUserKey(username));
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_) {
    throw new Error("Registro administrativo corrompido no Redis.");
  }
  return normalizeStoredAdmin(parsed);
}

async function incrementFailureCounter(key) {
  const value = await redisIncrBy(key, 1);
  await redisExpire(key, ADMIN_AUTH_FAIL_COUNTER_TTL_SECONDS);
  return Math.max(0, toInt(value, 0));
}

async function setLock(key, scope, subject, failCount, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return false;
  await redisSet(key, serializeLockPayload(scope, subject, failCount, ttlSeconds));
  await redisExpire(key, ttlSeconds);
  return true;
}

async function readLock(key) {
  const raw = await redisGet(key);
  if (!raw) return null;
  const parsed = tryJsonParse(raw, null);
  if (parsed && typeof parsed === "object") {
    return {
      scope: safeStr(parsed.scope),
      subject: safeStr(parsed.subject),
      failCount: Math.max(0, toInt(parsed.failCount, 0)),
      ttlSeconds: Math.max(0, toInt(parsed.ttlSeconds, 0)),
      lockedAt: safeStr(parsed.lockedAt),
      locked: true,
    };
  }
  return {
    scope: "",
    subject: "",
    failCount: 0,
    ttlSeconds: 0,
    lockedAt: "",
    locked: true,
  };
}

async function getActiveAdminAuthLock({ ip = "", username = "" } = {}) {
  const normalizedIp = normalizeIpForRateLimit(ip);
  const normalizedUsername = normalizeUsernameForRateLimit(username);

  const [ipLock, userLock] = await Promise.all([
    readLock(authLockIpKey(normalizedIp)),
    readLock(authLockUserKey(normalizedUsername)),
  ]);

  if (ipLock) {
    return {
      blocked: true,
      scope: "ip",
      code: ADMIN_AUTH_CODE.BLOCKED,
      ip: normalizedIp,
      username: normalizedUsername,
      lock: ipLock,
    };
  }

  if (userLock) {
    return {
      blocked: true,
      scope: "username",
      code: ADMIN_AUTH_CODE.BLOCKED,
      ip: normalizedIp,
      username: normalizedUsername,
      lock: userLock,
    };
  }

  return {
    blocked: false,
    scope: "",
    code: "",
    ip: normalizedIp,
    username: normalizedUsername,
    lock: null,
  };
}

async function clearAdminAuthProtectionState({ ip = "", username = "" } = {}) {
  const normalizedIp = normalizeIpForRateLimit(ip);
  const normalizedUsername = normalizeUsernameForRateLimit(username);

  await Promise.allSettled([
    redisDel(authFailIpKey(normalizedIp)),
    redisDel(authFailUserKey(normalizedUsername)),
    redisDel(authLockIpKey(normalizedIp)),
    redisDel(authLockUserKey(normalizedUsername)),
  ]);

  return true;
}

async function registerAdminAuthFailure({ ip = "", username = "", authMode = "", code = ADMIN_AUTH_CODE.INVALID_CREDENTIALS } = {}) {
  const normalizedIp = normalizeIpForRateLimit(ip);
  const normalizedUsername = normalizeUsernameForRateLimit(username);

  const [ipFailCount, userFailCount] = await Promise.all([
    incrementFailureCounter(authFailIpKey(normalizedIp)),
    incrementFailureCounter(authFailUserKey(normalizedUsername)),
  ]);

  const ipLockTtlSeconds = pickLockTtlSeconds(ipFailCount, ADMIN_AUTH_LOCK_IP_POLICY);
  const userLockTtlSeconds = pickLockTtlSeconds(userFailCount, ADMIN_AUTH_LOCK_USER_POLICY);

  const lockJobs = [];
  if (ipLockTtlSeconds > 0) {
    lockJobs.push(setLock(authLockIpKey(normalizedIp), "ip", normalizedIp, ipFailCount, ipLockTtlSeconds));
  }
  if (userLockTtlSeconds > 0) {
    lockJobs.push(setLock(authLockUserKey(normalizedUsername), "username", normalizedUsername, userFailCount, userLockTtlSeconds));
  }
  if (lockJobs.length) {
    await Promise.all(lockJobs);
  }

  const effectiveScope = userLockTtlSeconds >= ipLockTtlSeconds && userLockTtlSeconds > 0
    ? "username"
    : ipLockTtlSeconds > 0
      ? "ip"
      : "";

  const effectiveLockTtlSeconds = Math.max(ipLockTtlSeconds, userLockTtlSeconds);

  await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.INVALID_CREDENTIALS, {
    username: normalizedUsername,
    ip: normalizedIp,
    authMode,
    code,
    blocked: effectiveLockTtlSeconds > 0,
    scope: effectiveScope,
    lockTtlSeconds: effectiveLockTtlSeconds,
    failCount: effectiveScope === "username" ? userFailCount : ipFailCount,
    summary: effectiveLockTtlSeconds > 0
      ? "Falha de autenticação administrativa com bloqueio aplicado."
      : "Falha de autenticação administrativa.",
    meta: {
      ipFailCount,
      userFailCount,
    },
  });

  if (effectiveLockTtlSeconds > 0) {
    await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.BLOCKED, {
      username: normalizedUsername,
      ip: normalizedIp,
      authMode,
      code: ADMIN_AUTH_CODE.BLOCKED,
      blocked: true,
      scope: effectiveScope,
      lockTtlSeconds: effectiveLockTtlSeconds,
      failCount: effectiveScope === "username" ? userFailCount : ipFailCount,
      summary: "Bloqueio temporário de autenticação administrativa ativado.",
      meta: {
        ipFailCount,
        userFailCount,
      },
    });
  }

  return {
    ipFailCount,
    userFailCount,
    blocked: effectiveLockTtlSeconds > 0,
    scope: effectiveScope,
    lockTtlSeconds: effectiveLockTtlSeconds,
  };
}

function decodeBasicAuth(authorization) {
  const header = safeStr(authorization);
  if (!header.startsWith("Basic ")) return null;

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (_) {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return { username: safeStr(username), password: String(password || "") };
}

export function listAdminPermissionDefinitions() {
  return ADMIN_PERMISSION_CATALOG.map((item) => ({ ...item }));
}

export function listAdminRoleDefinitions() {
  return ADMIN_ROLE_DEFINITIONS.map((item) => ({ ...item, permissions: [...item.permissions] }));
}

export function getAdminRoleDefinition(role) {
  const def = getRoleDefinition(role);
  return { ...def, permissions: [...def.permissions] };
}

export { getManagedAdmin };

export async function listManagedAdmins() {
  const usernames = (await redisSMembers(ADMIN_USERS_INDEX_KEY) || []).map((item) => safeStr(item).toLowerCase()).filter(Boolean).sort();
  if (!usernames.length) return [];
  const rows = await Promise.all(usernames.map((username) => getManagedAdminInternal(username)));
  return rows.filter(Boolean).map((item) => toPublicAdmin(item));
}

export async function upsertManagedAdmin(input = {}) {
  const username = normalizeUsername(input.username);
  const existing = await getManagedAdminInternal(username);
  const role = normalizeRole(input.role || existing?.role || "SUPORTE");
  const displayName = sanitizeDisplayName(input.displayName, username);
  const isActive = input.isActive === undefined ? (existing ? existing.isActive : true) : Boolean(input.isActive);
  const passwordHash = input.password ? hashPassword(input.password) : safeStr(existing?.passwordHash);
  if (!passwordHash) {
    throw new Error("Informe uma senha para criar o administrador.");
  }

  const payload = normalizeStoredAdmin({
    username,
    displayName,
    role,
    isActive,
    passwordHash,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await Promise.all([
    redisSet(adminUserKey(username), JSON.stringify(payload)),
    redisSAdd(ADMIN_USERS_INDEX_KEY, username),
  ]);
  return toPublicAdmin(payload);
}

export async function setManagedAdminActive(username, isActive) {
  const existing = await getManagedAdminInternal(username);
  if (!existing) throw new Error("Administrador não encontrado.");
  const payload = normalizeStoredAdmin({
    ...existing,
    isActive: Boolean(isActive),
    updatedAt: new Date().toISOString(),
  });
  await redisSet(adminUserKey(username), JSON.stringify(payload));
  return toPublicAdmin(payload);
}

export async function updateManagedAdminPassword(username, password) {
  const existing = await getManagedAdminInternal(username);
  if (!existing) throw new Error("Administrador não encontrado.");
  const payload = normalizeStoredAdmin({
    ...existing,
    passwordHash: hashPassword(password),
    updatedAt: new Date().toISOString(),
  });
  await redisSet(adminUserKey(username), JSON.stringify(payload));
  return toPublicAdmin(payload);
}

export async function resolveAdminSession({ authorization, sharedSecret, ip = "", auditContext = {} } = {}) {
  const normalizedIp = normalizeIpForRateLimit(ip);
  const decoded = decodeBasicAuth(authorization);

  if (!decoded) {
    await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.MISSING_HEADER, {
      username: "unknown",
      ip: normalizedIp,
      authMode: "basic_auth",
      code: ADMIN_AUTH_CODE.INVALID_BASIC_AUTH,
      summary: "Cabeçalho Basic Auth ausente ou inválido.",
      meta: auditContext,
    });
    return { ok: false, code: ADMIN_AUTH_CODE.INVALID_BASIC_AUTH };
  }

  const rawUsername = safeStr(decoded.username) || "admin";
  const authUsername = normalizeUsernameForAuth(rawUsername);
  const usernameForRateLimit = normalizeUsernameForRateLimit(rawUsername);
  const password = String(decoded.password || "");
  const legacySecret = safeStr(sharedSecret);

  try {
    const activeLock = await getActiveAdminAuthLock({
      ip: normalizedIp,
      username: usernameForRateLimit,
    });

    if (activeLock.blocked) {
      await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.BLOCKED, {
        username: usernameForRateLimit,
        ip: normalizedIp,
        authMode: "pre_auth_guard",
        code: ADMIN_AUTH_CODE.BLOCKED,
        blocked: true,
        scope: activeLock.scope,
        lockTtlSeconds: activeLock.lock?.ttlSeconds || 0,
        failCount: activeLock.lock?.failCount || 0,
        summary: "Acesso administrativo negado por bloqueio temporário.",
        meta: auditContext,
      });

      return {
        ok: false,
        blocked: true,
        code: ADMIN_AUTH_CODE.BLOCKED,
        scope: activeLock.scope,
      };
    }

    if (legacySecret && password === legacySecret) {
      await clearAdminAuthProtectionState({
        ip: normalizedIp,
        username: usernameForRateLimit,
      });

      await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.SUCCESS, {
        username: usernameForRateLimit,
        ip: normalizedIp,
        authMode: "legacy_shared_secret",
        code: "AUTH_OK",
        summary: "Autenticação administrativa realizada com ADMIN_SECRET legado.",
        meta: auditContext,
      });

      return {
        ok: true,
        admin: {
          username: rawUsername,
          displayName: rawUsername,
          role: "SUPER_ADMIN",
          permissions: ["*"],
          isLegacySharedSecret: true,
          authMode: "legacy_shared_secret",
          isActive: true,
        },
      };
    }

    if (!authUsername) {
      const failure = await registerAdminAuthFailure({
        ip: normalizedIp,
        username: usernameForRateLimit,
        authMode: "managed_admin",
        code: ADMIN_AUTH_CODE.INVALID_CREDENTIALS,
      });

      return {
        ok: false,
        blocked: failure.blocked,
        code: ADMIN_AUTH_CODE.INVALID_CREDENTIALS,
        scope: failure.scope || "",
      };
    }

    const managed = await getManagedAdminInternal(authUsername);
    if (!managed || !managed.isActive) {
      const failure = await registerAdminAuthFailure({
        ip: normalizedIp,
        username: authUsername,
        authMode: "managed_admin",
        code: ADMIN_AUTH_CODE.ADMIN_NOT_FOUND_OR_INACTIVE,
      });

      return {
        ok: false,
        blocked: failure.blocked,
        code: ADMIN_AUTH_CODE.ADMIN_NOT_FOUND_OR_INACTIVE,
        scope: failure.scope || "",
      };
    }

    if (!verifyPassword(password, managed.passwordHash)) {
      const failure = await registerAdminAuthFailure({
        ip: normalizedIp,
        username: authUsername,
        authMode: "managed_admin",
        code: ADMIN_AUTH_CODE.INVALID_PASSWORD,
      });

      return {
        ok: false,
        blocked: failure.blocked,
        code: ADMIN_AUTH_CODE.INVALID_PASSWORD,
        scope: failure.scope || "",
      };
    }

    await clearAdminAuthProtectionState({
      ip: normalizedIp,
      username: authUsername,
    });

    await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.SUCCESS, {
      username: authUsername,
      ip: normalizedIp,
      authMode: "managed_admin",
      code: "AUTH_OK",
      summary: "Autenticação administrativa realizada com sucesso.",
      meta: {
        role: managed.role,
        ...auditContext,
      },
    });

    return {
      ok: true,
      admin: {
        username: managed.username,
        displayName: managed.displayName,
        role: managed.role,
        permissions: [...managed.permissions],
        isLegacySharedSecret: false,
        authMode: "managed_admin",
        isActive: managed.isActive,
      },
    };
  } catch (error) {
    await safeLogAdminAuthEvent(ADMIN_AUTH_EVENT.RUNTIME_ERROR, {
      username: usernameForRateLimit,
      ip: normalizedIp,
      authMode: "admin_auth_runtime",
      code: ADMIN_AUTH_CODE.AUTH_RUNTIME_ERROR,
      summary: "Erro técnico durante autenticação administrativa.",
      meta: {
        errorMessage: safeStr(error?.message || error),
        ...auditContext,
      },
    });

    return {
      ok: false,
      code: ADMIN_AUTH_CODE.AUTH_RUNTIME_ERROR,
      error: safeStr(error?.message || error) || "Admin auth error",
    };
  }
}
