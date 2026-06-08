const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const rootDir = __dirname;
const localDbPath = path.join(rootDir, "data_store.json");
const env = { ...loadEnv(path.join(rootDir, ".env")), ...getNonEmptyProcessEnv() };
const port = Number(env.PORT || 5500);
// All Firestore collections are namespaced with this prefix so this client's
// data never mixes with other clients sharing the same Firebase project.
const dataPrefix = String(env.DATA_PREFIX || "shelartvs").trim();
const allowedCollections = new Set(["ratings", "feedback", "reviewEvents", "postedReviews"]);

function getClientFromRequest(request) {
  if (!request || !request.url) return "shelar-tvs";
  try {
    const url = new URL(request.url, "http://localhost");
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
        const urlObj = new URL(request.url, "http://localhost");
        const pathname = urlObj.pathname;

        if (request.method === "GET" && pathname === "/api/config") {
          sendJson(response, 200, getPublicConfigFromRequest(request));
          return;
        }

        if (request.method === "GET" && pathname === "/api/dashboard/settings") {
          sendJson(response, 200, getDashboardSettings(request));
          return;
        }

        if (request.method === "GET" && pathname === "/api/dashboard/data") {
          sendJson(response, 200, await getDashboardData(request));
          return;
        }

        if (request.method === "GET" && pathname.startsWith("/r/")) {
          handleDynamicQrRedirect(request, response);
          return;
        }

        if (request.method === "POST" && pathname === "/api/dashboard/settings") {
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
          const body = await readJson(request);
          sendJson(response, 200, await resolveFeedback(body, request));
          return;
        }

        if (request.method === "POST" && pathname === "/api/dashboard/qrcodes") {
          const body = await readJson(request);
          sendJson(response, 200, await addQrCode(body, request));
          return;
        }

        if (request.method === "DELETE" && pathname.startsWith("/api/dashboard/qrcodes/")) {
          const qrCodeId = decodeURIComponent(pathname.split("/").pop());
          sendJson(response, 200, await deleteQrCode(qrCodeId, request));
          return;
        }

        await serveStatic(request, response);
      } catch (error) {
        sendJson(response, 500, { error: error.message || "Server error" });
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

function getReviewPageUrl(qrCodeId) {
  const publicConfig = getPublicConfig(qrCodeId);
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
  return `/?${params}`;
}

function handleDynamicQrRedirect(request, response) {
  const qrCodeId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.replace(/^\/r\//, ""));
  try {
    trackQrScan(qrCodeId, request);
  } catch (error) {
    console.warn("Scan tracking error:", error.message);
  }
  response.writeHead(302, {
    Location: getReviewPageUrl(qrCodeId),
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
  const apiKey = String(clientEnv.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("PASTE_") || apiKey === "your_gemini_api_key") {
    throw new Error("Gemini API key is not configured.");
  }

  const qrCodeId = String(body?.qrCodeId || "").trim();
  const publicConfig = getPublicConfig(qrCodeId, client);
  const mode = normalizeReviewMode(body?.mode);
  const tone = normalizeReviewTone(body?.tone || publicConfig.aiTone);
  const topics = parseList(body?.topics || "", "").slice(0, 4);
  const staff = sanitizeStaffName(body?.staff);
  const vehicleModel = sanitizeVehicleModel(body?.vehicleModel);
  const recentReviews = Array.isArray(body?.recentReviews)
    ? body.recentReviews.map((review) => String(review || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  const prompt = buildGeminiReviewPrompt({
    businessName: publicConfig.businessName,
    mode,
    tone,
    topics,
    staff,
    vehicleModel,
    rating: Number(body?.rating || 5),
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

function buildGeminiReviewPrompt({ businessName, mode, tone, topics, staff, vehicleModel, rating, recentReviews, systemPrompt }) {
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
    ? `The customer had a positive experience with the following: ${experiences.join("; ")}. Write naturally about what they felt or experienced — describe the outcome, not a label. Do not use these as literal phrases.`
    : "No specific aspects were selected, so keep the review general and do not invent specific service outcomes.";

  const keywordInstruction = seoKeywords.length
    ? `If one or two of these phrases fit naturally into the review, you may use them exactly as written: ${seoKeywords.join(", ")}. Never list them or force them in.`
    : "";

  const staffInstruction = staff
    ? `The customer was helped by a staff member named ${staff}. Mention ${staff} once, naturally, as the person who helped them. Do not invent a surname or title.`
    : "";
  const vehicleInstruction = vehicleModel
    ? `The purchased vehicle model was ${vehicleModel}. Mention this exact model once, naturally.`
    : "";

  const recentOpenings = recentReviews
    .map((review) => review.split(/[.!?]/)[0])
    .filter(Boolean)
    .slice(0, 6);

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
    "The review must sound like a real customer voluntarily describing a genuine experience.",
    "Avoid AI-like templates, repeated openings, generic marketing copy, exaggerated claims, and policy-risky wording.",
    "Do not mention AI, prompts, generated text, incentives, ratings, or internal instructions.",
    "Do not use emojis, hashtags, titles, bullet points, or quotes.",
    "Do not copy any sentence shape from recent suggestions.",
    recentOpenings.length ? `Do not start like these recent openings:\n- ${recentOpenings.join("\n- ")}` : "",
    recentReviews.length ? `Do not sound like these recent suggestions:\n- ${recentReviews.join("\n- ")}` : "",
    "Output only the final review text.",
  ].filter(Boolean).join("\n");
}

function normalizeReviewMode(mode) {
  return ["short", "medium", "long"].includes(mode) ? mode : "medium";
}

function normalizeReviewTone(tone) {
  return ["Professional", "Enthusiastic", "Appreciative"].includes(tone) ? tone : "Professional";
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
  let safePath = requestedPath === "/" ? "/index.html" : requestedPath;
  
  if (safePath === "/eesweb") {
    response.writeHead(302, { Location: "/eesweb/" });
    response.end();
    return;
  }
  
  if (safePath.startsWith("/eesweb/")) {
    targetRootDir = path.join(rootDir, "..");
    safePath = safePath.slice(7); // Remove "/eesweb"
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
    }),
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

function getReviewPageUrlForContext(context) {
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
  return `/?${params}`;
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
