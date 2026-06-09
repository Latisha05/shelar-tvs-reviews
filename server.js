const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");

const rootDir = __dirname;
const localDbPath = path.join(rootDir, "data_store.json");
const env = { ...loadEnv(path.join(rootDir, ".env")), ...getNonEmptyProcessEnv() };
const port = Number(env.PORT || 5500);
// All Firestore collections are namespaced with this prefix so this client's
// data never mixes with other clients sharing the same Firebase project.
const dataPrefix = String(env.DATA_PREFIX || "shelartvs").trim();
const allowedCollections = new Set(["ratings", "feedback", "reviewEvents", "postedReviews"]);

function getClientFromRequest(request) {
  if (request?.clientOverride) {
    return request.clientOverride;
  }
  if (!request || !request.url) return "shelar-tvs";
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/eesweb/")) {
      return "eesweb";
    }
    if (url.pathname.startsWith("/shelar/")) {
      return "shelar-tvs";
    }
    const client = url.searchParams.get("client");
    if (client === "eesweb" || client === "shelar-tvs") {
      return client;
    }
    const qrCodeId = url.searchParams.get("qr") || url.searchParams.get("qrCodeId");
    if (qrCodeId) {
      if (getQrCodeFromLocalDb(qrCodeId, "eesweb")) {
        return "eesweb";
      }
    }
  } catch {
    // Ignore URL parse error
  }
  return "shelar-tvs";
}

function getRouteInfo(request) {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname.startsWith("/eesweb/api/")) {
    return { pathname: pathname.slice(7), client: "eesweb", clientApi: true };
  }

  if (pathname.startsWith("/shelar/api/")) {
    return { pathname: pathname.slice(7), client: "shelar-tvs", clientApi: true };
  }

  return { pathname, client: getClientFromRequest(request), clientApi: false };
}

function getEnvForClient(client) {
  if (client === "eesweb") {
    return { ...loadEnv(path.join(rootDir, "..", ".env")), ...getNonEmptyProcessEnv() };
  }
  return env;
}

// Prefix the collection segment of a Firestore path
function prefixFirestorePath(collectionOrPath, client = "shelar-tvs") {
  const prefix = client === "eesweb" ? "" : "shelartvs";
  if (!prefix) return collectionOrPath;
  const [collection, ...rest] = String(collectionOrPath).split("/");
  const prefixed = `${prefix}_${collection}`;
  return rest.length ? `${prefixed}/${rest.join("/")}` : prefixed;
}
const editableSettings = new Set([
  "APP_BUSINESS_NAME",
  "APP_BASE_URL",
  "BUSINESS_ID",
  "BRANCH_ID",
  "BRANCH_NAME",
  "QR_CODE_ID",
  "QR_CODE_LABEL",
  "GOOGLE_PLACE_ID",
  "REVIEW_TOPICS",
  "FEEDBACK_TOPICS",
  "GEMINI_MODEL",
  "REVIEW_SYSTEM_PROMPT",
  "AI_TONE",
  "AI_LENGTH",
]);

let accessTokenCache = {
  token: "",
  expiresAt: 0,
};

let firebaseDiagnostics = {
  status: "not_configured",
  error: "",
};

if (process.argv.includes("--bootstrap")) {
  bootstrapFirestore()
    .then(() => console.log("Firestore bootstrap complete."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
} else {
  bootstrapLocalDbIfEmpty();
  bootstrapPersistentStorage().catch((error) => {
    console.warn("Storage bootstrap warning:", error.message);
  });
  http
    .createServer(async (request, response) => {
      try {
        const routeInfo = getRouteInfo(request);
        request.clientOverride = routeInfo.client;
        const pathname = routeInfo.pathname;

        if (routeInfo.clientApi && request.method === "GET" && pathname === "/api/auth/session") {
          sendJson(response, 200, await getAuthSessionResponse(request));
          return;
        }

        if (routeInfo.clientApi && request.method === "POST" && pathname === "/api/auth/login") {
          const body = await readJson(request);
          await handleLogin(body, request, response);
          return;
        }

        if (routeInfo.clientApi && request.method === "POST" && pathname === "/api/auth/logout") {
          await handleLogout(request, response);
          return;
        }

        if (routeInfo.clientApi && request.method === "POST" && pathname === "/api/auth/forgot-password") {
          const body = await readJson(request);
          sendJson(response, 200, await handleForgotPassword(body, request));
          return;
        }

        if (routeInfo.clientApi && request.method === "POST" && pathname === "/api/auth/reset-password") {
          const body = await readJson(request);
          sendJson(response, 200, await handleResetPassword(body, request));
          return;
        }

        if (request.method === "GET" && pathname === "/api/config") {
          sendJson(response, 200, getPublicConfigFromRequest(request));
          return;
        }

        if (request.method === "GET" && pathname === "/api/dashboard/settings") {
          if (routeInfo.clientApi) await requireClientSession(request);
          sendJson(response, 200, getDashboardSettings(request));
          return;
        }

        if (request.method === "GET" && pathname === "/api/dashboard/data") {
          if (routeInfo.clientApi) await requireClientSession(request);
          sendJson(response, 200, await getDashboardData(request));
          return;
        }

        if (request.method === "GET" && pathname.startsWith("/r/")) {
          handleDynamicQrRedirect(request, response);
          return;
        }

        if (request.method === "POST" && pathname === "/api/dashboard/settings") {
          if (routeInfo.clientApi) await requireClientSession(request);
          const body = await readJson(request);
          sendJson(response, 200, await updateDashboardSettings(body, request));
          return;
        }

        if (request.method === "POST" && pathname === "/api/events") {
          const body = await readJson(request);
          sendJson(response, 200, await handleEvent(body, request));
          return;
        }

        if (request.method === "POST" && pathname === "/api/review/generate") {
          const body = await readJson(request);
          sendJson(response, 200, await handleReviewGenerate(body, request));
          return;
        }

        if (request.method === "POST" && pathname === "/api/dashboard/feedback/resolve") {
          if (routeInfo.clientApi) await requireClientSession(request);
          const body = await readJson(request);
          sendJson(response, 200, await resolveFeedback(body, request));
          return;
        }

        if (request.method === "POST" && pathname === "/api/dashboard/qrcodes") {
          if (routeInfo.clientApi) await requireClientSession(request);
          const body = await readJson(request);
          sendJson(response, 200, await addQrCode(body, request));
          return;
        }

        if (request.method === "DELETE" && pathname.startsWith("/api/dashboard/qrcodes/")) {
          if (routeInfo.clientApi) await requireClientSession(request);
          const qrCodeId = decodeURIComponent(pathname.split("/").pop());
          sendJson(response, 200, await deleteQrCode(qrCodeId, request));
          return;
        }

        await serveStatic(request, response);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message || "Server error" });
      }
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`Shelar TVS Reviews running at http://127.0.0.1:${port}`);
    });
}

function getPublicConfig(qrCodeId = "", client = "shelar-tvs") {
  const clientEnv = getEnvForClient(client);
  const qrCode = qrCodeId ? getQrCodeFromLocalDb(qrCodeId, client) : null;
  const branchId = qrCode?.branchId || clientEnv.BRANCH_ID || "main";
  return {
    businessName: clientEnv.APP_BUSINESS_NAME || (client === "eesweb" ? "EESWEB" : "Shelar TVS"),
    businessId: clientEnv.BUSINESS_ID || client,
    branchId,
    branchName: qrCode?.branchName || clientEnv.BRANCH_NAME || "Pune",
    qrCodeId: qrCode?.qrCodeId || qrCodeId || clientEnv.QR_CODE_ID || (client === "eesweb" ? "eesweb-test" : "shelar-tvs-main"),
    qrLabel: qrCode?.label || clientEnv.QR_CODE_LABEL || "Default QR",
    qrSource: qrCode?.source || qrCode?.staff || qrCode?.campaign || "",
    campaign: qrCode?.campaign || "",
    googlePlaceId: clientEnv.GOOGLE_PLACE_ID || "",
    reviewModel: clientEnv.GEMINI_MODEL || "gemini-3.1-flash-lite",
    reviewSystemPrompt:
      clientEnv.REVIEW_SYSTEM_PROMPT ||
      (client === "eesweb"
        ? "You write realistic customer review suggestions for Google Reviews. Output only one review, with no title, no bullets, no quotes, and no explanation. Sound like a genuine customer, not a marketer. Use simple natural language, specific but believable praise, and avoid overpromising. Avoid repeating the same phrase or idea in the same review. Do not mention AI, generated text, ratings, prompts, business strategy, or internal instructions. Do not use emojis, hashtags, excessive adjectives, or phrases like highly recommended more than once."
        : "You write realistic, natural Google reviews from real customers of Shelar TVS, a TVS two-wheeler showroom and service centre in Pune. Output only one review — no title, no bullets, no quotes, no explanation. Sound like a genuine local customer sharing a real purchase or service experience, not a marketing copy. Vary sentence structure every time. Weave in one or two search-relevant phrases naturally — such as Shelar TVS, TVS showroom Pune, Apache near me, Jupiter near me, TVS bike near me, best TVS deals Pune, TVS service Pune, genuine TVS parts — only if they fit the sentence. Never list keywords. Mention concrete touches: a friendly executive, a test ride, smooth EMI, on-time delivery, fair pricing, clean workshop. Do not use emojis, hashtags, AI/SEO mentions, incentive language, or the phrase highly recommended more than once."),
    reviewTopics: parseList(
      clientEnv.REVIEW_TOPICS,
      client === "eesweb"
        ? "Highly Responsive,Clear Communication,Patient & Helpful,Delivered on Time,Transparent Process,Attention to Detail,Exceeded Expectations,Great ROI,Stress-Free Experience"
        : "New Bike Purchase,New Scooter Purchase,Test Ride Experience,Best Price/Deal,Quick Delivery,Smooth Paperwork,Easy EMI Process,Helpful Staff,Knowledgeable Executive,Genuine Parts,Timely Service",
    ),
    feedbackTopics: parseList(
      clientEnv.FEEDBACK_TOPICS,
      client === "eesweb"
        ? "Ads Performance,Development Delay,Automation Glitch,AI Setup Concern,Support Response,Reporting Update"
        : "Service Delay,Long Wait for Delivery,Parts Issue,Hidden Charges,Staff Behavior,Test Ride Denied,Billing Problem,Insurance/Loan Issue,Lack of Information",
    ),
    aiTone: clientEnv.AI_TONE || "Enthusiastic",
    aiLength: clientEnv.AI_LENGTH || "medium",
  };
}

