// Shared utilities for all Cloudflare Pages Functions

export const ALLOWED_COLLECTIONS = new Set(["ratings", "feedback", "reviewEvents", "postedReviews"]);

export const EDITABLE_SETTINGS = new Set([
  "APP_BUSINESS_NAME", "APP_BASE_URL", "BUSINESS_ID", "BRANCH_ID", "BRANCH_NAME",
  "QR_CODE_ID", "QR_CODE_LABEL", "GOOGLE_PLACE_ID", "REVIEW_TOPICS", "FEEDBACK_TOPICS",
  "GEMINI_MODEL", "REVIEW_SYSTEM_PROMPT", "AI_TONE", "AI_LENGTH",
]);

// In-memory token cache (per isolate lifetime)
let tokenCache = { token: "", expiresAt: 0 };

export function getEnv(ctx) {
  // ctx.env in Pages Functions, fallback for local dev via wrangler
  return ctx.env || {};
}

export function getPublicConfig(env, qrCode = null) {
  return {
    businessName: env.APP_BUSINESS_NAME || "Shelar TVS",
    businessId: env.BUSINESS_ID || "shelar-tvs",
    branchId: qrCode?.branchId || env.BRANCH_ID || "main",
    branchName: qrCode?.branchName || env.BRANCH_NAME || "Pune",
    qrCodeId: qrCode?.qrCodeId || env.QR_CODE_ID || "shelar-tvs-main",
    qrLabel: qrCode?.label || env.QR_CODE_LABEL || "Shelar TVS Main QR",
    qrSource: qrCode?.source || qrCode?.staff || qrCode?.campaign || "",
    campaign: qrCode?.campaign || "",
    googlePlaceId: qrCode?.googlePlaceId || env.GOOGLE_PLACE_ID || "",
    reviewModel: env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    reviewSystemPrompt: env.REVIEW_SYSTEM_PROMPT || "You write realistic, natural Google reviews from real customers of Shelar TVS, a TVS two-wheeler showroom and service centre in Pune. Output only one review — no title, no bullets, no quotes, no explanation. Sound like a genuine local customer sharing a real purchase or service experience, not a marketing copy. Vary sentence structure every time. Weave in one or two search-relevant phrases naturally — such as Shelar TVS, TVS showroom Pune, Apache near me, Jupiter near me, TVS bike near me, best TVS deals Pune, TVS service Pune, genuine TVS parts — only if they fit the sentence. Never list keywords. Mention concrete touches: a friendly executive, a test ride, smooth EMI, on-time delivery, fair pricing, clean workshop. Do not use emojis, hashtags, AI/SEO mentions, incentive language, or the phrase highly recommended more than once.",
    reviewTopics: parseList(env.REVIEW_TOPICS, "New Bike Purchase,New Scooter Purchase,Test Ride Experience,Best Price/Deal,Quick Delivery,Smooth Paperwork,Easy EMI Process,Helpful Staff,Knowledgeable Executive,Genuine Parts,Timely Service"),
    feedbackTopics: parseList(env.FEEDBACK_TOPICS, "Service Delay,Long Wait for Delivery,Parts Issue,Hidden Charges,Staff Behavior,Test Ride Denied,Billing Problem,Insurance/Loan Issue,Lack of Information"),
    aiTone: env.AI_TONE || "Enthusiastic",
    aiLength: env.AI_LENGTH || "medium",
  };
}

export function getReviewPageUrl(env, qrCodeId, qrCode = null) {
  const config = getPublicConfig(env, qrCode);
  const params = new URLSearchParams({
    business: config.businessId,
    branch: config.branchId,
    qr: qrCodeId || config.qrCodeId,
  });
  if (config.qrSource) params.set("source", config.qrSource);
  if (config.campaign) params.set("campaign", config.campaign);
  return `/shelar/?${params}`;
}

export function getDynamicQrUrl(env, qrCodeId = "") {
  const config = getPublicConfig(env);
  const baseUrl = (env.APP_BASE_URL || "https://shelar-tvs-reviews.pages.dev").replace(/\/$/, "");
  return `${baseUrl}/r/${encodeURIComponent(qrCodeId || config.qrCodeId)}`;
}

