import {
  getMergedEnv, getPublicConfig, getDynamicQrUrl, getReviewPageUrl,
  EDITABLE_SETTINGS, readKvSettings, writeKvSettings, parseList,
  json, jsonError,
} from "../../_shared.js";

export async function onRequestGet(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    return json(buildSettingsResponse(env, ctx.request));
  } catch (e) {
    return jsonError(e.message);
  }
}

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const body = await ctx.request.json();
    const updates = body?.settings || {};
    const clean = {};

    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_SETTINGS.has(key)) continue;
      clean[key] = normalizeValue(key, value);
    }

    if (!Object.keys(clean).length) return jsonError("No editable settings provided.", 400);

    await writeKvSettings(ctx.env, clean);
    const merged = await getMergedEnv(ctx.env);
    return json({ ok: true, savedAt: new Date().toISOString(), ...buildSettingsResponse(merged, ctx.request) });
  } catch (e) {
    return jsonError(e.message);
  }
}

function buildSettingsResponse(env, request) {
  const config = getPublicConfig(env);
  const origin = new URL(request.url).origin;
  const hasFirebase = Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);

  const settings = Object.fromEntries(
    [...EDITABLE_SETTINGS].map(key => [key, env[key] || ""])
  );

  return {
    settings,
    derived: {
      dynamicQrUrl: getDynamicQrUrl(env),
      localDynamicQrUrl: `${origin}/r/${encodeURIComponent(config.qrCodeId)}`,
      reviewPageUrl: `${origin}${getReviewPageUrl(env, config.qrCodeId)}`,
      hasFirebaseCredentials: hasFirebase,
      firebaseStatus: hasFirebase ? "connected" : "not_configured",
      firebaseError: "",
    },
  };
}

function normalizeValue(key, value) {
  if (key === "REVIEW_TOPICS" || key === "FEEDBACK_TOPICS") {
    return parseList(value, "").slice(0, 12).join(",");
  }
  return String(value || "").replace(/\r\n/g, "\n").trim();
}