function getPublicConfigFromRequest(request) {
  const url = new URL(request.url, "http://localhost");
  const qrCodeId = url.searchParams.get("qr") || url.searchParams.get("qrCodeId") || "";
  const client = getClientFromRequest(request);
  const config = getPublicConfig(qrCodeId, client);
  const branchOverride = url.searchParams.get("branch");
  if (branchOverride && !getQrCodeFromLocalDb(qrCodeId, client)) {
    config.branchId = branchOverride;
  }
  return config;
}

function getDynamicQrUrl(qrCodeId = "", client = "shelar-tvs") {
  const publicConfig = getPublicConfig(qrCodeId, client);
  const clientEnv = getEnvForClient(client);
  const baseUrl = (clientEnv.APP_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  return `${baseUrl}/r/${encodeURIComponent(publicConfig.qrCodeId)}`;
}

function getDashboardSettings(request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  const origin = getRequestOrigin(request);
  const publicConfig = getPublicConfig("", client);
  return {
    settings: Object.fromEntries(
      [...editableSettings].map((key) => [key, clientEnv[key] || getEditableFallback(key, client)]),
    ),
    derived: {
      dynamicQrUrl: getDynamicQrUrl("", client),
      localDynamicQrUrl: `${origin}/r/${encodeURIComponent(publicConfig.qrCodeId)}`,
      reviewPageUrl: `${origin}${getReviewPageUrl(publicConfig.qrCodeId, client)}`,
      hasFirebaseCredentials: Boolean(clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY),
      firebaseStatus: firebaseDiagnostics.status,
      firebaseError: firebaseDiagnostics.error,
      clientMode: clientEnv.CLIENT_MODE === "true" || clientEnv.CLIENT_MODE === "1",
    },
  };
}

async function updateDashboardSettings(body, request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  const updates = body?.settings || {};
  const cleanUpdates = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!editableSettings.has(key)) {
      continue;
    }
    cleanUpdates[key] = normalizeSettingValue(key, value);
  }

  if (!Object.keys(cleanUpdates).length) {
    throw new Error("No editable settings were provided.");
  }

  const envPath = client === "eesweb" ? path.join(rootDir, "..", ".env") : path.join(rootDir, ".env");
  updateEnvFile(envPath, cleanUpdates);
  if (client === "shelar-tvs") {
    Object.assign(env, cleanUpdates);
  }

  const dashboardSettings = getDashboardSettings(request);
  return {
    ok: true,
    savedAt: new Date().toISOString(),
    settings: dashboardSettings.settings,
    derived: dashboardSettings.derived,
  };
}

function getEditableFallback(key, client = "shelar-tvs") {
  const fallbacks = {
    APP_BUSINESS_NAME: client === "eesweb" ? "EESWEB" : "Shelar TVS",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    BUSINESS_ID: client,
    BRANCH_ID: "main",
    BRANCH_NAME: "Pune",
    QR_CODE_ID: client === "eesweb" ? "eesweb-test" : "shelar-tvs-main",
    QR_CODE_LABEL: client === "eesweb" ? "EESWEB Test QR" : "Shelar TVS Main QR",
    GOOGLE_PLACE_ID: "",
    REVIEW_TOPICS: client === "eesweb"
      ? "Highly Responsive,Clear Communication,Patient & Helpful,Delivered on Time,Transparent Process,Attention to Detail,Exceeded Expectations,Great ROI,Stress-Free Experience"
      : "New Bike Purchase,New Scooter Purchase,Test Ride Experience,Best Price/Deal,Quick Delivery,Smooth Paperwork,Easy EMI Process,Helpful Staff,Knowledgeable Executive,Genuine Parts,Timely Service",
    FEEDBACK_TOPICS: client === "eesweb"
      ? "Ads Performance,Development Delay,Automation Glitch,AI Setup Concern,Support Response,Reporting Update"
      : "Service Delay,Long Wait for Delivery,Parts Issue,Hidden Charges,Staff Behavior,Test Ride Denied,Billing Problem,Insurance/Loan Issue,Lack of Information",
    GEMINI_MODEL: "gemini-3.1-flash-lite",
    REVIEW_SYSTEM_PROMPT: getPublicConfig("", client).reviewSystemPrompt,
    AI_TONE: "Enthusiastic",
    AI_LENGTH: "medium",
  };
  return fallbacks[key] || "";
}

function normalizeSettingValue(key, value) {
  if (key === "REVIEW_TOPICS" || key === "FEEDBACK_TOPICS") {
    return parseList(value, "")
      .slice(0, 12)
      .join(",");
  }

  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function updateEnvFile(filePath, updates) {
  const currentContents = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const rawJsonIndex = currentContents.search(/^\s*\{/m);
  const envContents = rawJsonIndex >= 0 ? currentContents.slice(0, rawJsonIndex) : currentContents;
  const rawJsonSuffix = rawJsonIndex >= 0 ? currentContents.slice(rawJsonIndex).trimEnd() : "";
  const seenKeys = new Set();
  const updatedLines = envContents.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*([A-Z0-9_]+)\s*=)(.*)$/);
    if (!match || !(match[2] in updates)) {
      return line;
    }

    seenKeys.add(match[2]);
    return `${match[2]}=${formatEnvValue(updates[match[2]])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seenKeys.has(key)) {
      updatedLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  const compactEnv = `${updatedLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  const nextContents = rawJsonSuffix ? `${compactEnv}\n${rawJsonSuffix}\n` : compactEnv;
  fs.writeFileSync(filePath, nextContents, "utf8");
}

function formatEnvValue(value) {
  return JSON.stringify(String(value || ""));
}

function getRequestOrigin(request) {
  const host = request.headers?.host || `127.0.0.1:${port}`;
  return `http://${host}`;
}

function getReviewPageUrl(qrCodeId, client = "shelar-tvs") {
  const publicConfig = getPublicConfig(qrCodeId, client);
  const params = new URLSearchParams({
    business: publicConfig.businessId,
    branch: publicConfig.branchId,
    qr: qrCodeId || publicConfig.qrCodeId,
  });
  if (publicConfig.qrSource) {
    params.set("source", publicConfig.qrSource);
  }
  if (publicConfig.campaign) {
    params.set("campaign", publicConfig.campaign);
  }
  return `${getClientBasePath(client)}/?${params}`;
}

function handleDynamicQrRedirect(request, response) {
  const qrCodeId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.replace(/^\/r\//, ""));
  const client = getClientFromRequest(request);
  try {
    trackQrScan(qrCodeId, request);
  } catch (error) {
    console.warn("Scan tracking error:", error.message);
  }
  response.writeHead(302, {
    Location: getReviewPageUrl(qrCodeId, client),
    "Cache-Control": "no-store",
  });
  response.end();
}

async function handleEvent(body, request) {
  if (!body || !allowedCollections.has(body.collection)) {
    throw new Error("Invalid collection.");
  }

  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);

  const requestedQrCodeId = body.payload?.qrCodeId || "";
  const publicConfig = getPublicConfig(requestedQrCodeId, client);
  const qrCode = getQrCodeFromLocalDb(requestedQrCodeId || publicConfig.qrCodeId, client);
  const payload = {
    ...body.payload,
    type: body.type,
    businessId: body.payload?.businessId || publicConfig.businessId,
    branchId: body.payload?.branchId || qrCode?.branchId || publicConfig.branchId,
    branchName: body.payload?.branchName || qrCode?.branchName || publicConfig.branchName,
    qrCodeId: requestedQrCodeId || publicConfig.qrCodeId,
    qrLabel: body.payload?.qrLabel || qrCode?.label || publicConfig.qrLabel,
    source: body.payload?.source || qrCode?.source || qrCode?.staff || publicConfig.qrSource || "",
    campaign: body.payload?.campaign || qrCode?.campaign || publicConfig.campaign || "",
    status: body.collection === "feedback" ? body.payload?.status || "pending" : body.payload?.status,
    userAgent: body.userAgent || "",
    createdAt: new Date().toISOString(),
  };

  let documentPath = "";
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    try {
      const document = await createFirestoreDocument(body.collection, payload, client);
      documentPath = document.name;
    } catch (error) {
      console.warn("Firestore event save failed, using local fallback:", error.message);
    }
  }

  const localPath = saveToLocalJson(body.collection, payload, client);
  documentPath = documentPath || localPath;
  return { ok: true, path: documentPath };
}

