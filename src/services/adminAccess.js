// src/services/adminAccess.js
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { redisGet, redisSet, redisSAdd, redisSMembers } from "./redis.js";

const ADMIN_USERS_INDEX_KEY = "admin:users:index";
const ADMIN_USER_PREFIX = "admin:user:";

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

function normalizeUsername(value) {
  const username = safeStr(value).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error("Username inválido. Use de 3 a 40 caracteres com letras minúsculas, números, ponto, hífen ou underscore.");
  }
  return username;
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

export async function getManagedAdmin(username) {
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

export async function resolveAdminSession({ authorization, sharedSecret } = {}) {
  const decoded = decodeBasicAuth(authorization);
  if (!decoded) return { ok: false, code: "INVALID_BASIC_AUTH" };

  const username = safeStr(decoded.username) || "admin";
  const password = String(decoded.password || "");
  const legacySecret = safeStr(sharedSecret);

  if (legacySecret && password === legacySecret) {
    return {
      ok: true,
      admin: {
        username,
        displayName: username,
        role: "SUPER_ADMIN",
        permissions: ["*"],
        isLegacySharedSecret: true,
        authMode: "legacy_shared_secret",
        isActive: true,
      },
    };
  }

  const managed = await getManagedAdminInternal(username);
  if (!managed || !managed.isActive) return { ok: false, code: "ADMIN_NOT_FOUND_OR_INACTIVE" };
  if (!verifyPassword(password, managed.passwordHash)) return { ok: false, code: "INVALID_PASSWORD" };

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
}
