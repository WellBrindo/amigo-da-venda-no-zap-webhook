// src/server.js
import express from "express";

import { webhookRouter } from "./routes/webhook.js";
import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

import { redisPing } from "./services/redis.js";
import { resolveAdminSession } from "./services/adminAccess.js";
import { startLifecycleAutomationLoop } from "./services/broadcast.js";
import * as audit from "./services/audit.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.1.0-campaign-orchestrator-bootstrap";

const ADMIN_SECRET = String(process.env.ADMIN_SECRET || "").trim();
const PORT = Number(process.env.PORT || 10000);
const LIFECYCLE_AUTOMATION_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.LIFECYCLE_AUTOMATION_INTERVAL_MS || 60_000)
);
const FATAL_EXIT_DELAY_MS = Math.max(
  100,
  Number(process.env.SERVER_FATAL_EXIT_DELAY_MS || 250)
);
const STRICT_UNHANDLED_REJECTION = ["1", "true", "yes", "on"]
  .includes(String(process.env.STRICT_UNHANDLED_REJECTION || "").trim().toLowerCase());

function safeStr(value) {
  return String(value ?? "").trim();
}

function serializeError(err) {
  if (!err) {
    return {
      name: "Error",
      message: "Unknown error",
      stack: "",
      code: "",
    };
  }

  return {
    name: safeStr(err?.name || "Error"),
    message: safeStr(err?.message || err) || "Unknown error",
    stack: safeStr(err?.stack),
    code: safeStr(err?.errorCode || err?.code),
  };
}

async function logServerEvent({
  level = "info",
  event = "server_event",
  stage = "",
  fatal = false,
  error = null,
  meta = {},
} = {}) {
  const serialized = serializeError(error);
  const payload = {
    module: "server",
    level: safeStr(level) || "info",
    source: "server",
    event: safeStr(event) || "server_event",
    stage: safeStr(stage),
    fatal: Boolean(fatal),
    service: APP_NAME,
    version: APP_VERSION,
    ts: new Date().toISOString(),
    errorCode: serialized.code,
    errorName: serialized.name,
    message: serialized.message,
    stack: serialized.stack,
    meta: meta && typeof meta === "object" ? meta : {},
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent({
        module: "server",
        event: payload.event,
        level: payload.level,
        step: payload.stage,
        status: payload.fatal ? "fatal" : "observed",
        message: payload.message,
        errorCode: payload.errorCode,
        meta: {
          fatal: payload.fatal,
          service: payload.service,
          version: payload.version,
          errorName: payload.errorName,
          stack: payload.stack,
          ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
        },
      });
      return;
    }

    if (typeof audit?.logRuntimeError === "function" && (payload.level === "warn" || payload.level === "error" || payload.fatal)) {
      await audit.logRuntimeError({
        module: "server",
        event: payload.event,
        level: payload.level,
        step: payload.stage,
        status: payload.fatal ? "fatal" : "observed",
        message: payload.message,
        errorCode: payload.errorCode,
        meta: {
          fatal: payload.fatal,
          service: payload.service,
          version: payload.version,
          errorName: payload.errorName,
          stack: payload.stack,
          ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
        },
      });
      return;
    }
  } catch {
    // fallback para console abaixo
  }

  const line = JSON.stringify(payload);
  if (payload.level === "error" || payload.fatal) {
    console.error(line);
    return;
  }
  if (payload.level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

let fatalShutdownScheduled = false;
function scheduleFatalShutdown(reason, error = null) {
  if (fatalShutdownScheduled) return;
  fatalShutdownScheduled = true;

  void logServerEvent({
    level: "error",
    event: "process_fatal_shutdown_scheduled",
    stage: "process",
    fatal: true,
    error,
    meta: {
      reason: safeStr(reason),
      exitDelayMs: FATAL_EXIT_DELAY_MS,
    },
  });

  setTimeout(() => {
    process.exit(1);
  }, FATAL_EXIT_DELAY_MS).unref?.();
}

async function basicAuth(req, res, next) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }

  try {
    const session = await resolveAdminSession({
      authorization: h,
      sharedSecret: ADMIN_SECRET,
    });

    if (!session?.ok || !session?.admin) {
      return res.status(403).send("Forbidden");
    }

    req.adminAuth = session.admin;
    return next();
  } catch (err) {
    void logServerEvent({
      level: "error",
      event: "basic_auth_error",
      stage: "auth",
      fatal: false,
      error: err,
      meta: {
        route: safeStr(req?.originalUrl || req?.url),
        method: safeStr(req?.method),
      },
    });
    return res.status(500).send(String(err?.message || err || "Auth error"));
  }
}