async function handleReviewGenerate(body, request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  if (client === "eesweb") {
    return handleOpenRouterReviewGenerate(body, clientEnv, client);
  }

  const apiKey = String(clientEnv.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("PASTE_") || apiKey === "your_gemini_api_key") {
    throw new Error("Gemini API key is not configured.");
  }

  const qrCodeId = String(body?.qrCodeId || "").trim();
  const publicConfig = getPublicConfig(qrCodeId, client);
  const mode = normalizeReviewMode(body?.mode);
  const attempt = Number(body?.attempt || 0);
  const tone = resolveShelarReviewTone(body?.tone, publicConfig.aiTone, attempt);
  const topics = parseList(body?.topics || "", "").slice(0, 4);
  const staff = sanitizeStaffName(body?.staff);
  const vehicleModel = sanitizeVehicleModel(body?.vehicleModel);
  const recentReviews = Array.isArray(body?.recentReviews)
    ? body.recentReviews.map((review) => String(review || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  if (!topics.length) {
    return {
      review: buildSafeGenericShelarReview({
        businessName: publicConfig.businessName,
        mode,
        tone,
        attempt,
        recentReviews,
      }),
    };
  }
  const prompt = buildGeminiReviewPrompt({
    businessName: publicConfig.businessName,
    mode,
    tone,
    topics,
    staff,
    vehicleModel,
    rating: Number(body?.rating || 5),
    attempt,
    recentReviews,
    systemPrompt: publicConfig.reviewSystemPrompt,
  });

  const model = encodeURIComponent(clientEnv.GEMINI_MODEL || "gemini-3.1-flash-lite");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: publicConfig.reviewSystemPrompt }],
      },
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: mode === "short" ? 0.85 : 0.95,
        topP: 0.9,
        maxOutputTokens: mode === "long" ? 140 : mode === "medium" ? 80 : 45,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "Gemini request failed.");
  }

  const review = extractGeminiText(data);
  if (!review) {
    throw new Error("Gemini returned an empty review.");
  }

  return { review };
}

