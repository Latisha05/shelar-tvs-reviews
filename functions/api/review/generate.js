import { getMergedEnv, getPublicConfig, json, jsonError, parseList } from "../../_shared.js";

export async function onRequestPost(ctx) {
  try {
    const env = await getMergedEnv(ctx.env);
    const apiKey = String(env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey || apiKey.startsWith("PASTE_") || apiKey === "your_openrouter_api_key") {
      return jsonError("OpenRouter API key is not configured.", 503);
    }

    const body = await ctx.request.json();
    const config = getPublicConfig(env);
    const mode = normalizeReviewMode(body?.mode);
    const tone = normalizeReviewTone(body?.tone || config.aiTone);
    const topics = parseList(body?.topics || "", "").slice(0, 4);
    const staff = sanitizeStaffName(body?.staff);
    const recentReviews = Array.isArray(body?.recentReviews)
      ? body.recentReviews.map((review) => String(review || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const prompt = buildOpenRouterReviewPrompt({
      businessName: config.businessName,
      mode,
      tone,
      topics,
      staff,
      rating: Number(body?.rating || 5),
      recentReviews,
      systemPrompt: config.reviewSystemPrompt,
    });

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_BASE_URL || new URL(ctx.request.url).origin,
        "X-Title": env.APP_NAME || "Shelar TVS Reviews",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL || "meta-llama/llama-3.2-1b-instruct",
        messages: [
          { role: "system", content: config.reviewSystemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: mode === "short" ? 0.85 : 0.95,
        top_p: 0.9,
        max_tokens: mode === "long" ? 140 : mode === "medium" ? 80 : 45,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return jsonError(data?.error?.message || "OpenRouter request failed.", response.status);
    }

    const review = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!review) {
      return jsonError("OpenRouter returned an empty review.", 502);
    }

    return json({ review });
  } catch (e) {
    return jsonError(e.message);
  }
}

function sanitizeStaffName(value) {
  // Keep it short, plain, and safe: letters, spaces, a few common name characters only.
  return String(value || "")
    .replace(/[^\p{L}\s.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

// Maps selected positive topics → SEO keyword phrases the LLM may naturally weave in.
// The model is told to pick at most one or two — this avoids keyword stuffing while
// giving it the right anchors for local search intent.
const TOPIC_SEO_KEYWORDS = {
  "New Bike Purchase":       ["TVS bike near me", "Apache near me"],
  "New Scooter Purchase":    ["Jupiter near me", "TVS scooter Pune"],
  "Test Ride Experience":    ["TVS showroom Pune", "TVS test ride Pune"],
  "Best Price/Deal":         ["best TVS deals Pune", "TVS offers Pune"],
  "Quick Delivery":          ["Shelar TVS", "quick bike delivery Pune"],
  "Smooth Paperwork":        ["Shelar TVS", "TVS dealership Pune"],
  "Easy EMI Process":        ["TVS EMI Pune", "Shelar TVS"],
  "Helpful Staff":           ["Shelar TVS", "TVS showroom Pune"],
  "Knowledgeable Executive": ["Shelar TVS", "TVS bike Pune"],
  "Genuine Parts":           ["genuine TVS parts", "TVS service Pune"],
  "Timely Service":          ["TVS service Pune", "TVS bike service Pune"],
};

function mapTopicsToSeoKeywords(topics) {
  const seen = new Set();
  const keywords = [];
  for (const topic of topics) {
    const mapped = TOPIC_SEO_KEYWORDS[topic] || [];
    for (const kw of mapped) {
      if (!seen.has(kw)) {
        seen.add(kw);
        keywords.push(kw);
      }
    }
  }
  // Return up to 3 unique keywords — enough variety without overwhelming a small LLM
  return keywords.slice(0, 3);
}

function buildOpenRouterReviewPrompt({ businessName, mode, tone, topics, staff, rating, recentReviews, systemPrompt }) {
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

  const seoKeywords = mapTopicsToSeoKeywords(topics);
  const seoInstruction = seoKeywords.length
    ? `If it fits naturally, you may use one of these phrases exactly as written (pick at most one or two, never list them): ${seoKeywords.join(", ")}.`
    : `Where it fits naturally, you may mention one of: Shelar TVS, TVS showroom Pune, TVS service Pune, genuine TVS parts, or Apache near me. Pick at most one or two, never list them.`;

  const topicInstructions = topics.length
    ? `Customer's experience involved: ${topics.join(", ")}. Use these as ideas for what the review is about — do not repeat them verbatim or list them.`
    : "No specific aspects selected. Write a general, authentic-sounding review about visiting a TVS dealership.";
  const staffInstruction = staff
    ? `The customer was helped by ${staff}. Mention ${staff} once naturally — do not invent a surname or title.`
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
    seoInstruction,
    "The review must read like a real customer voluntarily sharing their own experience — not marketing copy.",
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
