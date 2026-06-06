import {
  getMergedEnv, getPublicConfig, getReviewPageUrl,
  firestoreCreate, firestoreList, firestorePatch,
} from "../_shared.js";

export async function onRequestGet(ctx) {
  const env = await getMergedEnv(ctx.env);
  const qrCodeId = ctx.params.qrCodeId || "";

  // Track the scan (non-blocking)
  ctx.waitUntil(trackScan(env, qrCodeId, ctx.request));

  // Look up QR record for branch/source context
  let qrCode = null;
  if (env.FIREBASE_PROJECT_ID) {
    try {
      const docs = await firestoreList(env, "qrCodes");
      qrCode = docs.find(q => q.qrCodeId === qrCodeId && q.status !== "deleted") || null;
    } catch { /* non-fatal */ }
  }

  const redirectUrl = getReviewPageUrl(env, qrCodeId, qrCode);
  return Response.redirect(new URL(redirectUrl, new URL(ctx.request.url).origin).href, 302);
}

async function trackScan(env, qrCodeId, request) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return;

  const ua = request.headers.get("user-agent") || "";
  let deviceType = "Desktop";
  if (/mobile/i.test(ua)) deviceType = "Mobile";
  else if (/tablet/i.test(ua)) deviceType = "Tablet";

  const referer = request.headers.get("referer") || "";
  let visitSource = "QR Scan";
  if (referer) {
    try { visitSource = new URL(referer).hostname; } catch { visitSource = "External Link"; }
  }

  const config = getPublicConfig(env);
  const cf = request.cf || {};

  const scanEvent = {
    businessId: config.businessId,
    branchId: config.branchId,
    branchName: config.branchName,
    qrCodeId,
    deviceType,
    visitSource,
    country: cf.country || "",
    userAgent: ua,
    createdAt: new Date().toISOString(),
  };

  try {
    await firestoreCreate(env, "scans", scanEvent);
  } catch { /* non-fatal */ }
}