async function handleOpenRouterReviewGenerate(body, clientEnv, client = "eesweb") {
  const apiKey = String(clientEnv.OPENROUTER_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("PASTE_") || apiKey === "your_openrouter_api_key") {
    throw new Error("OpenRouter API key is not configured.");
  }

  const qrCodeId = String(body?.qrCodeId || "").trim();
  const publicConfig = getPublicConfig(qrCodeId, client);
  const mode = normalizeReviewMode(body?.mode);
  const tone = normalizeReviewTone(body?.tone || publicConfig.aiTone);
  const topics = parseList(body?.topics || "", "").slice(0, 4);
  const recentReviews = Array.isArray(body?.recentReviews)
    ? body.recentReviews.map((review) => String(review || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  const prompt = buildOpenRouterReviewPrompt({
    businessName: publicConfig.businessName,
    mode,
    tone,
    topics,
    rating: Number(body?.rating || 5),
    attempt: Number(body?.attempt || 0),
    recentReviews,
    systemPrompt: publicConfig.reviewSystemPrompt,
  });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": clientEnv.APP_BASE_URL || `http://127.0.0.1:${port}`,
      "X-Title": clientEnv.APP_NAME || "Review Funnel",
    },
    body: JSON.stringify({
      model: clientEnv.OPENROUTER_MODEL || "meta-llama/llama-3.2-1b-instruct",
      messages: [
        { role: "system", content: publicConfig.reviewSystemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: mode === "short" ? 0.85 : 0.95,
      top_p: 0.9,
      max_tokens: mode === "long" ? 140 : mode === "medium" ? 80 : 45,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenRouter request failed.");
  }

  const review = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!review) {
    throw new Error("OpenRouter returned an empty review.");
  }

  return { review };
}

function sanitizeStaffName(value) {
  return String(value || "")
    .replace(/[^\p{L}\s.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function sanitizeVehicleModel(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s.'+/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

// Maps each UI topic label to a plain-English experience description the LLM
// can weave into a review naturally, plus optional SEO keyword hints.
const TOPIC_EXPERIENCE_MAP = {
  "New Bike Purchase": {
    experience: "buying a new bike",
    keywords: ["TVS bike near me", "Apache near me"],
  },
  "New Scooter Purchase": {
    experience: "buying a new scooter",
    keywords: ["Jupiter near me", "TVS scooter Pune"],
  },
  "Test Ride Experience": {
    experience: "going for a test ride before buying",
    keywords: ["TVS showroom Pune", "TVS test ride Pune"],
  },
  "Best Price/Deal": {
    experience: "getting a great price without any haggling",
    keywords: ["best TVS deals Pune", "TVS offers Pune"],
  },
  "Quick Delivery": {
    experience: "receiving the vehicle faster than expected",
    keywords: ["Shelar TVS"],
  },
  "Smooth Paperwork": {
    experience: "completing all the paperwork quickly and without hassle",
    keywords: ["Shelar TVS"],
  },
  "Easy EMI Process": {
    experience: "setting up EMI easily with no confusing steps",
    keywords: ["Shelar TVS"],
  },
  "Helpful Staff": {
    experience: "being guided by genuinely helpful staff throughout",
    keywords: ["Shelar TVS"],
  },
  "Knowledgeable Executive": {
    experience: "working with a sales executive who really knew every detail about the bikes",
    keywords: ["TVS showroom Pune"],
  },
  "Genuine Parts": {
    experience: "getting only genuine OEM parts used during service",
    keywords: ["genuine TVS parts", "TVS service Pune"],
  },
  "Timely Service": {
    experience: "having the service completed exactly on time",
    keywords: ["TVS service Pune", "TVS bike service Pune"],
  },
};

function extractGeminiText(data) {
  return String(
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || "",
  ).trim();
}

function buildGeminiReviewPrompt({ businessName, mode, tone, topics, staff, vehicleModel, rating, attempt, recentReviews, systemPrompt }) {
  const toneInstructions = {
    Professional: "Calm, polished, and credible, like a satisfied regular customer.",
    Enthusiastic: "Warm, friendly, and genuinely happy, without sounding exaggerated or fake.",
    Appreciative: "Grateful and thoughtful, naturally thanking the team for the experience.",
  };
  const lengthInstructions = {
    short: "Exactly 1 complete sentence, 50 to 105 characters.",
    medium: "1 to 2 complete short sentences, 105 to 185 characters total.",
    long: "One polished paragraph of 3 to 4 complete sentences, 220 to 450 characters.",
  };

  // Translate topic labels → human experiences + collect SEO keywords
  const experiences = [];
  const rawKeywords = [];
  for (const topic of topics) {
    const mapping = TOPIC_EXPERIENCE_MAP[topic];
    if (mapping) {
      experiences.push(mapping.experience);
      rawKeywords.push(...mapping.keywords);
    } else {
      // Unknown / custom topic: pass through as-is so nothing is silently lost
      experiences.push(topic.toLowerCase());
    }
  }

  // Deduplicate keywords and cap at 3 so the LLM isn't overwhelmed
  const seoKeywords = [...new Set(rawKeywords)].slice(0, 3);

  const topicInstructions = experiences.length
    ? `The customer had a positive experience with the following: ${experiences.join("; ")}. Write naturally about what they felt or experienced - describe the outcome, not a label. Do not use these as literal phrases.`
    : "No specific aspects were selected, so keep the review general. Do not invent specific service outcomes, staff behavior, pricing claims, EMI help, delivery speed, test rides, paperwork details, or service timelines.";

  const keywordInstruction = seoKeywords.length
    ? `If one or two of these phrases fit naturally into the review, you may use them exactly as written: ${seoKeywords.join(", ")}. Never list them or force them in.`
    : "";

  const staffInstruction = staff
    ? `The customer was helped by a staff member named ${staff}. Mention ${staff} once, naturally, as the person who helped them. Do not invent a surname or title.`
    : "";
  const vehicleInstruction = vehicleModel
    ? `The purchased vehicle model was ${vehicleModel}. Mention this exact model once, naturally.`
    : "";
  const specificityGuard = [
    !topics.length ? "Because no options were selected, keep the experience broad and believable rather than detailed." : "",
    !staff ? "Do not mention any staff member by name." : "",
    !vehicleModel ? "Do not mention a specific bike or scooter model." : "",
    !topics.length ? "Do not assume this was a bike service, scooter service, purchase, delivery, test ride, EMI conversation, or paperwork-heavy visit unless the user selections clearly imply that." : "",
    !topics.length ? "When nothing is selected, describe only the overall feeling of the visit. Do not mention a clean workshop, showroom visit, servicing, repair quality, delivery timing, billing, offers, paperwork, parts, or model choice." : "",
    !topics.length ? "Avoid framing it as the best place, best showroom, or best service center unless a selected topic clearly supports that claim." : "",
  ].filter(Boolean).join(" ");
  const variationLane = getReviewVariationLane(attempt, businessName);

  const recentOpenings = recentReviews
    .map((review) => review.split(/[.!?]/)[0])
    .filter(Boolean)
    .slice(0, 6);
  const overusedWords = getOverusedReviewWords(recentReviews);
  const varietyGuard = overusedWords.length
    ? `Avoid leaning on these overused words from recent suggestions unless absolutely necessary: ${overusedWords.join(", ")}.`
    : "";

  return [
    systemPrompt,
    "",
    `Write one Google review for ${businessName}.`,
    `Rating context: ${Number.isFinite(rating) ? rating : 5} out of 5.`,
    `Tone: ${tone}. ${toneInstructions[tone] || toneInstructions.Professional}`,
    `Length: ${lengthInstructions[mode] || lengthInstructions.medium}`,
    topicInstructions,
    keywordInstruction,
    staffInstruction,
    vehicleInstruction,
    specificityGuard,
    variationLane,
    "The review must sound like a real customer voluntarily describing a genuine experience.",
    "Avoid AI-like templates, repeated openings, generic marketing copy, exaggerated claims, and policy-risky wording.",
    "Do not mention AI, prompts, generated text, incentives, ratings, or internal instructions.",
    "Do not use emojis, hashtags, titles, bullet points, or quotes.",
    "Do not copy any sentence shape from recent suggestions.",
    varietyGuard,
    recentOpenings.length ? `Do not start like these recent openings:\n- ${recentOpenings.join("\n- ")}` : "",
    recentReviews.length ? `Do not sound like these recent suggestions:\n- ${recentReviews.join("\n- ")}` : "",
    "Output only the final review text.",
  ].filter(Boolean).join("\n");
}

function buildOpenRouterReviewPrompt({ businessName, mode, tone, topics, rating, attempt, recentReviews, systemPrompt }) {
  const toneInstructions = {
    Professional: "Measured, professional B2B tone. Practical, competent, and credible.",
    Enthusiastic: "Warm, energetic, and positive without sounding exaggerated or fake.",
    Appreciative: "Grateful and thoughtful, but still natural and business-relevant.",
  };
  const lengthInstructions = {
    short: "Exactly 1 complete sentence, 50 to 105 characters.",
    medium: "1 to 2 complete short sentences, 105 to 185 characters total.",
    long: "One polished paragraph of 3 to 4 complete sentences, 220 to 450 characters.",
  };
  const topicInstructions = topics.length
    ? `Selected customer-liked aspects: ${topics.join(", ")}. Treat these as ideas, not exact words to force into the review.`
    : "No specific aspects were selected, so keep the review general. Do not invent specific service outcomes, delivery claims, pricing details, support stories, or named team members.";
  const specificityGuard = topics.length
    ? ""
    : "Because no options were selected, keep the experience broad and believable rather than detailed. Do not assume this was a service visit, vehicle purchase, delivery, pricing discussion, or EMI conversation.";
  const recentOpenings = recentReviews
    .map((review) => review.split(/[.!?]/)[0])
    .filter(Boolean)
    .slice(0, 6);
  const overusedWords = getOverusedReviewWords(recentReviews);
  const varietyGuard = overusedWords.length
    ? `Avoid leaning on these overused words from recent suggestions unless absolutely necessary: ${overusedWords.join(", ")}.`
    : "";
  const variationLane = getReviewVariationLane(attempt, businessName);

  return [
    systemPrompt,
    "",
    `Write one Google review for ${businessName}.`,
    `Rating context: ${Number.isFinite(rating) ? rating : 5} out of 5.`,
    `Tone: ${tone}. ${toneInstructions[tone] || toneInstructions.Professional}`,
    `Length: ${lengthInstructions[mode] || lengthInstructions.medium}`,
    topicInstructions,
    specificityGuard,
    variationLane,
    "The review must sound like a real customer voluntarily describing a genuine experience.",
    "Avoid AI-like templates, repeated openings, generic marketing copy, exaggerated claims, and policy-risky wording.",
    "Do not mention AI, prompts, generated text, incentives, ratings, or internal instructions.",
    "Do not use emojis, hashtags, titles, bullet points, or quotes.",
    "Do not copy any sentence shape from recent suggestions.",
    varietyGuard,
    recentOpenings.length ? `Do not start like these recent openings:\n- ${recentOpenings.join("\n- ")}` : "",
    recentReviews.length ? `Do not sound like these recent suggestions:\n- ${recentReviews.join("\n- ")}` : "",
    "Output only the final review text.",
  ].filter(Boolean).join("\n");
}

function getReviewVariationLane(attempt = 0, businessName = "the business") {
  const lanes = [
    `Use a fresh opening that focuses on the overall visit rather than a specific feature. Do not begin with "I had a great experience" or "I recently used ${businessName}".`,
    "Use a customer voice that highlights how easy and comfortable the experience felt. Keep the wording natural and avoid dramatic praise.",
    "Center the review on trust and professionalism. Use different sentence rhythm from typical testimonial copy.",
    "Write it like a quick recommendation to a friend. Keep it believable, specific enough to feel real, and avoid formulaic enthusiasm.",
    "Focus on the smoothness of the experience without using the words smooth and hassle-free together.",
    "Start from what stood out emotionally or practically, not from a generic summary sentence.",
  ];
  return lanes[Math.abs(Number(attempt || 0)) % lanes.length];
}

function getOverusedReviewWords(recentReviews) {
  const trackedWords = [
    "pleasant",
    "smooth",
    "professional",
    "welcoming",
    "comfortable",
    "friendly",
    "helpful",
    "great",
    "easy",
    "reliable",
  ];
  const counts = new Map();
  for (const review of recentReviews || []) {
    const normalized = String(review || "").toLowerCase();
    for (const word of trackedWords) {
      if (normalized.includes(word)) {
        counts.set(word, (counts.get(word) || 0) + 1);
      }
    }
  }
  return trackedWords.filter((word) => (counts.get(word) || 0) >= 2).slice(0, 5);
}

function buildSafeGenericShelarReview({ businessName, mode, tone, attempt = 0, recentReviews = [] }) {
  const safeOpenersByTone = {
    Professional: [
      `My visit to ${businessName} felt straightforward and well managed.`,
      `${businessName} gave me a clear and comfortable experience overall.`,
      `The overall experience at ${businessName} felt well handled.`,
      `My time at ${businessName} felt easy to follow and professionally managed.`,
    ],
    Enthusiastic: [
      `I had a really good experience at ${businessName}.`,
      `Visiting ${businessName} turned out to be a very positive experience.`,
      `My time at ${businessName} felt easy and pleasant overall.`,
      `I came away from ${businessName} with a genuinely positive impression.`,
    ],
    Appreciative: [
      `I appreciated how easy the experience at ${businessName} felt.`,
      `${businessName} made the whole visit feel calm and comfortable.`,
      `I was happy with how smoothly my visit to ${businessName} went.`,
      `The overall experience at ${businessName} felt thoughtful and easy.`,
    ],
  };

  const safeClosersByTone = {
    Professional: [
      "The team kept things clear and made the visit feel comfortable from beginning to end.",
      "Everything felt organized, and the team handled the visit with a steady approach.",
      "The process felt simple to follow, and the team made the experience easy overall.",
      "It felt like a place that takes customer experience seriously without overcomplicating things.",
    ],
    Enthusiastic: [
      "The team made the whole visit feel easy, and I left with a very positive impression.",
      "Everything felt comfortable and easy to follow, which made the visit stand out in a good way.",
      "The team kept the experience relaxed and approachable, and that made a real difference.",
      "It was the kind of visit that leaves you feeling good about how everything was handled.",
    ],
    Appreciative: [
      "The team made the experience feel easy to trust and comfortable all the way through.",
      "I appreciated how naturally the whole visit came together without feeling complicated.",
      "There was a calm and considerate feel to the visit that made it easy to appreciate.",
      "The visit felt comfortable and thoughtfully handled in a way that customers notice.",
    ],
  };

  const connectiveLines = [
    "There was a nice sense of clarity throughout the visit.",
    "The whole experience felt easy to follow from the moment I arrived.",
    "It was a comfortable visit without anything feeling awkward or confusing.",
    "The atmosphere stayed easygoing and the experience never felt complicated.",
  ];

  const normalizedTone = normalizeReviewTone(tone);
  const openers = safeOpenersByTone[normalizedTone] || safeOpenersByTone.Enthusiastic;
  const closers = safeClosersByTone[normalizedTone] || safeClosersByTone.Enthusiastic;
  const opening = pickDistinctReviewLine(openers, attempt, recentReviews, 0);
  const closer = pickDistinctReviewLine(closers, attempt, recentReviews, 1);
  const connector = mode === "long" ? pickDistinctReviewLine(connectiveLines, attempt, recentReviews, 2) : "";

  const parts = [opening];
  if (connector) parts.push(connector);
  if (mode !== "short") parts.push(closer);

  return trimGeneratedReviewToMode(parts.join(" "), mode);
}

function pickDistinctReviewLine(options, attempt, recentReviews, salt = 0) {
  const normalizedRecent = (recentReviews || []).map((review) => String(review || "").toLowerCase());
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (Math.abs(Number(attempt || 0)) + offset + salt) % options.length;
    const candidate = options[index];
    const candidateLower = candidate.toLowerCase();
    const isUsed = normalizedRecent.some((review) => review.includes(candidateLower.slice(0, Math.min(candidateLower.length, 40))));
    if (!isUsed) {
      return candidate;
    }
  }
  return options[(Math.abs(Number(attempt || 0)) + salt) % options.length];
}

function trimGeneratedReviewToMode(review, mode) {
  const clean = String(review || "").replace(/\s+/g, " ").trim();
  const limits = {
    short: 110,
    medium: 185,
    long: 450,
  };
  const limit = limits[mode] || limits.medium;
  if (clean.length <= limit) {
    return clean;
  }
  const trimmed = clean.slice(0, limit - 1).replace(/\s+\S*$/, "").replace(/[,.!?;:]+$/, "");
  return `${trimmed}.`;
}

function normalizeReviewMode(mode) {
  return ["short", "medium", "long"].includes(mode) ? mode : "medium";
}

function normalizeReviewTone(tone) {
  return ["Professional", "Enthusiastic", "Appreciative"].includes(tone) ? tone : "Professional";
}

function resolveShelarReviewTone(requestedTone, configuredTone, attempt = 0) {
  if (requestedTone) {
    return normalizeReviewTone(requestedTone);
  }

  const cycle = ["Professional", "Enthusiastic", "Appreciative"];
  const baseTone = ["Professional", "Enthusiastic", "Appreciative"].includes(configuredTone)
    ? configuredTone
    : "Enthusiastic";
  const ordered = [baseTone, ...cycle.filter((tone) => tone !== baseTone)];
  return ordered[Math.abs(Number(attempt || 0)) % ordered.length];
}

async function bootstrapFirestore() {
  const publicConfig = getPublicConfig();
  await setFirestoreDocument(`businesses/${publicConfig.businessId}`, {
    name: publicConfig.businessName,
    googlePlaceId: publicConfig.googlePlaceId,
    status: "active",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  await setFirestoreDocument(`branches/${publicConfig.branchId}`, {
    businessId: publicConfig.businessId,
    name: env.BRANCH_NAME || "Main",
    status: "active",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  await setFirestoreDocument(`qrCodes/${publicConfig.qrCodeId}`, {
    businessId: publicConfig.businessId,
    branchId: publicConfig.branchId,
    label: env.QR_CODE_LABEL || "Default QR",
    dynamicUrl: getDynamicQrUrl(),
    targetPath: getReviewPageUrl(publicConfig.qrCodeId),
    status: "active",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

async function bootstrapPersistentStorage() {
  ensureLocalBaseDocuments();
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    await bootstrapFirestore();
  }
}

async function createFirestoreDocument(collection, data, client = "shelar-tvs") {
  const clientEnv = getEnvForClient(client);
  const projectId = clientEnv.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error(`Missing FIREBASE_PROJECT_ID in .env`);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(collection, client)}`;
  return firestoreRequest(url, "POST", toFirestoreDocument(data), client);
}

async function setFirestoreDocument(documentPath, data, client = "shelar-tvs") {
  const clientEnv = getEnvForClient(client);
  const projectId = clientEnv.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error(`Missing FIREBASE_PROJECT_ID in .env`);
  const fieldPaths = Object.keys(data)
    .filter((key) => data[key] !== undefined)
    .map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join("&");
  const suffix = fieldPaths ? `?${fieldPaths}` : "";
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(documentPath, client)}${suffix}`;
  return firestoreRequest(url, "PATCH", toFirestoreDocument(data), client);
}

async function firestoreRequest(url, method, body, client = "shelar-tvs") {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken(client)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    firebaseDiagnostics.status = "error";
    firebaseDiagnostics.error = data.error?.message || "Firestore request failed.";
    throw new Error(firebaseDiagnostics.error);
  }
  firebaseDiagnostics.status = "connected";
  firebaseDiagnostics.error = "";
  return data;
}

async function getAccessToken(client = "shelar-tvs") {
  if (accessTokenCache.token && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.token;
  }

  const clientEnv = getEnvForClient(client);
  const clientEmail = clientEnv.FIREBASE_CLIENT_EMAIL;
  const privateKey = clientEnv.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error("Missing Firebase credentials in .env");
  }

  const now = Math.floor(Date.now() / 1000);
  const unsignedJwt = [
    base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64Url(
      JSON.stringify({
        iss: clientEmail,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join(".");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(normalizePrivateKey(privateKey));
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    firebaseDiagnostics.status = "error";
    firebaseDiagnostics.error = data.error_description || data.error || "Failed to get Firebase access token.";
    throw new Error(firebaseDiagnostics.error);
  }

  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  firebaseDiagnostics.status = "connected";
  firebaseDiagnostics.error = "";
  return accessTokenCache.token;
}

function toFirestoreDocument(data) {
  return {
    fields: Object.fromEntries(
      Object.entries(data)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, toFirestoreValue(value)]),
    ),
  };
}

function toFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value)
            .filter(([, nestedValue]) => nestedValue !== undefined)
            .map(([key, nestedValue]) => [key, toFirestoreValue(nestedValue)]),
        ),
      },
    };
  }
  return { stringValue: String(value) };
}

async function serveStatic(request, response) {
  const requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (requestedPath.includes("data_store.json") || requestedPath.includes(".env") || requestedPath.includes(".git")) {
    sendText(response, 403, "Forbidden");
    return;
  }
  
  let targetRootDir = rootDir;
  let safePath = requestedPath === "/" ? "/admin.html" : requestedPath;
  
  if (safePath === "/eesweb") {
    response.writeHead(302, { Location: "/eesweb/" });
    response.end();
    return;
  }

  if (safePath === "/shelar") {
    response.writeHead(302, { Location: "/shelar/" });
    response.end();
    return;
  }

  if (safePath === "/dashboard.html") {
    response.writeHead(302, { Location: "/shelar/dashboard.html" });
    response.end();
    return;
  }

  if (safePath === "/login.html") {
    response.writeHead(302, { Location: "/shelar/login.html" });
    response.end();
    return;
  }

  if (safePath === "/reset-password.html") {
    response.writeHead(302, { Location: "/shelar/reset-password.html" });
    response.end();
    return;
  }

  if (safePath === "/eesweb/dashboard.html") {
    const session = await getActiveSession(request);
    if (!session) {
      response.writeHead(302, { Location: "/eesweb/login.html" });
      response.end();
      return;
    }
  }

  if (safePath === "/shelar/dashboard.html") {
    const session = await getActiveSession(request);
    if (!session) {
      response.writeHead(302, { Location: "/shelar/login.html" });
      response.end();
      return;
    }
  }
  
  if (safePath.startsWith("/eesweb/")) {
    targetRootDir = path.join(rootDir, "..");
    safePath = safePath.slice(7); // Remove "/eesweb"
    if (safePath === "/" || safePath === "") {
      safePath = "/index.html";
    }
  } else if (safePath.startsWith("/shelar/")) {
    safePath = safePath.slice(7);
    if (safePath === "/" || safePath === "") {
      safePath = "/index.html";
    }
  }

  const filePath = path.normalize(path.join(targetRootDir, safePath));
  if (!filePath.startsWith(targetRootDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(response, 404, "Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": getContentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 1_000_000) reject(new Error("Request body too large."));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(rawBody || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const fileContents = fs.readFileSync(filePath, "utf8");
  const rawJsonIndex = fileContents.search(/^\s*\{/m);
  const envContents = rawJsonIndex >= 0 ? fileContents.slice(0, rawJsonIndex) : fileContents;
  const rawJson = rawJsonIndex >= 0 ? fileContents.slice(rawJsonIndex).trim() : "";
  const parsedEnv = Object.fromEntries(
    envContents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const equalsIndex = line.indexOf("=");
        const key = line.slice(0, equalsIndex).trim();
        const rawValue = line.slice(equalsIndex + 1).trim();
        return [key, rawValue.replace(/^["']|["']$/g, "")];
      }),
  );

  const serviceAccount = parseServiceAccountJson(parsedEnv.FIREBASE_SERVICE_ACCOUNT_JSON || rawJson);
  if (serviceAccount) {
    if (isMissingEnvValue(parsedEnv.FIREBASE_PROJECT_ID)) {
      parsedEnv.FIREBASE_PROJECT_ID = serviceAccount.project_id;
    }
    if (isMissingEnvValue(parsedEnv.FIREBASE_CLIENT_EMAIL)) {
      parsedEnv.FIREBASE_CLIENT_EMAIL = serviceAccount.client_email;
    }
    if (isMissingEnvValue(parsedEnv.FIREBASE_PRIVATE_KEY)) {
      parsedEnv.FIREBASE_PRIVATE_KEY = serviceAccount.private_key;
    }
  }

  return parsedEnv;
}

function getNonEmptyProcessEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => String(value || "").trim() !== ""),
  );
}

function isMissingEnvValue(value) {
  return !value || value.startsWith("PASTE_") || value.includes("PASTE_PRIVATE_KEY");
}

function parseServiceAccountJson(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value.replace(/^["']|["']$/g, ""));
    if (parsed.type !== "service_account") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseList(value, fallback) {
  return String(value || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireEnv(name) {
  if (!env[name]) throw new Error(`Missing ${name} in .env`);
  return env[name];
}

function normalizePrivateKey(value) {
  return value.replace(/\\n/g, "\n");
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }[extension] || "application/octet-stream"
  );
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function getAuthSessionResponse(request) {
  const session = await getActiveSession(request);
  if (!session) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    session: {
      email: session.email,
      client: session.client,
      expiresAt: session.expiresAt,
    },
  };
}

async function requireClientSession(request) {
  const session = await getActiveSession(request);
  if (!session) {
    const error = new Error("Authentication required.");
    error.statusCode = 401;
    throw error;
  }
  return session;
}

async function handleLogin(body, request, response) {
  const client = getClientFromRequest(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || "");
  if (!email || !password) {
    const error = new Error("Email and password are required.");
    error.statusCode = 400;
    throw error;
  }

  const user = await getAuthUserByEmail(email, client);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    const error = new Error("Incorrect email or password.");
    error.statusCode = 401;
    throw error;
  }

  const session = {
    id: `session_${createToken(12)}`,
    client,
    email: user.email,
    userId: user.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  };
  await saveSession(session, client);

  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": serializeCookie(getSessionCookieName(client), session.id, {
      path: getClientBasePath(client),
      maxAge: 60 * 60 * 24 * 7,
      httpOnly: true,
      sameSite: "Lax",
    }),
  });
  response.end(JSON.stringify({ ok: true, client, email: user.email }));
}

async function handleLogout(request, response) {
  const client = getClientFromRequest(request);
  const sessionId = readCookie(request, getSessionCookieName(client));
  if (sessionId) {
    await invalidateSession(sessionId, client);
  }

  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": serializeCookie(getSessionCookieName(client), "", {
      path: getClientBasePath(client),
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
    }),
  });
  response.end(JSON.stringify({ ok: true }));
}

