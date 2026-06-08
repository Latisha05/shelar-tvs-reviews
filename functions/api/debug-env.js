export async function onRequestGet(ctx) {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(ctx.env || {})) {
    if (key.includes("KEY") || key.includes("SECRET") || key.includes("PRIVATE") || key.includes("PASSWORD")) {
      cleanEnv[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && typeof value.get === "function") {
      cleanEnv[key] = "[KV BINDING]";
    } else if (typeof value === "object") {
      cleanEnv[key] = "[OBJECT]";
    } else {
      cleanEnv[key] = value;
    }
  }
  return new Response(JSON.stringify(cleanEnv, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}
