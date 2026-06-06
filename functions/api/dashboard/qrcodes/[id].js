import { getMergedEnv, firestorePatch, json, jsonError } from "../../../_shared.js";

export async function onRequestDelete(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const qrCodeId = ctx.params.id;
    if (!qrCodeId) return jsonError("Missing QR Code ID.", 400);

    await firestorePatch(env, `qrCodes/${qrCodeId}`, {
      status: "deleted",
      deletedAt: new Date().toISOString(),
    });
    return json({ ok: true });
  } catch (e) {
    return jsonError(e.message);
  }
}
