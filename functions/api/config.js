import { getMergedEnv, getPublicConfig, json, jsonError } from "../_shared.js";

export async function onRequestGet(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const url = new URL(ctx.request.url);
    const qrCodeId = url.searchParams.get("qr") || url.searchParams.get("qrCodeId") || "";
    return json(getPublicConfig(env));
  } catch (e) {
    return jsonError(e.message);
  }
}
