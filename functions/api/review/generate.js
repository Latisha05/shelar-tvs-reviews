import { getMergedEnv, getPublicConfig, json, jsonError, parseList } from "../../_shared.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const apiKey = String(env.GEMINI_API_KEY || "").trim();
    if (!apiKey || apiKey.startsWith("PASTE_") || apiKey === "your_gemini_api_key") {
      return jsonError("Gemini API key is not configured.", 503);
    }

    const body = await ctx.request.json();
    const config = getPublicConfig(env);
    const mode = normalizeReviewMode(body?.mode);
    const tone = normalizeReviewTone(body?.tone || config.aiTone);
    const topics = parseList(body?.topics || "", "").slice(0, 4);
    const staff = sanitizeStaffName(body?.staff);
    const vehicleModel = sanitizeVehicleModel(body?.vehicleModel);
    const recentReviews = Array.isArray(body?.recentReviews)
      ? body.recentReviews.map((review) => String(review || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const prompt = buildGeminiReviewPrompt({
      businessName: config.businessName,
      mode,
      tone,
      topics,
      staff,
      vehicleModel,
      rating: Number(body?.rating || 5),
      recentReviews,
      systemPrompt: config.reviewSystemPrompt,
    });

    const model = encodeURIComponent(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: config.reviewSystemPrompt }],
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
      return jsonError(data?.error?.message || "Gemini request failed.", response.status);
    }

    const review = extractGeminiText(data);
    if (!review) {
      return jsonError("Gemini returned an empty review.", 502);
    }

    return json({ review });
  } catch (e) {
    return jsonError(e.message);
  }
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

const TOPIC_EXPERIENCE_MAP = {
  "New Bike Purchase": { experience: "buying a new bike", keywords: ["TVS bike near me", "Apache near me"] },
  "New Scooter Purchase": { experience: "buying a new scooter", keywords: ["Jupiter near me", "TVS scooter Pune"] },
  "Test Ride Experience": { experience: "going for a test ride before buying", keywords: ["TVS showroom Pune", "TVS test ride Pune"] },
  "Best Price/Deal": { experience: "getting a great price without any haggling", keywords: ["best TVS deals Pune", "TVS offers Pune"] },
  "Quick Delivery": { experience: "receiving the vehicle faster than expected", keywords: ["Shelar TVS"] },
  "Smooth Paperwork": { experience: "completing all the paperwork quickly and without hassle", keywords: ["Shelar TVS"] },
  "Easy EMI Process": { experience: "setting up EMI easily with no confusing steps", keywords: ["Shelar TVS"] },
  "Helpful Staff": { experience: "being guided by genuinely helpful staff throughout", keywords: ["Shelar TVS"] },
  "Knowledgeable Executive": { experience: "working with a sales executive who really knew every detail about the bikes", keywords: ["TVS showroom Pune"] },
  "Genuine Parts": { experience: "getting only genuine OEM parts used during service", keywords: ["genuine TVS parts", "TVS service Pune"] },
  "Timely Service": { experience: "having the service completed exactly on time", keywords: ["TVS service Pune", "TVS bike service Pune"] },
};

function mapTopicsToExperience(topics) {
  const experiences = [];
  const rawKeywords = [];
  for (const topic of topics) {
    const mapping = TOPIC_EXPERIENCE_MAP[topic];
    if (mapping) {
      experiences.push(mapping.experience);
      rawKeywords.push(...mapping.keywords);
    } else {
      experiences.push(String(topic || "").trim().toLowerCase());
    }
  }
  return {
    experiences: experiences.filter(Boolean),
    seoKeywords: [...new Set(rawKeywords)].slice(0, 3),
  };
}

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
  const { experiences, seoKeywords } = mapTopicsToExperience(topics);
  const topicInstructions = experiences.length
    ? `The customer had a positive experience with the following: ${experiences.join("; ")}. Write naturally about what they felt or experienced - describe the outcome, not a label. Do not use these as literal phrases.`
    : "No specific aspects selected. Write a general, authentic-sounding review about visiting a TVS dealership.";
  const seoInstruction = seoKeywords.length
    ? `If one or two of these phrases fit naturally into the review, you may use them exactly as written: ${seoKeywords.join(", ")}. Never list them or force them in.`
    : "Where it fits naturally, you may mention one of: Shelar TVS, TVS showroom Pune, TVS service Pune, genuine TVS parts, or Apache near me. Pick at most one or two, never list them.";
  const staffInstruction = staff
    ? `The customer was helped by ${staff}. Mention ${staff} once naturally - do not invent a surname or title.`
    : "";
  const vehicleInstruction = vehicleModel
    ? `The purchased vehicle model was ${vehicleModel}. Mention it naturally once if it fits the review.`
    : "";
  const recentOpenings = recentReviews
    .map((review) => review.split(/[.!?]/)[0])
    .filter(Boolean)
    .slice(0, 6);

  return [
    systemPrompt,
    "",
    `Write one Google review for ${businessName}, a TVS two-wheeler showroom and service centre in Pune.`,
    `Rating context: ${Number.isFinite(rating) ? rating : 5} out of 5 stars.`,
    `Tone: ${tone}. ${toneInstructions[tone] || toneInstructions.Professional}`,
    `Length: ${lengthInstructions[mode] || lengthInstructions.medium}`,
    topicInstructions,
    staffInstruction,
    vehicleInstruction,
    seoInstruction,
    "The review must read like a real customer voluntarily sharing their own experience - not marketing copy.",
    "Vary the opening every time. Never start two reviews the same way.",
    "Do not mention AI, prompts, incentives, SEO, keywords, ratings numbers, or internal instructions.",
    "Do not use emojis, hashtags, bullet points, or quotes.",
    recentOpenings.length ? `Do not start like any of these recent openings:\n- ${recentOpenings.join("\n- ")}` : "",
    recentReviews.length ? `Do not echo these recent suggestions:\n- ${recentReviews.join("\n- ")}` : "",
    "Output only the final review text, nothing else.",
  ].filter(Boolean).join("\n");
}

function normalizeReviewMode(mode) {
  return ["short", "medium", "long"].includes(mode) ? mode : "medium";
}

function normalizeReviewTone(tone) {
  return ["Professional", "Enthusiastic", "Appreciative"].includes(tone) ? tone : "Professional";
}
