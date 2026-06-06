import { getMergedEnv, getPublicConfig, firestoreList, json, jsonError } from "../_shared.js";

export async function onRequestGet(ctx) {
  try {
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
