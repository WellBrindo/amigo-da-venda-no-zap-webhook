import { Router } from "express";
import { handleAsaasWebhookEvent } from "../services/asaas/webhook.js";

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || "";

function getHeader(req, name) {
  const v = req.headers?.[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] || "";
  return String(v || "");
}

export function asaasRouter() {
  const router = Router();

  router.post("/webhook", async (req, res) => {
    try {
      // Segurança: valida token enviado pelo Asaas no header "asaas-access-token"
      const token = getHeader(req, "asaas-access-token");
      if (!ASAAS_WEBHOOK_TOKEN || token !== ASAAS_WEBHOOK_TOKEN) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const payload = req.body || {};
      const result = await handleAsaasWebhookEvent(payload);

      return res.json({ ok: true, result });
    } catch (err) {
      // Importante: responder 200/500? Para debug usamos 500.
      // Em produção, podemos sempre responder 200 e logar, mas vamos manter 500 por enquanto.
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
