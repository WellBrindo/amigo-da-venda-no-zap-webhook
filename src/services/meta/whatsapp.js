import * as audit from "../audit.js";

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const META_WHATSAPP_ERROR = Object.freeze({
  AUTH: "META_AUTH_ERROR",
  RECIPIENT: "META_RECIPIENT_ERROR",
  WINDOW: "META_WINDOW_ERROR",
  RATE_LIMIT: "META_RATE_LIMIT_ERROR",
  HTTP: "META_HTTP_ERROR",
  RESPONSE_PARSE: "META_RESPONSE_PARSE_ERROR",
  REQUEST_VALIDATION: "META_REQUEST_VALIDATION_ERROR",
  ENV: "META_ENV_ERROR",
  UNKNOWN: "META_UNKNOWN_ERROR",
});

function safeStr(value) {
  return String(value ?? "").trim();
}

function buildMetaWhatsAppError({
  errorCode = META_WHATSAPP_ERROR.UNKNOWN,
  message = "Meta WhatsApp send failed",
  status = 0,
  retryable = false,
  rawError = null,
  cause = null,
  details = {},
} = {}) {
  const err = new Error(safeStr(message) || "Meta WhatsApp send failed");
  err.name = "MetaWhatsAppError";
  err.ok = false;
  err.provider = "meta_whatsapp";
  err.status = Number(status) || 0;
  err.errorCode = safeStr(errorCode) || META_WHATSAPP_ERROR.UNKNOWN;
  err.retryable = Boolean(retryable);
  err.rawError = rawError && typeof rawError === "object" ? rawError : null;
  err.details = details && typeof details === "object" ? details : {};
  if (cause) err.cause = cause;
  return err;
}

function assertMetaEnv() {
  if (!safeStr(ACCESS_TOKEN) || !safeStr(PHONE_NUMBER_ID)) {
    throw buildMetaWhatsAppError({
      errorCode: META_WHATSAPP_ERROR.ENV,
      message: "Meta WhatsApp environment is not configured",
      retryable: false,
      details: {
        hasAccessToken: Boolean(safeStr(ACCESS_TOKEN)),
        hasPhoneNumberId: Boolean(safeStr(PHONE_NUMBER_ID)),
      },
    });
  }
}

function normalizeRecipientInput(input) {
  if (!input) return null;
  if (typeof input === "string") return safeStr(input);
  if (typeof input !== "object") return null;
  if (input.recipient) return safeStr(input.recipient);
  if (input.deliveryId) return safeStr(input.deliveryId);
  if (input.waId) return safeStr(input.waId);
  if (input.to) return safeStr(input.to);
  return null;
}

function classifyMetaError({ status = 0, payload = null, parseFailed = false } = {}) {
  if (parseFailed) {
    return {
      errorCode: META_WHATSAPP_ERROR.RESPONSE_PARSE,
      retryable: false,
    };
  }

  const code = Number(payload?.error?.code || 0);
  const subcode = Number(payload?.error?.error_subcode || 0);
  const type = safeStr(payload?.error?.type).toLowerCase();
  const message = safeStr(payload?.error?.message).toLowerCase();

  if (status === 401 || status === 403 || type === "oauthexception") {
    return {
      errorCode: META_WHATSAPP_ERROR.AUTH,
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      errorCode: META_WHATSAPP_ERROR.RATE_LIMIT,
      retryable: true,
    };
  }

  if (
    code === 131047 ||
    code === 470 ||
    message.includes("24 hours") ||
    message.includes("24-hour") ||
    message.includes("outside the allowed window") ||
    message.includes("outside of allowed window")
  ) {
    return {
      errorCode: META_WHATSAPP_ERROR.WINDOW,
      retryable: false,
    };
  }

  if (
    code === 131026 ||
    code === 131030 ||
    code === 100 ||
    subcode === 2494010 ||
    message.includes("invalid recipient") ||
    message.includes("recipient") ||
    message.includes("invalid parameter") ||
    message.includes("phone number")
  ) {
    return {
      errorCode: META_WHATSAPP_ERROR.RECIPIENT,
      retryable: false,
    };
  }

  if (status >= 500) {
    return {
      errorCode: META_WHATSAPP_ERROR.HTTP,
      retryable: true,
    };
  }

  if (status >= 400) {
    return {
      errorCode: META_WHATSAPP_ERROR.HTTP,
      retryable: false,
    };
  }

  return {
    errorCode: META_WHATSAPP_ERROR.UNKNOWN,
    retryable: false,
  };
}

async function emitWhatsAppSendErrorMetric(payload = {}) {
  try {
    const metricsModule = await import("../metrics.js");
    const tracker =
      metricsModule?.trackWhatsappSendError ||
      metricsModule?.trackWhatsAppSendError ||
      null;

    if (typeof tracker === "function") {
      await tracker(payload);
      return;
    }

    if (typeof metricsModule?.incMetricEvent === "function") {
      await metricsModule.incMetricEvent("whatsapp_send_error", payload?.userId || payload?.waId || "", payload?.date || new Date());
    }
  } catch {
    // sem throw: falha de métrica não pode mascarar falha de envio
  }
}

