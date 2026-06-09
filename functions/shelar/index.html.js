import { serveShelarAsset } from "./_static.js";

export async function onRequest(ctx) {
  return serveShelarAsset(ctx, "/index.html");
}
