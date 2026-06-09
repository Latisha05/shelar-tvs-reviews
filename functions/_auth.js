import { getMergedEnv, json, jsonError } from "./_shared.js";

const SHELAR_CLIENT = "shelar-tvs";
const SHELAR_COOKIE = "rf_session_shelar";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// ── Login via Firebase Authentication REST API ───────────────────────────────
export async function onShelarLogin(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const body = await ctx.request.json();
    const email = normalizeEmail(body?.email);
    const password = String(body?.password || "");
    if (!email || !password) {
      return jsonError("Email and password are required.", 400);
    }

    const apiKey = env.FIREBASE_API_KEY;
    if (!apiKey) {
      return jsonError("Firebase API key not configured.", 500);
    }

    // Verify credentials directly with Firebase Authentication
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: false }),
      },
    );
    const authData = await authRes.json();

    if (!authRes.ok) {
      const msg = authData.error?.message || "";
      const isCredentialError = msg.includes("INVALID_PASSWORD") ||
        msg.includes("EMAIL_NOT_FOUND") ||
        msg.includes("INVALID_LOGIN_CREDENTIALS") ||
        msg.includes("USER_NOT_FOUND");
      return jsonError(
        isCredentialError ? "Incorrect email or password." : "Sign in failed. Please try again.",
        401,
      );
    }

    // Issue a signed session cookie (same system as before)
    const token = await signSessionToken(env, {
      email: authData.email,
      client: SHELAR_CLIENT,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });

    return json(
      { ok: true, client: SHELAR_CLIENT, email: authData.email },
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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