export function parseList(value, fallback) {
  return String(value || fallback).split(",").map(s => s.trim()).filter(Boolean);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function jsonError(message, status = 500) {
  return json({ error: message }, status);
}

// ── Firestore REST helpers ──────────────────────────────────────────────────

export async function getAccessToken(env) {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  if (!clientEmail || !env.FIREBASE_PRIVATE_KEY || !env.FIREBASE_PROJECT_ID) {
    const missing = [
      !env.FIREBASE_PROJECT_ID && "FIREBASE_PROJECT_ID",
      !clientEmail && "FIREBASE_CLIENT_EMAIL",
      !env.FIREBASE_PRIVATE_KEY && "FIREBASE_PRIVATE_KEY",
    ].filter(Boolean).join(", ");
    throw new Error(`Firebase credentials missing: ${missing}. Set them as Production secrets in Cloudflare Pages and redeploy.`);
  }
  // Normalize key: handle both literal \n strings and already-newlined values
  const privateKeyPem = env.FIREBASE_PRIVATE_KEY
    .replace(/\\n/g, "\n")        // literal backslash-n → newline
    .replace(/\r\n/g, "\n")       // Windows line endings
    .trim();

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  const signingInput = `${header}.${claim}`;
  const key = await importRsaKey(privateKeyPem);
  const sigBuffer = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sigBuffer)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || "Failed to get Firebase token.");

  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function importRsaKey(pem) {
  const pemBody = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Namespace every collection so this client's data never mixes with other
// clients that share the same Firebase project.
function prefixFirestorePath(env, collectionOrPath) {
  const prefix = String(env.DATA_PREFIX || "shelartvs").trim();
  if (!prefix) return collectionOrPath;
  const [collection, ...rest] = String(collectionOrPath).split("/");
  const prefixed = `${prefix}_${collection}`;
  return rest.length ? `${prefixed}/${rest.join("/")}` : prefixed;
}

export async function firestoreCreate(env, collection, data) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(env, collection)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getAccessToken(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify(toFirestoreDoc(data)),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || "Firestore create failed.");
  return body;
}

export async function firestorePatch(env, docPath, data) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const fieldPaths = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(env, docPath)}?${fieldPaths}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await getAccessToken(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify(toFirestoreDoc(data)),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || "Firestore patch failed.");
  return body;
}

export async function firestoreGet(env, docPath) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(env, docPath)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await getAccessToken(env)}` },
  });
  if (res.status === 404) return null;
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || "Firestore get failed.");
  return fromFirestoreDoc(body);
}

export async function firestoreList(env, collection) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(env, collection)}?pageSize=300`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await getAccessToken(env)}` },
  });
  if (res.status === 404) return [];
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Firestore list failed for ${collection}.`);
  return (body.documents || []).map(fromFirestoreDoc);
}

function toFirestoreDoc(data) {
  return {
    fields: Object.fromEntries(
      Object.entries(data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toFsValue(v)])
    ),
  };
}

function toFsValue(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, n]) => n !== undefined).map(([k, n]) => [k, toFsValue(n)])) } };
  return { stringValue: String(v) };
}

function fromFirestoreDoc(doc) {
  const data = {};
  for (const [k, v] of Object.entries(doc.fields || {})) data[k] = fromFsValue(v);
  const parts = doc.name.split("/");
  data.id = parts[parts.length - 1];
  return data;
}

function fromFsValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, n]) => [k, fromFsValue(n)]));
  return v;
}

// ── KV Settings helpers ─────────────────────────────────────────────────────
// Settings are stored in KV under a client-specific key so this Pages project
// can safely share the RF_SETTINGS namespace with other review funnels.
function getSettingsKey(env) {
  const prefix = String(env.DATA_PREFIX || env.BUSINESS_ID || "shelartvs").trim();
  return prefix ? `settings:${prefix}` : "settings";
}

export async function readKvSettings(env) {
  if (!env.RF_SETTINGS) return {};
  try {
    const raw = await env.RF_SETTINGS.get(getSettingsKey(env));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function writeKvSettings(env, updates) {
  if (!env.RF_SETTINGS) return;
  const current = await readKvSettings(env);
  await env.RF_SETTINGS.put(getSettingsKey(env), JSON.stringify({ ...current, ...updates }));
}

// Merge env vars (wrangler.toml) with KV overrides (dashboard edits win)
export async function getMergedEnv(env) {
  const kvSettings = await readKvSettings(env);
  return { ...env, ...kvSettings };
}
