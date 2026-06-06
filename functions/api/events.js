import {
  getMergedEnv, getPublicConfig, ALLOWED_COLLECTIONS,
  firestoreCreate, firestoreList, json, jsonError,
} from "../_shared.js";

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const body = await ctx.request.json();

    if (!body || !ALLOWED_COLLECTIONS.has(body.collection)) {
      return jsonError("Invalid collection.", 400);
    }

    const requestedQrCodeId = body.payload?.qrCodeId || "";
    // Look up the QR record from Firestore to enrich branch/label/source
    let qrCode = null;
    if (requestedQrCodeId && env.FIREBASE_PROJECT_ID) {
      try {
        const docs = await firestoreList(env, "qrCodes");
        qrCode = docs.find(q => q.qrCodeId === requestedQrCodeId && q.status !== "deleted") || null;
      } catch { /* non-fatal */ }
    }

    const config = getPublicConfig(env, qrCode);
    const payload = {
      ...body.payload,
      type: body.type,
      businessId: body.payload?.businessId || config.businessId,
      branchId: body.payload?.branchId || qrCode?.branchId || config.branchId,
      branchName: body.payload?.branchName || qrCode?.branchName || config.branchName,
      qrCodeId: requestedQrCodeId || config.qrCodeId,
      qrLabel: body.payload?.qrLabel || qrCode?.label || config.qrLabel,
      source: body.payload?.source || qrCode?.source || qrCode?.staff || config.qrSource || "",
      campaign: body.payload?.campaign || qrCode?.campaign || config.campaign || "",
      status: body.collection === "feedback" ? (body.payload?.status || "pending") : body.payload?.status,
      userAgent: ctx.request.headers.get("user-agent") || "",
      createdAt: new Date().toISOString(),
    };

    const doc = await firestoreCreate(env, body.collection, payload);
    return json({ ok: true, path: doc.name });
  } catch (e) {
    console.error("events handler error:", e.message);
    return jsonError(e.message);
  }
}
