import { getMergedEnv, firestorePatch, json, jsonError } from "../../../_shared.js";

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const { id, notes } = await ctx.request.json();
    if (!id) return jsonError("Missing feedback ID.", 400);

    const updates = {
      status: "resolved",
      resolutionNotes: notes || "",
      resolvedAt: new Date().toISOString(),
    };

    await firestorePatch(env, `feedback/${id}`, updates);
    return json({ ok: true });
  } catch (e) {
    return jsonError(e.message);
  }
}
