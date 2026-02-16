// src/server.js
import express from "express";
import crypto from "crypto";

import { adminRouter } from "./admin.js";
import { asaasRouter } from "./routes/asaas.js"; // se não existir, comente esta linha

import { ensureUserExists, getUserSnapshot, setUserStatus } from "./services/state.js";
import { redisGet, redisSet } from "./services/redis.js";
import { touch24hWindow, nowMs } from "./services/window24h.js";
import { sendWhatsAppText } from "./services/meta/whatsapp.js";

const APP_NAME = "amigo-das-vendas";
const APP_VERSION = "16.0.2-modular-onboarding-doc-validate";

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// ---------- Helpers: Basic Auth ----------
function requireAdminBasicAuth(req, res, next) {
  try {
    if (!ADMIN_SECRET) return res.status(500).send("ADMIN_SECRET not set");

    const h = req.headers.authorization || "";
    if (!h.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
      return res.status(401).send("Auth required");
    }
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const [user, pass] = raw.split(":");
    // user pode ser qualquer coisa; senha = ADMIN_SECRET
    if (pass !== ADMIN_SECRET) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
      return res.status(401).send("Invalid credentials");
    }
    return next();
  } catch (e) {
    return res.status(500).send("Auth error");
  }
}

// ---------- Helpers: waId + inbound parsing ----------
function normalizeWaId(v) {
  const s = String(v || "").replace(/\D+/g, "");
  if (!s) return "";
  // waId do WhatsApp vem como "5511...."
  return s;
}

function extractInboundMessages(body) {
  // Suporta o payload real e o payload do seu teste no PowerShell
  // body.entry[].changes[].value.messages[]
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

function getTextFromMessage(m) {
  if (!m) return "";
  if (m.type === "text") return String(m?.text?.body || "").trim();
  // (futuro) áudio / imagem etc
  return "";
}

// ---------- Helpers: profile storage (Redis) ----------
function kProfileName(waId) {
  return `profile:name:${waId}`;
}
function kProfileDoc(waId) {
  return `profile:doc:${waId}`;
}
async function getProfileName(waId) {
  return String((await redisGet(kProfileName(waId))) || "").trim();
}
async function setProfileName(waId, name) {
  const n = String(name || "").trim();
  await redisSet(kProfileName(waId), n);
  return n;
}
async function getProfileDoc(waId) {
  return String((await redisGet(kProfileDoc(waId))) || "").trim();
}
async function setProfileDoc(waId, docDigits) {
  const d = String(docDigits || "").replace(/\D+/g, "");
  await redisSet(kProfileDoc(waId), d);
  return d;
}

// ---------- CPF/CNPJ validation ----------
function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}
function allSameDigits(s) {
  return /^(\d)\1+$/.test(s);
}

function isValidCPF(cpfRaw) {
  const cpf = onlyDigits(cpfRaw);
  if (cpf.length !== 11) return false;
  if (allSameDigits(cpf)) return false;

  const calcDV = (base, factorStart) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (factorStart - i);
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };

  const base9 = cpf.slice(0, 9);
  const dv1 = calcDV(base9, 10);
  const base10 = cpf.slice(0, 9) + String(dv1);
  const dv2 = calcDV(base10, 11);

  return cpf === base9 + String(dv1) + String(dv2);
}

function isValidCNPJ(cnpjRaw) {
  const cnpj = onlyDigits(cnpjRaw);
  if (cnpj.length !== 14) return false;
  if (allSameDigits(cnpj)) return false;

  const calcDV = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(base[i]) * weights[i];
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const base12 = cnpj.slice(0, 12);
  const dv1 = calcDV(base12, w1);
  const base13 = base12 + String(dv1);
  const dv2 = calcDV(base13, w2);

  return cnpj === base12 + String(dv1) + String(dv2);
}

function validateCpfCnpj(docRaw) {
  const d = onlyDigits(docRaw);
  if (d.length === 11) return { ok: isValidCPF(d), type: "CPF", digits: d };
  if (d.length === 14) return { ok: isValidCNPJ(d), type: "CNPJ", digits: d };
  return { ok: false, type: "UNKNOWN", digits: d };
}

// ---------- Onboarding copy ----------
function welcomeAskNameMessage() {
  return (
    "Oi! 👋😊\n" +
    "Eu sou o *Amigo das Vendas* — pode me chamar de *Amigo*.\n\n" +
    "Você me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.\n\n" +
    "Antes que eu esqueça 😄\n" +
    "Qual é o seu *NOME COMPLETO*?"
  );
}