function installGlobalProcessHandlers() {
  process.on("unhandledRejection", (reason) => {
    void logServerEvent({
      level: "error",
      event: "unhandled_rejection",
      stage: "process",
      fatal: Boolean(STRICT_UNHANDLED_REJECTION),
      error: reason,
      meta: {
        policy: STRICT_UNHANDLED_REJECTION ? "strict_exit" : "log_only",
      },
    });

    if (STRICT_UNHANDLED_REJECTION) {
      scheduleFatalShutdown("strict_unhandled_rejection", reason);
    }
  });

  process.on("uncaughtException", (error) => {
    void logServerEvent({
      level: "error",
      event: "uncaught_exception",
      stage: "process",
      fatal: true,
      error,
      meta: {
        policy: "always_exit",
      },
    });

    scheduleFatalShutdown("uncaught_exception", error);
  });
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false })); // ✅ forms do Admin (Copy/Plans) usam x-www-form-urlencoded

// -------------------- Health --------------------
app.get("/", (req, res) =>
  res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION })
);

app.get("/health", (req, res) =>
  res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION })
);

app.get("/health-redis", async (req, res) => {
  try {
    const r = await redisPing();
    return res.json({ ok: true, redis: r });
  } catch (e) {
    void logServerEvent({
      level: "warn",
      event: "health_redis_failed",
      stage: "health_redis",
      fatal: false,
      error: e,
    });
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -------------------- Routers --------------------
// WhatsApp Cloud API webhook
app.use("/webhook", webhookRouter());

// Asaas webhook (token valida dentro do router)
app.use("/asaas", asaasRouter());

// Admin (tudo protegido por Basic Auth)
app.use("/admin", basicAuth, adminRouter());

// Debug simples do asaas (protegido)
app.get("/asaas/test", basicAuth, (req, res) => {
  return res.json({
    ok: true,
    asaasWebhookRoute: "/asaas/webhook",
    env: String(process.env.ASAAS_ENV || "production"),
    hasApiKey: Boolean(String(process.env.ASAAS_API_KEY || "").trim()),
  });
});

function bootstrapLifecycleAutomation() {
  try {
    startLifecycleAutomationLoop({
      intervalMs: LIFECYCLE_AUTOMATION_INTERVAL_MS,
    });

    void logServerEvent({
      level: "info",
      event: "lifecycle_automation_started",
      stage: "bootstrap",
      fatal: false,
      meta: {
        intervalMs: LIFECYCLE_AUTOMATION_INTERVAL_MS,
      },
    });
  } catch (err) {
    void logServerEvent({
      level: "error",
      event: "lifecycle_automation_start_failed",
      stage: "bootstrap",
      fatal: false,
      error: err,
      meta: {
        intervalMs: LIFECYCLE_AUTOMATION_INTERVAL_MS,
      },
    });
  }
}

installGlobalProcessHandlers();

const server = app.listen(PORT, () => {
  void logServerEvent({
    level: "info",
    event: "http_server_listening",
    stage: "bootstrap",
    fatal: false,
    meta: {
      port: PORT,
    },
  });

  bootstrapLifecycleAutomation();
});

server.on("error", (err) => {
  void logServerEvent({
    level: "error",
    event: "http_server_error",
    stage: "server",
    fatal: true,
    error: err,
    meta: {
      port: PORT,
    },
  });

  scheduleFatalShutdown("http_server_error", err);
});