async function handleForgotPassword(body, request) {
  const client = getClientFromRequest(request);
  const email = normalizeEmail(body?.email);
  if (!email) {
    const error = new Error("Email is required.");
    error.statusCode = 400;
    throw error;
  }

  const user = await getAuthUserByEmail(email, client);
  if (!user) {
    return { ok: true };
  }

  const token = createToken(24);
  const resetUrl = buildResetUrl(request, client, token);
  await saveResetToken({
    id: token,
    email,
    userId: user.id,
    client,
    expiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
    createdAt: new Date().toISOString(),
  }, client);

  const emailResult = await sendPasswordResetEmail({
    to: email,
    resetUrl,
    client,
  });

  return emailResult?.debugResetUrl ? { ok: true, debugResetUrl: emailResult.debugResetUrl } : { ok: true };
}

async function handleResetPassword(body, request) {
  const client = getClientFromRequest(request);
  const token = String(body?.token || "").trim();
  const password = String(body?.password || "");
  if (!token || !password) {
    const error = new Error("Reset token and password are required.");
    error.statusCode = 400;
    throw error;
  }

  const resetRecord = await getResetToken(token, client);
  if (!resetRecord || resetRecord.usedAt) {
    const error = new Error("Reset link is invalid.");
    error.statusCode = 400;
    throw error;
  }

  if (new Date(resetRecord.expiresAt).getTime() < Date.now()) {
    const error = new Error("Reset link has expired.");
    error.statusCode = 400;
    throw error;
  }

  const user = await getAuthUserByEmail(resetRecord.email, client);
  if (!user) {
    const error = new Error("This account no longer exists.");
    error.statusCode = 404;
    throw error;
  }

  user.passwordHash = await hashPassword(password);
  user.updatedAt = new Date().toISOString();
  await saveAuthUser(user, client);
  await markResetTokenUsed(token, client);
  return { ok: true };
}

