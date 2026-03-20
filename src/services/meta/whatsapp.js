const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

function assertMetaEnv() {
  if (!ACCESS_TOKEN) throw new Error("Missing ACCESS_TOKEN");
  if (!PHONE_NUMBER_ID) throw new Error("Missing PHONE_NUMBER_ID");
}

function normalizeRecipientInput(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  if (typeof input !== "object") return null;
  if (input.recipient) return input.recipient;
  if (input.deliveryId) return input.deliveryId;
  if (input.waId) return input.waId;
  return null;
}

export async function sendWhatsAppText({ to, recipient, text }) {
  assertMetaEnv();

  const finalTo = normalizeRecipientInput(recipient ?? to);
  if (!finalTo) throw new Error("Missing recipient 'to'");
  if (!text) throw new Error("Missing 'text'");

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: String(finalTo),
    type: "text",
    text: { body: String(text) },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Meta send error: ${msg}`);
  }

  return data;
}
