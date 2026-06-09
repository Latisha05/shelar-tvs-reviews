export async function serveShelarAsset(ctx, targetPath) {
  const url = new URL(ctx.request.url);
  const assetUrl = new URL(targetPath, url.origin);
  return ctx.env.ASSETS.fetch(new Request(assetUrl.toString(), ctx.request));
}
