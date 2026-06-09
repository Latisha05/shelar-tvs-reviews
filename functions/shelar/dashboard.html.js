import { serveShelarAsset } from "./_static.js";
import { getShelarSession } from "../_auth.js";

export async function onRequest(ctx) {
  const session = await getShelarSession(ctx);
  if (!session) {
    return Response.redirect(new URL("/shelar/login.html", ctx.request.url).toString(), 302);
  }
  return serveShelarAsset(ctx, "/dashboard.html");
}
