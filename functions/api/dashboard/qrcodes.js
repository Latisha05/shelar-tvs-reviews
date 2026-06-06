import {
  getMergedEnv, getPublicConfig, getDynamicQrUrl, getReviewPageUrl,
  firestorePatch, firestoreList, json, jsonError,
} from "../../_shared.js";

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const body = await ctx.request.json();
    const { label, branchName, staff, source, campaign } = body;
    const qrCodeId = normalizeSlug(body.qrCodeId || label || "");
    if (!qrCodeId) return jsonError("Missing QR Code ID.", 400);

    const finalBranchName = String(branchName || env.BRANCH_NAME || "Main").trim();
    const branchId = normalizeSlug(body.branchId || finalBranchName || env.BRANCH_ID || "main");
    const config = getPublicConfig(env);

    const payload = {
      qrCodeId,
      businessId: config.businessId,
      label: String(label || `QR for ${staff || source || campaign || finalBranchName}`).trim(),
      branchId,
      branchName: finalBranchName,
      source: String(source || staff || "").trim(),
      staff: String(staff || "").trim(),
      campaign: String(campaign || "").trim(),
      scanCount: 0,
      dynamicUrl: getDynamicQrUrl(env, qrCodeId),
      targetPath: getReviewPageUrl(env, qrCodeId),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await firestorePatch(env, `qrCodes/${qrCodeId}`, payload);
    return json({ ok: true, qrCode: payload });
  } catch (e) {
    return jsonError(e.message);
  }
}

export async function onRequestDelete(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const url = new URL(ctx.request.url);
    const qrCodeId = decodeURIComponent(url.pathname.split("/").pop());
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

function normalizeSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