async function getActiveSession(request) {
  const client = getClientFromRequest(request);
  const sessionId = readCookie(request, getSessionCookieName(client));
  if (!sessionId) return null;
  const session = await getSessionById(sessionId, client);
  if (!session || session.invalidatedAt) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await invalidateSession(sessionId, client);
    return null;
  }
  return session;
}

async function getAuthUserByEmail(email, client) {
  const key = getEmailDocKey(email);
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    return getFirestoreDocument(`clientUsers/${key}`, client);
  }
  return readAuthStore(client).users.find((item) => item.email === email) || null;
}

async function saveAuthUser(user, client) {
  const key = getEmailDocKey(user.email);
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    await setFirestoreDocument(`clientUsers/${key}`, user, client);
    return;
  }
  const store = readAuthStore(client);
  store.users = store.users.filter((item) => item.email !== user.email);
  store.users.push(user);
  writeAuthStore(store, client);
}

async function getSessionById(sessionId, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    return getFirestoreDocument(`clientSessions/${sessionId}`, client);
  }
  return readAuthStore(client).sessions.find((item) => item.id === sessionId) || null;
}

async function saveSession(session, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    await setFirestoreDocument(`clientSessions/${session.id}`, session, client);
    return;
  }
  const store = readAuthStore(client);
  store.sessions = store.sessions.filter((item) => item.id !== session.id);
  store.sessions.push(session);
  writeAuthStore(store, client);
}

async function invalidateSession(sessionId, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    await setFirestoreDocument(`clientSessions/${sessionId}`, {
      invalidatedAt: new Date().toISOString(),
    }, client);
    return;
  }
  const store = readAuthStore(client);
  const session = store.sessions.find((item) => item.id === sessionId);
  if (session) {
    session.invalidatedAt = new Date().toISOString();
    writeAuthStore(store, client);
  }
}

async function saveResetToken(record, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    await setFirestoreDocument(`passwordResetTokens/${record.id}`, record, client);
    return;
  }
  const store = readAuthStore(client);
  store.resetTokens = store.resetTokens.filter((item) => item.id !== record.id);
  store.resetTokens.push(record);
  writeAuthStore(store, client);
}

async function getResetToken(token, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    return getFirestoreDocument(`passwordResetTokens/${token}`, client);
  }
  return readAuthStore(client).resetTokens.find((item) => item.id === token) || null;
}

async function markResetTokenUsed(token, client) {
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    await setFirestoreDocument(`passwordResetTokens/${token}`, {
      usedAt: new Date().toISOString(),
    }, client);
    return;
  }
  const store = readAuthStore(client);
  const record = store.resetTokens.find((item) => item.id === token);
  if (record) {
    record.usedAt = new Date().toISOString();
    writeAuthStore(store, client);
  }
}

function getAuthStorePath(client) {
  return client === "eesweb"
    ? path.join(rootDir, "..", "auth_store.json")
    : path.join(rootDir, "auth_store.json");
}

function readAuthStore(client) {
  const filePath = getAuthStorePath(client);
  if (!fs.existsSync(filePath)) {
    return { users: [], sessions: [], resetTokens: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      users: parsed.users || [],
      sessions: parsed.sessions || [],
      resetTokens: parsed.resetTokens || [],
    };
  } catch {
    return { users: [], sessions: [], resetTokens: [] };
  }
}

function writeAuthStore(store, client) {
  fs.writeFileSync(getAuthStorePath(client), JSON.stringify(store, null, 2), "utf8");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getEmailDocKey(email) {
  return Buffer.from(normalizeEmail(email)).toString("base64url");
}

function createToken(size = 24) {
  return crypto.randomBytes(size).toString("hex");
}

function buildResetUrl(request, client, token) {
  const origin = getRequestOrigin(request);
  return `${origin}${getClientBasePath(client)}/reset-password.html?token=${encodeURIComponent(token)}`;
}

function getClientBasePath(client) {
  return client === "eesweb" ? "/eesweb" : "/shelar";
}

function getSessionCookieName(client) {
  return client === "eesweb" ? "rf_session_eesweb" : "rf_session_shelar";
}

function readCookie(request, name) {
  const cookies = String(request.headers?.cookie || "").split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    if (!cookie) continue;
    const index = cookie.indexOf("=");
    const key = index >= 0 ? cookie.slice(0, index) : cookie;
    if (key === name) {
      return decodeURIComponent(index >= 0 ? cookie.slice(index + 1) : "");
    }
  }
  return "";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, "review-funnel-auth", 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

async function verifyPassword(password, hash) {
  return (await hashPassword(password)) === hash;
}

async function sendPasswordResetEmail({ to, resetUrl, client }) {
  const clientEnv = getEnvForClient(client || "shelar-tvs");
  const brevoApiKey = String(clientEnv.BREVO_API_KEY || "").trim();
  const brevoFromEmail = String(clientEnv.BREVO_FROM_EMAIL || "").trim();
  const brandName = client === "eesweb" ? "EESWEB" : "Shelar TVS";
  const brevoFromName = String(clientEnv.BREVO_FROM_NAME || (client === "eesweb" ? "EESWEB" : "Ratify AI")).trim();

  if (brevoApiKey && brevoFromEmail) {
    const subject = `Reset your ${brandName} dashboard password`;
    const payload = {
      sender: {
        name: brevoFromName,
        email: brevoFromEmail,
      },
      to: [{ email: to }],
      subject,
      htmlContent: buildPasswordResetEmailHtml({
        brandName,
        subject,
        resetUrl,
      }),
      textContent: buildPasswordResetEmailText({
        brandName,
        resetUrl,
      }),
    };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": brevoApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || "Password reset email could not be sent.");
    }

    return { ok: true, id: data.messageId || "" };
  }

  const host = String(clientEnv.SMTP_HOST || "").trim();
  const user = String(clientEnv.SMTP_USER || "").trim();
  const pass = String(clientEnv.SMTP_PASS || "").trim();
  const fromEmail = String(clientEnv.SMTP_FROM_EMAIL || "").trim();

  if (!host || !user || !pass || !fromEmail) {
    return { ok: true, debugResetUrl: resetUrl, to };
  }

  const subject = `Reset your ${brandName} dashboard password`;
  await sendSmtpMail({
    host,
    port: Number(clientEnv.SMTP_PORT || 465),
    secure: String(clientEnv.SMTP_SECURE || "true") !== "false",
    user,
    pass,
    fromEmail,
    fromName: String(clientEnv.SMTP_FROM_NAME || brandName).trim(),
    to,
    subject,
    text: buildPasswordResetEmailText({
      brandName,
      resetUrl,
    }),
  });

  return { ok: true };
}

