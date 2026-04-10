// src/server.js
import express from "express";

import { webhookRouter } from "./routes/webhook.js";
import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

import { redisPing } from "./services/redis.js";
import { resolveAdminSession } from "./services/adminAccess.js";
import { startLifecycleAutomationLoop } from "./services/broadcast.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.1.0-campaign-orchestrator-bootstrap";

const ADMIN_SECRET = String(process.env.ADMIN_SECRET || "").trim();

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
    return res.status(500).send(String(err?.message || err || "Auth error"));
  }
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

// -------------------- Start --------------------
const PORT = Number(process.env.PORT || 10000);
const LIFECYCLE_AUTOMATION_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.LIFECYCLE_AUTOMATION_INTERVAL_MS || 60_000)
);

app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);

  try {
    startLifecycleAutomationLoop({
      intervalMs: LIFECYCLE_AUTOMATION_INTERVAL_MS,
    });

    console.log(
      `[${APP_NAME}] lifecycle automation loop started (${LIFECYCLE_AUTOMATION_INTERVAL_MS}ms)`
    );
  } catch (err) {
    console.error(
      `[${APP_NAME}] failed to start lifecycle automation loop:`,
      err?.message || err
    );
  }
});
