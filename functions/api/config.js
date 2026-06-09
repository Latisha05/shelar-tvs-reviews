import { getMergedEnv, getPublicConfig, firestoreList, json, jsonError } from "../_shared.js";
import { onShelarLogin, onShelarLogout, onShelarSession } from "../_auth.js";

export async function onRequestGet(ctx) {
  try {
    const op = new URL(ctx.request.url).searchParams.get("op");
    if (op === "session") {
      return onShelarSession(ctx);
    }

    const env = await getMergedEnv(ctx.env);
    const url = new URL(ctx.request.url);
    const qrCodeId = url.searchParams.get("qr") || url.searchParams.get("qrCodeId") || "";
    let qrCode = null;
    if (qrCodeId && env.FIREBASE_PROJECT_ID) {
      try {
        const docs = await firestoreList(env, "qrCodes");
        qrCode = docs.find(q => q.qrCodeId === qrCodeId && q.status !== "deleted") || null;
      } catch { /* Fall back to project defaults. */ }
    }
    return json(getPublicConfig(env, qrCode));
  } catch (e) {
    return jsonError(e.message);
  }
}

export async function onRequestPost(ctx) {
  const op = new URL(ctx.request.url).searchParams.get("op");
  if (op === "login") {
    return onShelarLogin(ctx);
  }
  if (op === "logout") {
    return onShelarLogout(ctx);
  }
  return jsonError("Not found.", 404);
}
