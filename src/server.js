// src/server.js
import express from "express";

import { webhookRouter } from "./routes/webhook.js";
import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

import { redisPing } from "./services/redis.js";
import { auditCopyCatalog } from "./services/copy.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.9-modular-clean-server-bootstrap";

const ADMIN_SECRET = String(process.env.ADMIN_SECRET || "").trim();

function basicAuth(req, res, next) {
  // Admin sempre protegido. Se faltar env, melhor falhar cedo.
  if (!ADMIN_SECRET) {
    return res.status(500).send("ADMIN_SECRET missing");
  }

  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }

  const b64 = h.slice("Basic ".length);
  let decoded = "";
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid auth");
  }

  const [_user, pass] = decoded.split(":");
  if (!pass || pass !== ADMIN_SECRET) return res.status(403).send("Forbidden");

  return next();
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

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
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);

  try {
    const a = auditCopyCatalog();
    if ((a.missingInCatalog && a.missingInCatalog.length) || (a.extraInCatalog && a.extraInCatalog.length)) {
      console.warn(
        JSON.stringify({
          level: "warn",
          tag: "copy_catalog_audit",
          missingInCatalog: a.missingInCatalog || [],
          extraInCatalog: a.extraInCatalog || [],
        })
      );
    } else {
      console.log(
        JSON.stringify({
          level: "info",
          tag: "copy_catalog_audit_ok",
        })
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "copy_catalog_audit_failed",
        error: String(err?.message || err),
      })
    );
  }
});
