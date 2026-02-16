import express from "express";
import crypto from "crypto";

import { asaasRouter } from "./routes/asaas.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.1-modular";

const app = express();
app.set("trust proxy", true);

// JSON body
app.use(express.json({ limit: "2mb" }));

// ===================== ENV =====================
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

// ===================== Helpers =====================
function basicAuth(req, res, next) {
  // Se você quiser usuário/senha depois, a gente melhora.
  // Por enquanto, o ADMIN_SECRET é a senha.
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
  const [user, pass] = decoded.split(":");
  if (!pass || pass !== ADMIN_SECRET) {
    return res.status(403).send("Forbidden");
  }
  // user pode ser qualquer coisa
  next();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ===================== Health =====================
app.get("/", (req, res) => {
  res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

// ===================== WhatsApp Cloud API webhook =====================
// Teste A (GET) - verificação do Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.status(403).send("Forbidden");
});

// Recebimento (POST) - por enquanto só confirma recebimento (seu fluxo modular pode evoluir depois)
app.post("/webhook", async (req, res) => {
  try {
    // Aqui você pode integrar com seu pipeline modular de mensagens depois.
    // Neste momento, devolvemos ok para não travar o webhook.
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================== ASAAS webhook =====================
// >>>> ISSO AQUI é o que resolve seu 404 no Teste B <<<<
app.use("/asaas", asaasRouter());

// ===================== Admin (index com menu) =====================
app.get("/admin", basicAuth, (req, res) => {
  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Admin - ${escapeHtml(APP_NAME)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; }
        .card { max-width: 820px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
        a { display: inline-block; margin: 6px 0; }
        .muted { color: #666; }
        code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Admin (V16 Modular)</h2>
        <p class="muted">Menu:</p>
        <div>
          <a href="/health">✅ Health</a><br/>
          <a href="/asaas/test">💳 Asaas Test (ping interno)</a><br/>
        </div>
        <hr/>
        <p class="muted">Rotas:</p>
        <div>
          <div><code>POST /asaas/webhook</code> (webhook Asaas)</div>
          <div><code>GET /webhook</code> (verificação Meta)</div>
          <div><code>POST /webhook</code> (eventos WhatsApp)</div>
        </div>
      </div>
    </body>
  </html>
  `;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
});

// Teste simples interno (não é webhook)
app.get("/asaas/test", basicAuth, (req, res) => {
  return res.json({ ok: true, asaasWebhookRoute: "/asaas/webhook" });
});

// ===================== Start =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // sem log de secrets
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
