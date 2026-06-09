import { jsonError } from "../../_shared.js";
import { onShelarLogin, onShelarLogout, onShelarSession, requireShelarSession } from "../../_auth.js";
import { onRequestGet as onConfigGet } from "../../api/config.js";
import { onRequestPost as onEventsPost } from "../../api/events.js";
import { onRequestPost as onReviewGeneratePost } from "../../api/review/generate.js";
import { onRequestGet as onDashboardDataGet } from "../../api/dashboard/data.js";
import { onRequestGet as onDashboardSettingsGet, onRequestPost as onDashboardSettingsPost } from "../../api/dashboard/settings.js";
import { onRequestPost as onFeedbackResolvePost } from "../../api/dashboard/feedback/resolve.js";
import { onRequestPost as onQrcodesPost } from "../../api/dashboard/qrcodes.js";
import { onRequestDelete as onQrcodeDelete } from "../../api/dashboard/qrcodes/[id].js";

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const apiPath = url.pathname.replace(/^\/shelar\/api\/?/, "");

  if (ctx.request.method === "GET" && apiPath === "auth/session") {
    return onShelarSession(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "auth/login") {
    return onShelarLogin(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "auth/logout") {
    return onShelarLogout(ctx);
  }

  if (ctx.request.method === "GET" && apiPath === "config") {
    return onConfigGet(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "events") {
    return onEventsPost(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "review/generate") {
    return onReviewGeneratePost(ctx);
  }

  const session = await requireShelarSession(ctx);
  if (!session) {
    return jsonError("Authentication required.", 401);
  }

  if (ctx.request.method === "GET" && apiPath === "dashboard/data") {
    return onDashboardDataGet(ctx);
  }

  if (ctx.request.method === "GET" && apiPath === "dashboard/settings") {
    return onDashboardSettingsGet(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "dashboard/settings") {
    return onDashboardSettingsPost(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "dashboard/feedback/resolve") {
    return onFeedbackResolvePost(ctx);
  }

  if (ctx.request.method === "POST" && apiPath === "dashboard/qrcodes") {
    return onQrcodesPost(ctx);
  }

  if (ctx.request.method === "DELETE" && apiPath.startsWith("dashboard/qrcodes/")) {
    return onQrcodeDelete(ctx);
  }

  return jsonError("Not found.", 404);
}
