import { getMergedEnv, getDynamicQrUrl, getReviewPageUrl, firestoreList, json, jsonError } from "../../_shared.js";

export async function onRequestGet(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);

    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      return json({ ratings: [], feedback: [], reviewEvents: [], postedReviews: [], scans: [], qrCodes: [], businesses: [], branches: [] });
    }

    const [ratings, feedback, reviewEvents, postedReviews, scans, qrCodes, businesses, branches] = await Promise.all([
      firestoreList(env, "ratings"),
      firestoreList(env, "feedback"),
      firestoreList(env, "reviewEvents"),
      firestoreList(env, "postedReviews"),
      firestoreList(env, "scans"),
      firestoreList(env, "qrCodes"),
      firestoreList(env, "businesses"),
      firestoreList(env, "branches"),
    ]);

    const scanCounts = scans.reduce((acc, s) => {
      if (s.qrCodeId) acc[s.qrCodeId] = (acc[s.qrCodeId] || 0) + 1;
      return acc;
    }, {});

    const enrichedQrCodes = qrCodes.map(qr => ({
      ...qr,
      scanCount: scanCounts[qr.qrCodeId] || Number(qr.scanCount || 0),
      dynamicUrl: qr.dynamicUrl || getDynamicQrUrl(env, qr.qrCodeId),
      targetPath: qr.targetPath || getReviewPageUrl(env, qr.qrCodeId),
    }));

    return json({ ratings, feedback, reviewEvents, postedReviews, scans, qrCodes: enrichedQrCodes, businesses, branches });
  } catch (e) {
    return jsonError(e.message);
  }
}