function buildPasswordResetEmailHtml({ brandName, subject, resetUrl }) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033">
      <h2 style="margin:0 0 16px">${escapeEmailHtml(subject)}</h2>
      <p style="margin:0 0 14px">We received a request to reset your ${escapeEmailHtml(brandName)} client dashboard password.</p>
      <p style="margin:0 0 22px">
        <a href="${escapeEmailAttribute(resetUrl)}" style="display:inline-block;background:#123d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Reset password</a>
      </p>
      <p style="margin:0 0 10px">If the button does not open, use this link:</p>
      <p style="margin:0 0 16px"><a href="${escapeEmailAttribute(resetUrl)}">${escapeEmailHtml(resetUrl)}</a></p>
      <p style="margin:0;color:#667085">This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>
    </div>
  `.trim();
}

function buildPasswordResetEmailText({ brandName, resetUrl }) {
  return [
    `Reset your ${brandName} client dashboard password.`,
    "",
    "Use the link below to choose a new password:",
    resetUrl,
    "",
    "This link expires in 30 minutes. If you did not request this, you can ignore this email.",
  ].join("\n");
}

async function sendSmtpMail({ host, port, secure, user, pass, fromEmail, fromName, to, subject, text }) {
  let socket = await connectSmtpSocket({ host, port, secure });

  try {
    await readSmtpResponse(socket, 220);
    await sendSmtpCommand(socket, `EHLO ${getSmtpHelloName(host)}`, 250);
    await sendSmtpCommand(socket, "AUTH LOGIN", 334);
    await sendSmtpCommand(socket, Buffer.from(user).toString("base64"), 334);
    await sendSmtpCommand(socket, Buffer.from(pass).toString("base64"), 235);
    await sendSmtpCommand(socket, `MAIL FROM:<${fromEmail}>`, 250);
    await sendSmtpCommand(socket, `RCPT TO:<${to}>`, 250, 251);
    await sendSmtpCommand(socket, "DATA", 354);

    const message = buildSmtpMessage({
      fromEmail,
      fromName,
      to,
      subject,
      text,
    });

    socket.write(`${message}\r\n.\r\n`);
    await readSmtpResponse(socket, 250);
    await sendSmtpCommand(socket, "QUIT", 221);
  } finally {
    socket.end();
    socket.destroy();
  }
}

function connectSmtpSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.createConnection({ host, port }, () => resolve(socket));

    socket.once("error", onError);
    socket.once("secureConnect", () => socket.removeListener("error", onError));
    socket.once("connect", () => socket.removeListener("error", onError));
    socket.setEncoding("utf8");
  });
}

function readSmtpResponse(socket, ...expectedCodes) {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const finish = (response) => {
      cleanup();
      const code = Number(response.slice(0, 3));
      if (!expectedCodes.length || expectedCodes.includes(code)) {
        resolve(response);
        return;
      }
      reject(new Error(`SMTP error ${code}: ${response}`));
    };

    const tryComplete = () => {
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return false;
      const lastLine = lines[lines.length - 1];
      if (!/^\d{3} /.test(lastLine)) return false;
      finish(lines.join("\n"));
      return true;
    };

    const onData = (chunk) => {
      buffer += chunk;
      tryComplete();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("SMTP connection closed unexpectedly."));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function sendSmtpCommand(socket, command, ...expectedCodes) {
  socket.write(`${command}\r\n`);
  return readSmtpResponse(socket, ...expectedCodes);
}

function buildSmtpMessage({ fromEmail, fromName, to, subject, text }) {
  const fromHeader = fromName ? `${sanitizeEmailHeader(fromName)} <${fromEmail}>` : fromEmail;
  const safeText = String(text || "")
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");

  return [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${sanitizeEmailHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    safeText,
  ].join("\r\n");
}

function sanitizeEmailHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function getSmtpHelloName(host) {
  return sanitizeEmailHeader(host || "localhost") || "localhost";
}

function escapeEmailHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeEmailAttribute(value) {
  return escapeEmailHtml(value).replace(/'/g, "&#39;");
}

async function getFirestoreDocument(documentPath, client = "shelar-tvs") {
  const clientEnv = getEnvForClient(client);
  const projectId = clientEnv.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(documentPath, client)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getAccessToken(client)}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Firestore document lookup failed.");
  }
  return fromFirestoreDocument(data);
}

// ==========================================
// Dashboard and Local JSON Database Helpers
// ==========================================

function readLocalDb(client = "shelar-tvs") {
  const dbPath = client === "eesweb" ? path.join(rootDir, "..", "data_store.json") : path.join(rootDir, "data_store.json");
  if (!fs.existsSync(dbPath)) {
    return getEmptyLocalDb();
  }
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    return {
      businesses: data.businesses || [],
      branches: data.branches || [],
      ratings: data.ratings || [],
      feedback: data.feedback || [],
      reviewEvents: data.reviewEvents || [],
      postedReviews: data.postedReviews || [],
      scans: data.scans || [],
      qrCodes: data.qrCodes || []
    };
  } catch (error) {
    console.error(`Error reading ${client} local database, resetting:`, error.message);
    return getEmptyLocalDb();
  }
}

function getEmptyLocalDb() {
  return {
    businesses: [],
    branches: [],
    ratings: [],
    feedback: [],
    reviewEvents: [],
    postedReviews: [],
    scans: [],
    qrCodes: [],
  };
}

function getQrCodeFromLocalDb(qrCodeId, client = "shelar-tvs") {
  if (!qrCodeId) {
    return null;
  }
  const db = readLocalDb(client);
  return (db.qrCodes || []).find((qr) => qr.qrCodeId === qrCodeId && qr.status !== "deleted") || null;
}

function writeLocalDb(db, client = "shelar-tvs") {
  const dbPath = client === "eesweb" ? path.join(rootDir, "..", "data_store.json") : path.join(rootDir, "data_store.json");
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
  } catch (error) {
    console.error(`Error writing to ${client} local database:`, error.message);
  }
}

function saveToLocalJson(collection, payload, client = "shelar-tvs") {
  const db = readLocalDb(client);
  if (!db[collection]) {
    db[collection] = [];
  }
  const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);
  const doc = { id, ...payload };
  db[collection].push(doc);
  writeLocalDb(db, client);
  return `${collection}/${id}`;
}

function upsertLocalDocument(collection, key, payload, client = "shelar-tvs") {
  const db = readLocalDb(client);
  if (!db[collection]) {
    db[collection] = [];
  }
  const value = payload[key];
  const index = db[collection].findIndex((item) => item[key] === value);
  if (index >= 0) {
    db[collection][index] = { ...db[collection][index], ...payload };
  } else {
    db[collection].push(payload);
  }
  writeLocalDb(db, client);
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getDashboardData(request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    try {
      const businesses = await getFirestoreDocuments("businesses", client);
      const branches = await getFirestoreDocuments("branches", client);
      const ratings = await getFirestoreDocuments("ratings", client);
      const feedback = await getFirestoreDocuments("feedback", client);
      const reviewEvents = await getFirestoreDocuments("reviewEvents", client);
      const postedReviews = await getFirestoreDocuments("postedReviews", client);
      const scans = await getFirestoreDocuments("scans", client);
      const qrCodes = await getFirestoreDocuments("qrCodes", client);
      
      return normalizeDashboardData({ businesses, branches, ratings, feedback, reviewEvents, postedReviews, scans, qrCodes }, client);
    } catch (e) {
      firebaseDiagnostics.status = "fallback";
      firebaseDiagnostics.error = e.message || "Firestore data fetch failed.";
      console.warn("Firestore data fetch failed, using local DB fallback:", e.message);
    }
  } else {
    firebaseDiagnostics.status = "not_configured";
    firebaseDiagnostics.error = "";
  }

  // Local JSON DB fallback
  return normalizeDashboardData(readLocalDb(client), client);
}

function normalizeDashboardData(data, client = "shelar-tvs") {
  const db = {
    businesses: data.businesses || [],
    branches: data.branches || [],
    ratings: data.ratings || [],
    feedback: data.feedback || [],
    reviewEvents: data.reviewEvents || [],
    postedReviews: data.postedReviews || [],
    scans: data.scans || [],
    qrCodes: data.qrCodes || [],
  };
  const scanCounts = db.scans.reduce((counts, scan) => {
    const qrCodeId = scan.qrCodeId || "";
    if (qrCodeId) {
      counts[qrCodeId] = (counts[qrCodeId] || 0) + 1;
    }
    return counts;
  }, {});
  db.qrCodes = db.qrCodes.map((qr) => ({
    ...qr,
    scanCount: scanCounts[qr.qrCodeId] || Number(qr.scanCount || 0),
    dynamicUrl: qr.dynamicUrl || getDynamicQrUrl(qr.qrCodeId, client),
    targetPath: qr.targetPath || getReviewPageUrl(qr.qrCodeId, client),
  }));
  return db;
}

async function getFirestoreDocuments(collection, client = "shelar-tvs") {
  const clientEnv = getEnvForClient(client);
  const projectId = clientEnv.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error(`Missing FIREBASE_PROJECT_ID in .env`);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${prefixFirestorePath(collection, client)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getAccessToken(client)}`,
    },
  });
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Firestore read failed for ${collection}`);
  }
  const data = await response.json();
  return (data.documents || []).map(fromFirestoreDocument);
}

function fromFirestoreDocument(doc) {
  const fields = doc.fields || {};
  const data = {};
  for (const [key, value] of Object.entries(fields)) {
    data[key] = fromFirestoreValue(value);
  }
  const parts = doc.name.split("/");
  data.id = parts[parts.length - 1];
  return data;
}

function fromFirestoreValue(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in value) {
    const fields = value.mapValue.fields || {};
    return Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, fromFirestoreValue(v)])
    );
  }
  return value;
}

async function resolveFeedback(body, request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  const { id, notes } = body;
  if (!id) throw new Error("Missing feedback ID.");
  const updates = {
    status: "resolved",
    resolutionNotes: notes || "",
    resolvedAt: new Date().toISOString(),
  };

  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    try {
      await setFirestoreDocument(`feedback/${id}`, updates, client);
    } catch (error) {
      console.warn("Firestore feedback resolve failed, updating local fallback:", error.message);
    }
  }
  const db = readLocalDb(client);
  const item = db.feedback.find(f => f.id === id);
  if (item) {
    Object.assign(item, updates);
    writeLocalDb(db, client);
  }
  return { ok: true };
}

async function addQrCode(body, request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  const { label, branchName, staff, source, campaign } = body;
  const qrCodeId = normalizeSlug(body.qrCodeId || label || "");
  if (!qrCodeId) throw new Error("Missing QR Code ID.");
  const finalBranchName = String(branchName || clientEnv.BRANCH_NAME || "Main").trim();
  const branchId = normalizeSlug(body.branchId || finalBranchName || clientEnv.BRANCH_ID || "main");
  const publicConfig = getPublicConfig(qrCodeId, client);

  const payload = {
    qrCodeId,
    businessId: publicConfig.businessId,
    label: String(label || `QR for ${staff || source || campaign || finalBranchName}`).trim(),
    branchId,
    branchName: finalBranchName,
    source: String(source || staff || "").trim(),
    staff: String(staff || "").trim(),
    campaign: String(campaign || "").trim(),
    scanCount: 0,
    dynamicUrl: getDynamicQrUrl(qrCodeId, client),
    targetPath: getReviewPageUrlForContext({
      businessId: publicConfig.businessId,
      branchId,
      qrCodeId,
      source: String(source || staff || "").trim(),
      campaign: String(campaign || "").trim(),
    }, client),
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    try {
      await setFirestoreDocument(`qrCodes/${qrCodeId}`, payload, client);
    } catch (error) {
      console.warn("Firestore QR save failed, keeping local tracker:", error.message);
    }
  }
  upsertLocalDocument("qrCodes", "qrCodeId", payload, client);
  return { ok: true, qrCode: payload };
}

function getReviewPageUrlForContext(context, client = "shelar-tvs") {
  const params = new URLSearchParams({
    business: context.businessId,
    branch: context.branchId,
    qr: context.qrCodeId,
  });
  if (context.source) {
    params.set("source", context.source);
  }
  if (context.campaign) {
    params.set("campaign", context.campaign);
  }
  return `${getClientBasePath(client)}/?${params}`;
}

async function deleteQrCode(qrCodeId, request) {
  const client = getClientFromRequest(request);
  const clientEnv = getEnvForClient(client);
  if (!qrCodeId) throw new Error("Missing QR Code ID.");
  const updates = {
    status: "deleted",
    deletedAt: new Date().toISOString(),
  };

  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    try {
      await setFirestoreDocument(`qrCodes/${qrCodeId}`, updates, client);
    } catch (error) {
      console.warn("Firestore QR delete failed, updating local fallback:", error.message);
    }
  }
  const db = readLocalDb(client);
  const qr = (db.qrCodes || []).find(q => q.qrCodeId === qrCodeId);
  if (qr) {
    Object.assign(qr, updates);
    writeLocalDb(db, client);
  }
  return { ok: true };
}

function trackQrScan(qrCodeId, request) {
  const client = getClientFromRequest(request);
  const userAgent = request.headers["user-agent"] || "";
  let deviceType = "Desktop";
  if (/mobile/i.test(userAgent)) {
    deviceType = "Mobile";
  } else if (/tablet/i.test(userAgent)) {
    deviceType = "Tablet";
  }
  
  const referer = request.headers["referer"] || "";
  let visitSource = "QR Scan";
  if (referer) {
    try {
      const url = new URL(referer);
      visitSource = url.hostname;
    } catch {
      visitSource = "External Link";
    }
  }

  const publicConfig = getPublicConfig("", client);
  const qrCode = getQrCodeFromLocalDb(qrCodeId, client);
  const scanEvent = {
    businessId: publicConfig.businessId,
    branchId: qrCode?.branchId || publicConfig.branchId,
    branchName: qrCode?.branchName || publicConfig.branchName,
    qrCodeId,
    qrLabel: qrCode?.label || "",
    source: qrCode?.source || qrCode?.staff || "",
    campaign: qrCode?.campaign || "",
    deviceType,
    visitSource,
    userAgent,
    ipHash: hashClientIp(request),
    createdAt: new Date().toISOString(),
  };

  const clientEnv = getEnvForClient(client);
  if (clientEnv.FIREBASE_PROJECT_ID && clientEnv.FIREBASE_CLIENT_EMAIL && clientEnv.FIREBASE_PRIVATE_KEY) {
    createFirestoreDocument("scans", scanEvent, client).catch(() => {});
  }

  const db = readLocalDb(client);
  if (!db.scans) db.scans = [];
  db.scans.push({ id: Math.random().toString(36).substring(2, 11), ...scanEvent });

  if (db.qrCodes) {
    const qr = db.qrCodes.find(q => q.qrCodeId === qrCodeId);
    if (qr) {
      qr.scanCount = (qr.scanCount || 0) + 1;
      qr.lastScannedAt = scanEvent.createdAt;
    }
  }
  writeLocalDb(db, client);
}

function hashClientIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"] || "";
  const ip = String(forwardedFor).split(",")[0].trim() || request.socket?.remoteAddress || "";
  if (!ip) {
    return "";
  }
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}


function bootstrapLocalDbIfEmpty() {
  const dbPath = path.join(rootDir, "data_store.json");
  if (fs.existsSync(dbPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      let updated = false;
      for (const col of ["businesses", "branches", "ratings", "feedback", "reviewEvents", "postedReviews", "scans", "qrCodes"]) {
        if (!parsed[col]) {
          parsed[col] = [];
          updated = true;
        }
      }
      const publicConfig = getPublicConfig();
      if (!parsed.businesses.some((business) => business.businessId === publicConfig.businessId)) {
        parsed.businesses.push(getLocalBusinessDocument());
        updated = true;
      }
      if (!parsed.branches.some((branch) => branch.branchId === publicConfig.branchId)) {
        parsed.branches.push(getLocalBranchDocument());
        updated = true;
      }
      const defaultQr = getLocalQrDocument();
      const existingDefaultQr = parsed.qrCodes.find((qr) => qr.qrCodeId === defaultQr.qrCodeId);
      if (existingDefaultQr) {
        Object.assign(existingDefaultQr, {
          businessId: existingDefaultQr.businessId || defaultQr.businessId,
          branchId: existingDefaultQr.branchId || defaultQr.branchId,
          branchName: existingDefaultQr.branchName || defaultQr.branchName,
          source: existingDefaultQr.source || existingDefaultQr.staff || defaultQr.source,
          campaign: existingDefaultQr.campaign || "",
          dynamicUrl: existingDefaultQr.dynamicUrl || defaultQr.dynamicUrl,
          targetPath: existingDefaultQr.targetPath || defaultQr.targetPath,
          createdAt: existingDefaultQr.createdAt || defaultQr.createdAt,
          updatedAt: existingDefaultQr.updatedAt || defaultQr.updatedAt,
        });
        updated = true;
      } else {
        parsed.qrCodes.push(defaultQr);
        updated = true;
      }
      if (updated) fs.writeFileSync(dbPath, JSON.stringify(parsed, null, 2), "utf8");
      return;
    } catch {
      // Re-create corrupt file
    }
  }

  const finalDb = {
    businesses: [getLocalBusinessDocument()],
    branches: [getLocalBranchDocument()],
    ratings: [],
    feedback: [],
    reviewEvents: [],
    postedReviews: [],
    scans: [],
    qrCodes: [getLocalQrDocument()]
  };

  fs.writeFileSync(dbPath, JSON.stringify(finalDb, null, 2), "utf8");
}

function ensureLocalBaseDocuments() {
  const publicConfig = getPublicConfig();
  const db = readLocalDb();
  let updated = false;
  if (!db.businesses.some((business) => business.businessId === publicConfig.businessId)) {
    db.businesses.push(getLocalBusinessDocument());
    updated = true;
  }
  if (!db.branches.some((branch) => branch.branchId === publicConfig.branchId)) {
    db.branches.push(getLocalBranchDocument());
    updated = true;
  }
  const defaultQr = getLocalQrDocument();
  const existingQr = db.qrCodes.find((qr) => qr.qrCodeId === defaultQr.qrCodeId);
  if (existingQr) {
    const normalizedQr = {
      ...defaultQr,
      scanCount: existingQr.scanCount || 0,
      createdAt: existingQr.createdAt || defaultQr.createdAt,
      updatedAt: existingQr.updatedAt || defaultQr.updatedAt,
    };
    if (JSON.stringify(existingQr) !== JSON.stringify(normalizedQr)) {
      Object.assign(existingQr, normalizedQr);
      updated = true;
    }
  } else {
    db.qrCodes.push(defaultQr);
    updated = true;
  }
  if (updated) {
    writeLocalDb(db);
  }
}

function getLocalBusinessDocument() {
  const publicConfig = getPublicConfig();
  return {
    businessId: publicConfig.businessId,
    name: publicConfig.businessName,
    googlePlaceId: publicConfig.googlePlaceId,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getLocalBranchDocument() {
  const publicConfig = getPublicConfig();
  return {
    businessId: publicConfig.businessId,
    branchId: publicConfig.branchId,
    name: publicConfig.branchName,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getLocalQrDocument() {
  const publicConfig = getPublicConfig(env.QR_CODE_ID || "shelar-tvs-main");
  return {
    businessId: publicConfig.businessId,
    branchId: publicConfig.branchId,
    branchName: publicConfig.branchName,
    qrCodeId: publicConfig.qrCodeId,
    label: env.QR_CODE_LABEL || "Shelar TVS Main QR",
    source: "General",
    staff: "",
    campaign: "",
    scanCount: 0,
    dynamicUrl: getDynamicQrUrl(publicConfig.qrCodeId),
    targetPath: getReviewPageUrl(publicConfig.qrCodeId),
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
