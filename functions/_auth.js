import { firestoreGet, getMergedEnv, json, jsonError } from "./_shared.js";

const SHELAR_CLIENT = "shelar-tvs";
const SHELAR_COOKIE = "rf_session_shelar";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function onShelarLogin(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const body = await ctx.request.json();
    const email = normalizeEmail(body?.email);
    const password = String(body?.password || "");
    if (!email || !password) {
      return jsonError("Email and password are required.", 400);
    }

    const user = await getShelarUserByEmail(env, email);
    if (!user || user.passwordHash !== await hashPassword(password)) {
      return jsonError("Incorrect email or password.", 401);
    }

    const token = await signSessionToken(env, {
      email: user.email,
      client: SHELAR_CLIENT,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });

    return json(
      { ok: true, client: SHELAR_CLIENT, email: user.email },
      200,
      {
        "Set-Cookie": serializeCookie(SHELAR_COOKIE, token, {
          path: "/shelar",
          maxAge: SESSION_TTL_SECONDS,
          httpOnly: true,
          sameSite: "Lax",
          secure: true,
        }),
      },
    );
  } catch (error) {
    return jsonError(error.message);
  }
}

export async function onShelarSession(ctx) {
  try {
    const session = await getShelarSession(ctx);
    if (!session) {
      return json({ authenticated: false });
    }
    return json({
      authenticated: true,
      session: {
        email: session.email,
        client: session.client,
        expiresAt: new Date(session.exp * 1000).toISOString(),
      },
    });
  } catch (error) {
    return jsonError(error.message);
  }
}

export async function onShelarLogout() {
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": serializeCookie(SHELAR_COOKIE, "", {
        path: "/shelar",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
      }),
    },
  );
}

export async function requireShelarSession(ctx) {
  const session = await getShelarSession(ctx);
  if (!session) {
    return null;
  }
  return session;
}

export async function getShelarSession(ctx) {
  const env = await getMergedEnv(ctx.env);
  const cookie = readCookie(ctx.request, SHELAR_COOKIE);
  if (!cookie) return null;
  const payload = await verifySessionToken(env, cookie);
  if (!payload || payload.client !== SHELAR_CLIENT || payload.exp * 1000 <= Date.now()) {
    return null;
  }
  return payload;
}

async function getShelarUserByEmail(env, email) {
  if (!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY)) {
    throw new Error("Firebase credentials missing for deployed auth.");
  }
  return firestoreGet(env, `clientUsers/${getEmailDocKey(email)}`);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getEmailDocKey(email) {
  return toBase64Url(new TextEncoder().encode(normalizeEmail(email)));
}

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(`review-funnel-auth:${String(password || "")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signSessionToken(env, payload) {
  const payloadText = JSON.stringify(payload);
  const payloadEncoded = toBase64Url(new TextEncoder().encode(payloadText));
  const signature = await signHmac(env, payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

async function verifySessionToken(env, token) {
  const [payloadEncoded, signature] = String(token || "").split(".");
  if (!payloadEncoded || !signature) return null;
  const expected = await signHmac(env, payloadEncoded);
  if (expected !== signature) return null;
  try {
    const payloadBytes = fromBase64Url(payloadEncoded);
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
}

async function signHmac(env, value) {
  const secret = getAuthSecret(env);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(signature));
}

function getAuthSecret(env) {
  return String(env.AUTH_SECRET || env.FIREBASE_PRIVATE_KEY || env.FIREBASE_CLIENT_EMAIL || "shelar-tvs-auth-secret");
}

function readCookie(request, name) {
  const cookies = String(request.headers.get("cookie") || "").split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    if (!cookie) continue;
    const index = cookie.indexOf("=");
    const key = index >= 0 ? cookie.slice(0, index) : cookie;
    if (key === name) {
      return decodeURIComponent(index >= 0 ? cookie.slice(index + 1) : "");
    }
  }
  return "";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
