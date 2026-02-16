import express from "express";

import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.2-modular-plans";

const app = express();
app.set("trust proxy", true);

app.use(express.json({ limit: "2mb" }));

const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

function basicAuth(req, res, next) {
  if (!ADMIN_SECRET) return res.status(500).send("ADMIN_SECRET missing");

  const h = req.headers.authorization || "";
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
  if (!pass || pass !== ADMIN_SECRET) {
    return res.status(403).send("Forbidden");
  }

  return next();
}

app.get("/", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/health", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.status(403).send("Forbidden");
});

app.post("/webhook", async (req, res) => {
  try {
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.use("/asaas", asaasRouter());
app.use("/admin", basicAuth, adminRouter());

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
