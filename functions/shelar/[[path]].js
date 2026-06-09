import { getShelarSession } from "../_auth.js";

const STATIC_PATHS = new Map([
  ["/shelar", "/index.html"],
  ["/shelar/", "/index.html"],
  ["/shelar/index.html", "/index.html"],
  ["/shelar/login.html", "/login.html"],
  ["/shelar/reset-password.html", "/reset-password.html"],
  ["/shelar/dashboard.html", "/dashboard.html"],
  ["/shelar/styles.css", "/styles.css"],
  ["/shelar/app.js", "/app.js"],
  ["/shelar/auth.js", "/auth.js"],
  ["/shelar/dashboard.js", "/dashboard.js"],
  ["/shelar/favicon.png", "/favicon.png"],
  ["/shelar/logo.png", "/logo.png"],
  ["/shelar/logo-full.png", "/logo-full.png"],
  ["/shelar/ratify-logo.png", "/ratify-logo.png"],
]);

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);

  if (url.pathname === "/shelar/dashboard.html") {
    const session = await getShelarSession(ctx);
    if (!session) {
      return Response.redirect(new URL("/shelar/login.html", url.origin), 302);
    }
  }

  const targetPath = STATIC_PATHS.get(url.pathname);
  if (!targetPath) {
    return ctx.next();
  }

  const assetUrl = new URL(targetPath, url.origin);
  return ctx.env.ASSETS.fetch(new Request(assetUrl.toString(), ctx.request));
}
