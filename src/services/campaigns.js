// src/services/campaigns.js
// ✅ V16.4.8 — Compat layer (NÃO é mais módulo real)
// Padronização: toda lógica de campanhas vive em src/services/broadcast.js
// Este arquivo existe apenas para não quebrar imports antigos.

import {
  createCampaignAndDispatch,
  listCampaigns,
  getCampaign,
  processPendingForWaId,
} from "./broadcast.js";

/**
 * Compat: nome antigo
 * - Antes: processPendingCampaignsForUser(waId)
 * - Agora: processPendingForWaId(waId) (broadcast.js)
 */
export async function processPendingCampaignsForUser(waId) {
  return processPendingForWaId(waId);
}

/**
 * Compat: assinatura antiga (campaigns.js legado)
 * Antes: createAndDispatchCampaign({ subject, text, planCodes })
 * Agora: createCampaignAndDispatch({ subject, text, planTargets })
 */
export async function createAndDispatchCampaign({
  subject,
  text,
  planCodes = [],
  messageType = "TEXT",
  template = null,
} = {}) {
  // planCodes -> planTargets
  const planTargets = Array.isArray(planCodes) ? planCodes : [];
  // messageType/template ainda não usados no broadcast; mantidos por compat
  void messageType;
  void template;

  return createCampaignAndDispatch({
    subject,
    text,
    planTargets,
    mode: "TEXT",
  });
}

/**
 * Compat helpers
 */
export async function listCampaignIds({ limit = 50 } = {}) {
  const data = await listCampaigns(limit);
  const arr = Array.isArray(data?.campaigns) ? data.campaigns : [];
  return arr.map((c) => String(c?.id || "")).filter(Boolean);
}

export async function getCampaignDetails(id) {
  const data = await getCampaign(String(id || "").trim());
  return data?.campaign || null;
}

/**
 * Exporta também os novos (por conveniência)
 */
export { listCampaigns, getCampaign };
