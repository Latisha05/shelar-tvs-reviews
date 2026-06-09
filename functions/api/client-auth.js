import { onShelarLogin, onShelarLogout, onShelarSession } from "../_auth.js";
import { jsonError } from "../_shared.js";

export async function onRequestGet(ctx) {
  const op = new URL(ctx.request.url).searchParams.get("op");
  if (op === "session") {
    return onShelarSession(ctx);
  }
  return jsonError("Not found.", 404);
}

export async function onRequestPost(ctx) {
  const op = new URL(ctx.request.url).searchParams.get("op");
  if (op === "login") {
    return onShelarLogin(ctx);
  }
  if (op === "logout") {
    return onShelarLogout(ctx);
  }
  return jsonError("Not found.", 404);
}