function askDocMessage() {
  return (
    "Nossa, quase esqueci 😄\n" +
    "Pra eu conseguir gerar e registrar o pagamento, preciso do seu *CPF ou CNPJ* (somente números).\n\n" +
    "Pode me enviar, por favor?\n" +
    "Fica tranquilo(a): eu uso só pra isso e não coloco em logs."
  );
}

function invalidDocMessage() {
  return (
    "Uhmm… acho que algum dígito ficou diferente aí 🥺😄\n" +
    "Dá uma olhadinha e me envia de novo, por favor, somente números:\n\n" +
    "CPF: *11 dígitos*\n" +
    "CNPJ: *14 dígitos*"
  );
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, service: APP_NAME, version: APP_VERSION });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), version: APP_VERSION });
});

app.get("/health-redis", async (req, res) => {
  try {
    // se seu redis.js tiver ping via GET/SET, isso já valida
    const key = `health:ping:${crypto.randomUUID()}`;
    await redisSet(key, "1");
    const v = await redisGet(key);
    res.json({ ok: true, redis: v === "1" ? "OK" : "UNKNOWN" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Admin ----------
app.use("/admin", requireAdminBasicAuth, adminRouter());

// Teste rápido: valida CPF/CNPJ (admin)
app.get("/admin/validate-doc", requireAdminBasicAuth, async (req, res) => {
  const doc = String(req.query.doc || "");
  const r = validateCpfCnpj(doc);
  res.json(r);
});

// ---------- Asaas (se existir o router) ----------
try {
  // Monta em /asaas (ex.: /asaas/webhook, /asaas/test etc)
  app.use("/asaas", asaasRouter());
} catch (e) {
  // Se você ainda não tiver o asaasRouter implementado/importado, o server continua
  console.warn("[WARN] asaasRouter not mounted:", e?.message || e);
}

// ---------- Meta Webhook verify ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
});

// ---------- Meta Webhook receive ----------
app.post("/webhook", async (req, res) => {
  try {
    const msgs = extractInboundMessages(req.body);
    if (!msgs.length) {
      return res.json({ ok: true, ignored: true });
    }

    // processa 1 por vez (por enquanto)
    for (const m of msgs) {
      const waId = normalizeWaId(m.from);
      const text = getTextFromMessage(m);

      if (!waId) continue;

      // 24h window (inbound)
      await touch24hWindow(waId);

      // garante user base
      await ensureUserExists(waId);

      // onboarding: pedir nome se não existir
      const name = await getProfileName(waId);
      if (!name) {
        // se o usuário ainda não tem nome salvo, tratamos a primeira resposta como nome
        // MAS: se for uma msg "oi" / muito curta, pedimos novamente.
        if (text && text.length >= 6 && text.split(" ").length >= 2) {
          await setProfileName(waId, text);
          // mantém o user em TRIAL (fluxo que você quer: começa trial e conta as 5 descrições)
          await setUserStatus(waId, "TRIAL");
          await sendWhatsAppText(
            waId,
            `Perfeito, ${text.split(" ")[0]}! ✅\n\nAgora me diga o que você vende ou qual serviço você presta (pode ser simples, tipo: “vendo bolo R$30”).`
          );
        } else {
          await setUserStatus(waId, "TRIAL");
          await sendWhatsAppText(waId, welcomeAskNameMessage());
        }
        continue;
      }

      // (Aqui entra seu fluxo atual de trial/planos/descrição)
      // Por enquanto, mantemos uma resposta de confirmação + snapshot
      const snap = await getUserSnapshot(waId);
      const plan = snap.plan || "(sem plano)";
      const status = snap.status || "TRIAL";

      // EXEMPLO: se futuramente você estiver no estado WAIT_DOC (pagamento),
      // você usará validateCpfCnpj() antes de chamar Asaas.
      // Como seu fluxo de Asaas está em outros módulos, deixamos pronto para integrar.
      if (status === "WAIT_DOC") {
        const r = validateCpfCnpj(text);
        if (!r.ok) {
          await sendWhatsAppText(waId, invalidDocMessage());
          continue;
        }
        await setProfileDoc(waId, r.digits);
        await sendWhatsAppText(
          waId,
          `✅ Documento confirmado (${r.type}).\nAgora vou gerar sua cobrança.`
        );
        // daqui você chamaria seu módulo Asaas para criar assinatura (cartão) ou cobrança (pix)
        continue;
      }

      // default: confirma recebimento
      await sendWhatsAppText(
        waId,
        `✅ Recebi sua solicitação.\n\n📦 Plano: ${plan}\n🧾 Status: ${status}\n\nMe envie a descrição do produto/serviço para eu gerar seu anúncio.`
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[${APP_NAME}] ${APP_VERSION} listening on :${PORT}`);
});
