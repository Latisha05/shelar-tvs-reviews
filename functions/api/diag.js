import { getMergedEnv, json } from "../_shared.js";

// Safe diagnostic — reports whether secrets are present WITHOUT revealing them.
export async function onRequestGet(ctx) {
  const env = await getMergedEnv(ctx.env);
  const pk = env.FIREBASE_PRIVATE_KEY || "";
  return json({
    hasProjectId: Boolean(env.FIREBASE_PROJECT_ID),
    projectId: env.FIREBASE_PROJECT_ID || null,
    hasClientEmail: Boolean(env.FIREBASE_CLIENT_EMAIL),
    clientEmailTail: env.FIREBASE_CLIENT_EMAIL ? env.FIREBASE_CLIENT_EMAIL.slice(-30) : null,
    hasPrivateKey: Boolean(pk),
    privateKeyLength: pk.length,
    privateKeyStartsCorrectly: pk.includes("BEGIN PRIVATE KEY"),
    privateKeyHasLiteralBackslashN: pk.includes("\\n"),
    privateKeyHasRealNewlines: pk.includes("\n"),
    hasKvBinding: Boolean(ctx.env.RF_SETTINGS),
  });
}
