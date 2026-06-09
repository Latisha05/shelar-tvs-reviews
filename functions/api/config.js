import { getMergedEnv, getPublicConfig, firestoreList, json, jsonError } from "../_shared.js";
import { onShelarLogin, onShelarSession } from "../_auth.js";

export async function onRequestGet(ctx) {
  try {
    const op = new URL(ctx.request.url).searchParams.get("op");
    if (op === "session") {
      return onShelarSession(ctx);
    }
    if (op === "login") {
      const url = new URL(ctx.request.url);
      const email = url.searchParams.get("email") || "";
      const password = url.searchParams.get("password") || "";
      const loginRequest = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return onShelarLogin({ ...ctx, request: loginRequest });
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
