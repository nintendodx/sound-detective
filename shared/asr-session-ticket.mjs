const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function ticketSecret(env = {}) {
  return String(env.ASR_SESSION_SECRET || env.TENCENT_ASR_SECRET_KEY || "");
}

async function hmacKey(env) {
  const secret = ticketSecret(env);
  if (!secret) throw Error("缺少 ASR 会话签名密钥");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign", "verify"]);
}

export async function createAsrSessionTicket(env, claims = {}, ttlMs = 15 * 60 * 1000) {
  const payload = {
    sessionId:String(claims.sessionId || ""),
    userId:String(claims.userId || ""),
    provider:String(claims.provider || ""),
    questionIds:[...new Set((claims.questionIds || []).map(String).filter(Boolean))],
    expiresAt:Date.now() + ttlMs
  };
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(encoded));
  return `${encoded}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyAsrSessionTicket(env, ticket, expected = {}) {
  try {
    const [encoded, signature] = String(ticket || "").split(".");
    if (!encoded || !signature) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), decodeBase64Url(signature), encoder.encode(encoded));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    if (Number(claims.expiresAt || 0) <= Date.now()) return null;
    if (expected.sessionId && claims.sessionId !== String(expected.sessionId)) return null;
    if (expected.provider && claims.provider !== String(expected.provider)) return null;
    if (expected.questionId && !claims.questionIds?.includes(String(expected.questionId))) return null;
    return claims;
  } catch {
    return null;
  }
}