async function logWhatsAppOperationalError(payload = {}) {
  const entry = {
    module: "meta_whatsapp",
    source: "meta_whatsapp",
    event: safeStr(payload?.event || "send_error") || "send_error",
    level: safeStr(payload?.level || "error").toLowerCase() || "error",
    userId: safeStr(payload?.userId),
    waId: safeStr(payload?.waId),
    step: safeStr(payload?.step || "sendWhatsAppText"),
    status: safeStr(payload?.status),
    message: safeStr(payload?.message),
    errorCode: safeStr(payload?.errorCode),
    meta: {
      provider: "meta_whatsapp",
      recipient: safeStr(payload?.recipient),
      deliveryId: safeStr(payload?.deliveryId),
      retryable: Boolean(payload?.retryable),
      ...((payload?.meta && typeof payload.meta === "object") ? payload.meta : {}),
    },
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent(entry);
      return;
    }
    if (typeof audit?.logRuntimeError === "function") {
      await audit.logRuntimeError(entry);
      return;
    }
  } catch {
    // fallback para console estruturado abaixo
  }

  console.warn(
    JSON.stringify({
      level: entry.level,
      source: "meta_whatsapp",
      event: entry.event,
      provider: "meta_whatsapp",
      recipient: entry.meta.recipient,
      deliveryId: entry.meta.deliveryId,
      userId: entry.userId,
      waId: entry.waId,
      step: entry.step,
      status: entry.status,
      errorCode: entry.errorCode,
      retryable: entry.meta.retryable,
      message: entry.message,
    })
  );
}

async function reportMetaWhatsAppFailure(error, payload = {}) {
  const err = error && typeof error === "object"
    ? error
    : buildMetaWhatsAppError({
        errorCode: META_WHATSAPP_ERROR.UNKNOWN,
        message: safeStr(error) || "Meta WhatsApp send failed",
        retryable: false,
      });

  const metricPayload = {
    userId: safeStr(payload?.userId),
    waId: safeStr(payload?.waId || payload?.recipient || payload?.deliveryId),
    source: "meta_whatsapp",
    step: safeStr(payload?.step || "sendWhatsAppText"),
    errorCode: safeStr(err?.errorCode),
  };

  await emitWhatsAppSendErrorMetric(metricPayload);
  await logWhatsAppOperationalError({
    event: safeStr(payload?.event || "send_error") || "send_error",
    level: safeStr(payload?.level || "error").toLowerCase() || "error",
    userId: safeStr(payload?.userId),
    waId: safeStr(payload?.waId || payload?.recipient || payload?.deliveryId),
    recipient: safeStr(payload?.recipient),
    deliveryId: safeStr(payload?.deliveryId),
    step: safeStr(payload?.step || "sendWhatsAppText"),
    status: Number(err?.status) || 0,
    errorCode: safeStr(err?.errorCode),
    retryable: Boolean(err?.retryable),
    message: safeStr(err?.message),
    meta: {
      ...((payload?.meta && typeof payload.meta === "object") ? payload.meta : {}),
    },
  });

  return err;
}


export async function sendWhatsAppText({ to, recipient, text, userId = "", waId = "", step = "sendWhatsAppText" } = {}) {
  try {
    assertMetaEnv();
  } catch (error) {
    throw await reportMetaWhatsAppFailure(error, {
      event: "env_validation_failed",
      userId,
      waId,
      recipient: normalizeRecipientInput(recipient ?? to),
      step,
    });
  }

  const finalTo = normalizeRecipientInput(recipient ?? to);
  const messageText = safeStr(text);

  if (!finalTo) {
    const error = buildMetaWhatsAppError({
      errorCode: META_WHATSAPP_ERROR.REQUEST_VALIDATION,
      message: "Missing WhatsApp recipient",
      retryable: false,
      details: { step },
    });
    throw await reportMetaWhatsAppFailure(error, {
      event: "recipient_validation_failed",
      userId,
      waId,
      recipient: finalTo,
      step,
    });
  }

  if (!messageText) {
    const error = buildMetaWhatsAppError({
      errorCode: META_WHATSAPP_ERROR.REQUEST_VALIDATION,
      message: "Missing WhatsApp text body",
      retryable: false,
      details: { recipient: finalTo, step },
    });
    throw await reportMetaWhatsAppFailure(error, {
      event: "text_validation_failed",
      userId,
      waId,
      recipient: finalTo,
      step,
    });
  }

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: finalTo,
    type: "text",
    text: { body: messageText },
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    const err = buildMetaWhatsAppError({
      errorCode: META_WHATSAPP_ERROR.HTTP,
      message: "Meta WhatsApp request failed before receiving a response",
      retryable: true,
      cause,
      details: { recipient: finalTo, step },
    });

    throw await reportMetaWhatsAppFailure(err, {
      event: "request_failed",
      userId,
      waId: waId || finalTo,
      recipient: finalTo,
      deliveryId: finalTo,
      step,
    });
  }

  const rawText = await res.text();
  let data = null;
  let parseFailed = false;

  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    parseFailed = true;
  }

  if (!res.ok || parseFailed) {
    const classification = classifyMetaError({
      status: res.status,
      payload: data,
      parseFailed,
    });

    const err = buildMetaWhatsAppError({
      errorCode: classification.errorCode,
      message:
        safeStr(data?.error?.message) ||
        (parseFailed ? "Meta WhatsApp returned a non-JSON response" : `Meta WhatsApp HTTP ${res.status}`),
      status: res.status,
      retryable: classification.retryable,
      rawError: data,
      details: {
        recipient: finalTo,
        step,
      },
    });

    throw await reportMetaWhatsAppFailure(err, {
      event: parseFailed ? "response_parse_failed" : "response_not_ok",
      userId,
      waId: waId || finalTo,
      recipient: finalTo,
      deliveryId: finalTo,
      step,
    });
  }

  return {
    ok: true,
    status: res.status,
    provider: "meta_whatsapp",
    data,
  };
}

export const META_WHATSAPP_ERROR_CODES = META_WHATSAPP_ERROR;
