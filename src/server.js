// src/server.js
import express from "express";

import { asaasRouter } from "./routes/asaas.js";
import { adminRouter } from "./routes/admin.js";

import {
  ensureUserExists,
  getUserFullName,
  setUserFullName,
} from "./services/state.js";

import { touch24hWindow } from "./services/window24h.js";
import { sendWhatsAppText } from "./services/meta/whatsapp.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.2-modular-fix-imports-onboarding-base";

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

// ===== helpers webhook =====
function extractInboundMessages(body) {
  const out = [];
  const entry = Array.isArray(body?.entry) ? body.entry : [];
  for (const e of entry) {
    const changes = Array.isArray(e?.changes) ? e.changes : [];
    for (const ch of changes) {
      const value = ch?.value || {};
      const msgs = Array.isArray(value?.messages) ? value.messages : [];
      for (const m of msgs) out.push(m);
    }
  }
  return out;
}

function normalizeWaId(v) {
  return String(v || "").replace(/\D+/g, "");
}

function getTextFromMessage(m) {
  if (!m) return "";
  if (m.type === "text") return String(m?.text?.body || "").trim();
  return "";
}

function welcomeAskNameMessage() {
  return (
    "Oi! 👋😊\n" +
    "Eu sou o *Amigo das Vendas* — pode me chamar de *Amigo*.\n\n" +
    "Você me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.\n\n" +
    "Antes que eu esqueça 😄\n" +
    "Qual é o seu *NOME COMPLETO*?"
  );
}

function looksLikeFullName(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length < 6) return false;
  const parts = t.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  return true;
}

app.get("/", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/health", (req, res) => {
  return res.status(200).json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

// ===== Meta verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.status(403).send("Forbidden");
});

// ===== Meta events =====
app.post("/webhook", async (req, res) => {
  try {
    const msgs = extractInboundMessages(req.body);
    if (!msgs.length) return res.json({ ok: true, ignored: true });

    for (const m of msgs) {
      const waId = normalizeWaId(m.from);
      if (!waId) continue;

      const text = getTextFromMessage(m);

      // marca janela 24h quando chega inbound
      await touch24hWindow(waId);

      // garante estado base do usuário
      await ensureUserExists(waId);

      // ===== PASSO 16.2: onboarding nome completo =====
      const fullName = await getUserFullName(waId);

      if (!fullName) {
        if (looksLikeFullName(text)) {
          await setUserFullName(waId, text);
          const firstName = text.trim().split(/\s+/)[0] || "perfeito";
          await sendWhatsAppText(
            waId,
            `Perfeito, ${firstName}! ✅\n\nAgora me diga o que você vende ou qual serviço você presta (pode ser simples, tipo: “vendo bolo R$30”).`
          );
        } else {
          await sendWhatsAppText(waId, welcomeAskNameMessage());
        }
        continue;
      }

      // Por enquanto (até ligarmos OpenAI/Asaas completo neste modular),
      // apenas confirma recebimento.
      await sendWhatsAppText(
        waId,
        `✅ Recebi sua mensagem.\n\nNome cadastrado: *${fullName}*\n\nAgora me diga o que você vende ou qual serviço você presta.`
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err?.message || err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ===== mounts =====
app.use("/asaas", asaasRouter());
app.use("/admin", basicAuth, adminRouter());

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
