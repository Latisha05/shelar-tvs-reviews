const pageParams = new URLSearchParams(window.location.search);

const config = {
  businessName: "Shelar TVS",
  businessId: "shelar-tvs",
  branchId: pageParams.get("branch") || "main",
  branchName: "Pune",
  qrCodeId: pageParams.get("qr") || "shelar-tvs-main",
  qrLabel: "",
  qrSource: pageParams.get("source") || "",
  campaign: pageParams.get("campaign") || "",
  googlePlaceId: "PASTE_GOOGLE_PLACE_ID",
  reviewModel: "meta-llama/llama-3.2-1b-instruct",
  reviewSystemPrompt:
    "You write realistic, natural Google reviews from happy customers of Shelar TVS, a TVS two-wheeler sales and service dealership in Pune. Output only one review, with no title, no bullets, no quotes, and no explanation. Sound like a real local customer, not a marketer. Naturally include locally relevant phrases like Shelar TVS, TVS service in Pune, bike servicing, genuine TVS parts, or helpful staff where they fit, but never force them.",
  maxReviewHistory: 12,
  maxGenerationAttempts: 5,
  duplicateSimilarityLimit: 0.72,
  aiTone: "Enthusiastic",
  aiLength: "medium",
  reviewTopics: [
    "Clean design",
    "Fast delivery",
    "Clear strategy",
    "Helpful support",
    "Quality leads",
    "Smooth automation",
  ],
  feedbackTopics: [
    "Slow response",
    "Website issue",
    "Poor leads",
    "Unclear updates",
    "Automation issue",
    "Billing concern",
  ],
  qrContext: {
    businessId: pageParams.get("business") || "demo_business",
    branchId: pageParams.get("branch") || "main_branch",
    branchName: "Main",
    qrCodeId: pageParams.get("qr") || "default_qr",
    qrLabel: "",
    source: pageParams.get("source") || "",
    campaign: pageParams.get("campaign") || "",
  },
};

const state = {
  rating: 0,
  postedToGoogle: false,
  generationCount: 0,
  generationRequestId: 0,
  generationTimer: 0,
  redirectTimer: 0,
  countdownTimer: 0,
  sessionId: getOrCreateSessionId(),
  ratingEventId: "",
};

const steps = {
  rating: document.querySelector("#ratingStep"),
  positive: document.querySelector("#positiveStep"),
  feedback: document.querySelector("#feedbackStep"),
  thankYou: document.querySelector("#thankYouStep"),
};

const businessName = document.querySelector("#businessName");
const reviewText = document.querySelector("#reviewText");
const reviewMode = document.querySelector("#reviewMode");
const googleReviewButton = document.querySelector("#googleReviewButton");
const positiveTopics = document.querySelector("#positiveTopics");
const staffName = document.querySelector("#staffName");
const feedbackTopics = document.querySelector("#feedbackTopics");
const toast = document.querySelector("#toast");
const thankYouMessage = document.querySelector("#thankYouMessage");
const reviewInstructions = document.querySelector("#reviewInstructions");

document.body.dataset.step = "rating";
initApp();

function paintStars(rating) {
  document.querySelectorAll(".rating-button").forEach((ratingButton) => {
    const value = Number(ratingButton.dataset.rating);
    ratingButton.classList.toggle("is-filled", value <= rating);
    ratingButton.classList.toggle("is-selected", value === rating);
  });
}

document.querySelectorAll(".rating-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.rating = Number(button.dataset.rating);
    state.ratingEventId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    paintStars(state.rating);
    saveScanEvent("rating_selected", { rating: state.rating, ratingEventId: state.ratingEventId });

    // Brief pause so the reviewer sees the stars fill before advancing
    window.setTimeout(() => {
      if (state.rating >= 4) {
        showStep("positive");
        generateReview();
      } else {
        showStep("feedback");
      }
    }, 280);
  });
});

positiveTopics.addEventListener("change", () => scheduleGenerateReview());
if (staffName) {
  // Regenerate shortly after the reviewer finishes typing the staff name.
  staffName.addEventListener("input", () => scheduleGenerateReview());
}
reviewMode.addEventListener("change", () => scheduleGenerateReview());
document.querySelector("#reviewTone").addEventListener("change", () => scheduleGenerateReview());

document.querySelector("#regenerateButton").addEventListener("click", () => generateReview());

document.querySelector("#copyReviewButton").addEventListener("click", async () => {
  await copyReview();
});

googleReviewButton.addEventListener("click", async () => {
  const googleReviewUrl = getGoogleReviewUrl();
  googleReviewButton.disabled = true;
  googleReviewButton.textContent = "Copying review...";
  await copyReview();
  saveScanEvent("google_review_clicked", {
    rating: state.rating,
    ratingEventId: state.ratingEventId,
    reviewText: reviewText.value.trim(),
    googleReviewUrlConfigured: Boolean(googleReviewUrl),
  });
  showThankYou(true, Boolean(googleReviewUrl), googleReviewUrl);
});

document.querySelector("#feedbackStep").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const issues = data.getAll("issue");
  const message = String(data.get("message") || "").trim();

  // If "Other" is selected, the review message becomes mandatory
  const otherSelected = issues.some((issue) => issue.toLowerCase() === "other");
  if (otherSelected && !message) {
    const messageField = document.querySelector("#feedbackMessage");
    showToast("Please describe the issue in your review.");
    if (messageField) {
      messageField.setAttribute("aria-invalid", "true");
      messageField.classList.add("is-invalid");
      messageField.focus();
    }
    return;
  }

  const payload = {
    rating: state.rating,
    ratingEventId: state.ratingEventId,
    message,
    name: data.get("name"),
    phone: data.get("phone"),
    callback: data.get("callback") === "on",
    issues,
    context: config.qrContext,
    createdAt: new Date().toISOString(),
  };

  saveScanEvent("negative_feedback_submitted", payload);
  showThankYou(false);
});

document.querySelector("#postedButton").addEventListener("click", () => {
  state.postedToGoogle = true;
  savePostedReview();
  showToast("Thanks, marked as posted.");
});

document.querySelector("#startOverButton").addEventListener("click", () => {
  state.rating = 0;
  window.clearTimeout(state.redirectTimer);
  window.clearInterval(state.countdownTimer);
  googleReviewButton.disabled = false;
  googleReviewButton.textContent = "Post review on Google";
  document.querySelectorAll(".rating-button").forEach((ratingButton) => {
    ratingButton.classList.remove("is-selected", "is-filled");
  });
  showStep("rating");
});

function showStep(stepName) {
  document.body.dataset.step = stepName;
  Object.values(steps).forEach((step) => step.classList.remove("is-active"));
  steps[stepName].classList.add("is-active");
}

async function initApp() {
  await loadRuntimeConfig();
  
  // Set default review tone and length selectors from backend config
  if (config.aiLength) {
    reviewMode.value = config.aiLength;
  }
  const toneElement = document.querySelector("#reviewTone");
  if (toneElement && config.aiTone) {
    toneElement.value = config.aiTone;
  }

  renderTopicChips();
  businessName.textContent = getExperienceQuestion();
}

function renderTopicChips() {
  positiveTopics.innerHTML = config.reviewTopics
    .map((topic) => `<label><input type="checkbox" value="${escapeHtml(topic)}" /> ${escapeHtml(topic)}</label>`)
    .join("");

  feedbackTopics.innerHTML = config.feedbackTopics
    .map((topic) => `<label><input type="checkbox" name="issue" value="${escapeHtml(topic)}" /> ${escapeHtml(getShortTopicLabel(topic))}</label>`)
    .join("");

  // When "Other" is toggled, reflect whether the review message is required
  feedbackTopics.querySelectorAll('input[name="issue"]').forEach((input) => {
    input.addEventListener("change", updateFeedbackMessageRequirement);
  });

  const messageField = document.querySelector("#feedbackMessage");
  if (messageField) {
    messageField.addEventListener("input", () => {
      messageField.removeAttribute("aria-invalid");
      messageField.classList.remove("is-invalid");
    });
  }
}

function updateFeedbackMessageRequirement() {
  const otherSelected = Array.from(
    feedbackTopics.querySelectorAll('input[name="issue"]:checked')
  ).some((input) => input.value.toLowerCase() === "other");

  const optionalTag = document.querySelector("#feedbackMessageLabel .field-optional");
  const messageField = document.querySelector("#feedbackMessage");
  if (optionalTag) {
    optionalTag.textContent = otherSelected ? "(required)" : "(optional)";
  }
  if (messageField && !otherSelected) {
    messageField.removeAttribute("aria-invalid");
    messageField.classList.remove("is-invalid");
  }
}

function getShortTopicLabel(topic) {
  return topic;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadRuntimeConfig() {
  try {
    const params = new URLSearchParams();
    if (config.qrCodeId) {
      params.set("qr", config.qrCodeId);
    }
    if (config.branchId) {
      params.set("branch", config.branchId);
    }
    const response = await fetch(`/api/config?${params}`);
    if (!response.ok) {
      return;
    }

    Object.assign(config, await response.json());
    config.qrContext = {
      businessId: config.businessId,
      branchId: config.branchId,
      branchName: config.branchName || "",
      qrCodeId: config.qrCodeId,
      qrLabel: config.qrLabel || "",
      source: config.qrSource || pageParams.get("source") || "",
      campaign: config.campaign || pageParams.get("campaign") || "",
    };
  } catch (error) {
    businessName.textContent = `How was your experience at ${config.businessName}?`;
  }
}

function scheduleGenerateReview(delay = 220) {
  window.clearTimeout(state.generationTimer);
  state.generationTimer = window.setTimeout(() => generateReview(), delay);
}

async function generateReview() {
  const requestId = state.generationRequestId + 1;
  state.generationRequestId = requestId;
  // Always read mode/tone from config (set from dashboard) not from hidden input value
  const mode = config.aiLength || reviewMode.value || "medium";
  const toneEl = document.querySelector("#reviewTone");
  if (toneEl) toneEl.value = config.aiTone || "Enthusiastic";
  const topics = getSelectedTopics();
  reviewText.value = "Generating your review suggestion…";

  try {
    const generated = await generateUniqueReview(mode, topics);
    if (requestId !== state.generationRequestId) return;
    reviewText.value = generated;
  } catch (error) {
    const fallback = buildUniqueFallbackReview(mode, topics);
    if (requestId !== state.generationRequestId) return;
    if (fallback) {
      rememberGeneratedReview(fallback);
      reviewText.value = fallback;
    } else {
      reviewText.value = getOpeningSafeFallback(mode);
    }
  }
}

function isReviewLengthValid(review, mode) {
  const len = review.length;
  if (mode === "short") {
    return len >= 45 && len <= 110;
  }
  if (mode === "long") {
    return len >= 220 && len <= 460;
  }
  // medium
  return len >= 95 && len <= 190;
}

async function generateUniqueReview(mode, topics) {
  for (let attempt = 0; attempt < config.maxGenerationAttempts; attempt += 1) {
    const generated = await generateWithOpenRouter(mode, topics, attempt);
    const candidate = sanitizeReview(generated);
    if (candidate && isReviewLengthValid(candidate, mode) && isReviewQualityAcceptable(candidate)) {
      rememberGeneratedReview(candidate);
      return candidate;
    }
  }
  // All LLM attempts failed or were rejected, so caller handles fallback.
  throw new Error("No acceptable LLM review generated.");
}

async function generateWithOpenRouter(mode, topics, attempt = 0) {
  const recentReviews = getReviewHistory().slice(0, 4);
  const tone = config.aiTone || document.querySelector("#reviewTone")?.value || "Enthusiastic";

  const response = await fetch("/api/review/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      tone,
      topics,
      staff: getStaffName(),
      rating: state.rating,
      attempt,
      qrCodeId: config.qrCodeId,
      recentReviews,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Review generation failed");
  }

  return String(data.review || "").trim();
}

function sanitizeReview(review) {
  return String(review || "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinPhrases(phrases) {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

function buildUniqueFallbackReview(mode, topics) {
  const tone = config.aiTone || (document.querySelector("#reviewTone")?.value) || "Enthusiastic";
  const compactReview = buildCompactFallbackReview(mode, topics, tone);
  return compactReview || getOpeningSafeFallback(mode);
}

function buildCompactFallbackReview(mode, topics, tone) {
  const options = buildFallbackOptions(mode, topics, tone);
  const start = getFallbackStartIndex(options.length, topics, tone, mode);
  const candidates = [];

  // First pass: find a review that passes all quality checks
  for (let index = 0; index < options.length; index += 1) {
    const candidate = trimReviewToMode(options[(start + index) % options.length], mode);
    if (!candidate) continue;
    candidates.push(candidate);
    if (isReviewQualityAcceptable(candidate)) return candidate;
  }

  // Second pass: relax — accept anything not exact-matched or awkward (ignore similarity score)
  const relaxed = candidates.find((c) =>
    !hasExactReviewMatch(c) && !hasAwkwardReviewWording(c)
  );
  if (relaxed) return relaxed;

  // Last resort: mutate the best candidate slightly to make it distinct
  return buildDistinctFallbackVariant(candidates[0] || "", mode);
}

function buildFallbackOptions(mode, topics, tone) {
  const topicSet = getTopicSet(topics);
  const business = config.businessName;
  const noTopicOptions = getNoTopicFallbackOptions(mode, tone, business);
  if (!topicSet.length) {
    return noTopicOptions;
  }

  if (mode === "short") {
    return buildShortTopicFallbackOptions(topicSet, tone, business);
  }

  return buildTopicFallbackOptions(topicSet, mode, tone, business);
}

function buildTopicFallbackOptions(topicSet, mode, tone, business) {
  const topicSentences = getTopicSentenceVariants(topicSet);
  const openings = {
    Professional: [
      `${business} gave me a smooth service experience.`,
      `Got my two-wheeler serviced at ${business}.`,
      `${business} is a reliable place for TVS service in Pune.`,
      `${business} handled my bike service properly.`,
      `Had a dependable service visit at ${business}.`,
      `${business} kept the whole service organised.`,
      `My visit to ${business} went well.`,
      `${business} handled everything professionally.`,
      `Service at ${business} was done the right way.`,
      `${business} took good care of my two-wheeler.`,
      `The team at ${business} kept things moving.`,
      `${business} gave me a hassle-free service.`,
      `I found ${business} easy to deal with.`,
      `${business} looked after my bike well.`,
    ],
    Enthusiastic: [
      `Really happy with the service at ${business}.`,
      `${business} genuinely impressed me.`,
      `Had a great experience at ${business}.`,
      `${business} did a great job on my bike.`,
      `The team at ${business} made a strong impression.`,
      `My visit to ${business} was a very positive one.`,
      `${business} brought real energy to the service.`,
      `My experience at ${business} was genuinely great.`,
      `${business} gave me a really smooth service.`,
      `Loved how the team at ${business} handled everything.`,
      `My service at ${business} went really well.`,
      `${business} did work I felt good about.`,
      `I came away impressed with ${business}.`,
      `${business} made the visit feel worthwhile.`,
      `The team at ${business} did work I could trust.`,
      `I was pleased with the way ${business} worked.`,
    ],
    Appreciative: [
      `I appreciated the way ${business} handled my service.`,
      `${business} was helpful, honest, and reliable throughout.`,
      `I valued the care the team at ${business} took.`,
      `${business} made the visit easy to appreciate.`,
      `I was glad I chose ${business} for my service.`,
      `The team at ${business} was considerate and helpful.`,
      `I appreciated the support from ${business}.`,
      `${business} gave me a thoughtful service experience.`,
      `I valued the way ${business} looked after my bike.`,
      `${business} made my two-wheeler feel well cared for.`,
      `The staff at ${business} were clear and dependable.`,
      `I appreciated how seriously ${business} took the work.`,
      `${business} gave me a reliable and honest experience.`,
      `I felt ${business} brought real care to the service.`,
    ],
  };
  const closing = {
    Professional: "A dependable choice for TVS service in Pune.",
    Enthusiastic: "I will definitely keep coming back.",
    Appreciative: "It made the whole visit easy to value.",
  };
  const toneOpenings = openings[tone] || openings.Professional;
  const options = [];

  if (mode === "long") {
    for (const opening of toneOpenings) {
      for (const topicSentence of topicSentences) {
        options.push(`${opening} ${topicSentence} ${closing[tone] || closing.Professional}`);
      }
    }
    return options;
  }

  for (const opening of toneOpenings) {
    for (const topicSentence of topicSentences) {
      options.push(`${opening} ${topicSentence}`);
    }
  }
  return options;
}

function buildShortTopicFallbackOptions(topicSet, tone, business) {
  const clauses = topicSet.slice(0, 2).map(getShortTopicClause).filter(Boolean);
  const joined = joinShortClauses(clauses);
  const options = {
    Professional: [
      `${business} ${joined}.`,
      `${business} did solid work and ${joined}.`,
      `A reliable experience at ${business}; they ${joined}.`,
      `Good service from ${business}; they ${joined}.`,
      `${business} was professional and ${joined}.`,
      `${business} kept things smooth and ${joined}.`,
      `Solid experience at ${business}; they ${joined}.`,
      `${business} handled my bike well and ${joined}.`,
    ],
    Enthusiastic: [
      `${business} did great work and ${joined}.`,
      `Really happy with ${business}; they ${joined}.`,
      `${business} impressed me and ${joined}.`,
      `Great experience at ${business}; they ${joined}.`,
      `${business} was excellent and ${joined}.`,
      `${business} made a strong impression and ${joined}.`,
      `Loved my visit to ${business}; they ${joined}.`,
      `${business} did a great job and ${joined}.`,
    ],
    Appreciative: [
      `I appreciated ${business}; they ${joined}.`,
      `${business} was reliable and ${joined}.`,
      `I valued my visit to ${business}; they ${joined}.`,
      `Grateful for ${business}; they ${joined}.`,
      `${business} took care of my bike and ${joined}.`,
      `I valued the staff at ${business}; they ${joined}.`,
      `${business} was helpful and ${joined}.`,
      `I appreciated the service at ${business}; they ${joined}.`,
    ],
  };
  return options[tone] || options.Professional;
}

function getShortTopicClause(topic) {
  const clauses = {
    "timely service": "serviced my bike on time",
    "helpful staff": "had friendly, helpful staff",
    "genuine TVS parts": "used genuine TVS parts",
    "quick delivery": "delivered quickly",
    "good offers": "offered a genuinely good deal",
    "professional mechanics": "had skilled mechanics",
    "expert repair work": "did the repair work properly",
    "a clean workshop": "kept the workshop clean",
  };
  return clauses[topic] || `made ${topic} stand out`;
}

function getReviewTopicClause(topic) {
  const clauses = {
    "timely service": "serviced my bike on time",
    "helpful staff": "had friendly, helpful staff",
    "genuine TVS parts": "used genuine TVS parts",
    "quick delivery": "delivered quickly",
    "good offers": "offered a genuinely good deal",
    "professional mechanics": "had skilled mechanics",
    "expert repair work": "did the repair work properly",
    "a clean workshop": "kept the workshop clean",
  };
  return clauses[topic] || `made ${topic} stand out`;
}

function getReviewTopicNounPhrase(topic) {
  const phrases = {
    "timely service": "timely service",
    "helpful staff": "helpful staff",
    "genuine TVS parts": "genuine TVS parts",
    "quick delivery": "quick delivery",
    "good offers": "a good offer",
    "professional mechanics": "skilled mechanics",
    "expert repair work": "proper repair work",
    "a clean workshop": "a clean workshop",
  };
  return phrases[topic] || topic;
}

function getTopicSentenceVariants(topicSet) {
  const clauses = topicSet.map(getReviewTopicClause).filter(Boolean);
  const nounPhrases = topicSet.map(getReviewTopicNounPhrase).filter(Boolean);
  const joinedClauses = joinReviewClauses(clauses);
  const joinedNouns = joinNaturalPhrases(nounPhrases);
  return [
    `They ${joinedClauses}.`,
    `${capitalizeFirst(joinedNouns)} stood out during my visit.`,
    `I noticed ${joinedNouns} throughout the service.`,
    `The team showed ${joinedNouns} in the way they worked.`,
    `Their ${joinedNouns} made the visit easy to trust.`,
    `The service really benefited from ${joinedNouns}.`,
    `It was clear that the team ${joinedClauses}.`,
    `What stood out most was ${joinedNouns}.`,
    `${capitalizeFirst(joinedNouns)} made the whole experience better.`,
    `The team brought ${joinedNouns} into the service.`,
    `I could see ${joinedNouns} from start to finish.`,
    `The service showed ${joinedNouns} in a real way.`,
    `That mix of ${joinedNouns} made the visit better.`,
    `The experience was better because of ${joinedNouns}.`,
    `Their work gave me ${joinedNouns} without any hassle.`,
    `The team kept ${joinedNouns} consistent throughout.`,
  ];
}

function joinShortClauses(clauses) {
  if (clauses.length <= 1) {
    return clauses[0] || "gave me a solid service experience";
  }
  return `${clauses[0]} and ${clauses[1]}`;
}

function joinReviewClauses(clauses) {
  if (clauses.length <= 1) {
    return clauses[0] || "delivered a solid experience";
  }
  if (clauses.length === 2) {
    return `${clauses[0]}, and ${clauses[1]}`;
  }
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

function joinNaturalPhrases(phrases) {
  if (phrases.length <= 1) {
    return phrases[0] || "a solid experience";
  }
  if (phrases.length === 2) {
    return `${phrases[0]} and ${phrases[1]}`;
  }
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

function getTopicSet(topics) {
  return topics.slice(0, 4).map(normalizeTopicForImpact).filter(Boolean);
}

function normalizeTopicForImpact(topic) {
  const replacements = {
    "Timely Service": "timely service",
    "Helpful Staff": "helpful staff",
    "Genuine Parts": "genuine TVS parts",
    "Quick Delivery": "quick delivery",
    "Best Offers": "good offers",
    "Professional Mechanics": "professional mechanics",
    "Expert Repair": "expert repair work",
    "Clean Workshop": "a clean workshop",
  };
  return replacements[topic] || String(topic || "").trim().toLowerCase();
}

function getTopicPhraseVariants(topicSet) {
  const joined = joinPhrases(topicSet);
  const first = topicSet[0];
  const second = topicSet[1] || topicSet[0];
  const third = topicSet[2] || topicSet[0];
  const handledPhrase = getNaturalTopicPhrase(first);
  const pairedPhrase = topicSet.length > 1
    ? `${getNaturalTopicPhrase(first)} and ${getNaturalTopicPhrase(second)}`
    : handledPhrase;
  const practicalPhrase = getNaturalTopicPhrase(third);
  return [
    {
      inline: `${joined} stood out`,
      highlight: `${capitalizeFirst(joined)} stood out.`,
    },
    {
      inline: `their ${joined} made the visit easier`,
      highlight: `Their ${joined} made the visit easier.`,
    },
    {
      inline: topicSet.length > 1 ? pairedPhrase : handledPhrase,
      highlight: `${capitalizeFirst(topicSet.length > 1 ? pairedPhrase : handledPhrase)}.`,
    },
    {
      inline: `the team brought ${joined} into the whole service`,
      highlight: `The team brought ${joined} into the whole service.`,
    },
    {
      inline: practicalPhrase,
      highlight: `${capitalizeFirst(practicalPhrase)}.`,
    },
    {
      inline: `we noticed ${joined} throughout the process`,
      highlight: `We noticed ${joined} throughout the process.`,
    },
  ];
}

function getFallbackOpenings(tone, business) {
  const openings = {
    Professional: [
      `Had my two-wheeler serviced at ${business}.`,
      `Visited ${business} for my bike service.`,
      `${business} handled my service properly.`,
      `Good experience at ${business} in Pune.`,
      `${business} is a reliable place for TVS service.`,
      `The team at ${business} kept things organised.`,
    ],
    Enthusiastic: [
      `${business} genuinely impressed me.`,
      `The team at ${business} was great.`,
      `Had a fantastic experience at ${business}.`,
      `${business} made my service visit so easy.`,
      `Really happy with ${business} in Pune.`,
      `${business} turned a service visit into a smooth one.`,
    ],
    Appreciative: [
      `Thankful for the service at ${business}.`,
      `${business} took good care of my bike.`,
      `I really valued the staff at ${business}.`,
      `The team at ${business} was thoughtful and honest.`,
      `${business} understood exactly what my bike needed.`,
      `Grateful for the helpful staff at ${business}.`,
    ],
  };
  return openings[tone] || openings.Professional;
}

function getNaturalTopicPhrase(topic) {
  const phrases = {
    "timely service": "my bike was serviced right on time",
    "helpful staff": "the staff were friendly and helpful",
    "genuine TVS parts": "they used genuine TVS parts",
    "quick delivery": "delivery was quick and on schedule",
    "good offers": "the offers were genuinely good",
    "professional mechanics": "the mechanics clearly knew their work",
    "expert repair work": "the repair work was done properly",
    "a clean workshop": "the workshop was clean and well organised",
  };
  return phrases[topic] || `${topic} stood out`;
}

function getFallbackOutcomes(tone) {
  const outcomes = {
    Professional: [
      "the whole service experience felt smooth",
      "I got my two-wheeler back without any hassle",
      "the billing was clear and fair",
      "everything was handled professionally",
      "the service quality was dependable",
      "I would happily come back for my next service",
    ],
    Enthusiastic: [
      "the whole visit was quick and hassle-free",
      "my bike felt brand new after the service",
      "the experience was honestly great",
      "I left really happy with the service",
      "it was easily one of the best TVS service experiences in Pune",
      "I will definitely keep coming back",
    ],
    Appreciative: [
      "I really appreciated how smooth the service was",
      "the team made the whole visit easy",
      "it felt good to be treated so well",
      "the care they took really stood out",
      "I am grateful for the honest service",
      "the experience left me genuinely satisfied",
    ],
  };
  return outcomes[tone] || outcomes.Professional;
}

function getNoTopicFallbackOptions(mode, tone, business) {
  const options = {
    Professional: {
      short: [`Reliable TVS service at ${business}.`, `${business} handled my bike service well.`],
      medium: [
        `Good experience at ${business}. The service was done on time and the staff were helpful throughout.`,
        `${business} took care of my two-wheeler properly. The billing was clear and the work was handled professionally.`,
      ],
      long: [
        `Got my two-wheeler serviced at ${business} in Pune and it was a smooth experience. The staff were helpful, the service was done on time, and the billing was clear. A dependable place for TVS service.`,
      ],
    },
    Enthusiastic: {
      short: [`Great experience at ${business}; staff were so helpful.`, `${business} made my service visit quick and easy.`],
      medium: [
        `Really happy with ${business}. The staff were friendly, the service was quick, and my bike felt brand new.`,
        `Had a great visit to ${business} in Pune. Timely service, helpful staff, and no hassle at all.`,
      ],
      long: [
        `Had a fantastic experience at ${business} in Pune. The staff were friendly and helpful, the service was done quickly with genuine TVS parts, and the whole visit was hassle-free. Easily one of the best TVS service centres around.`,
      ],
    },
    Appreciative: {
      short: [`Grateful for the helpful staff at ${business}.`, `${business} took great care of my bike.`],
      medium: [
        `I appreciated how ${business} handled my service. The staff were patient, helpful, and the work was done honestly.`,
        `${business} made the whole visit easy. The team was thoughtful and the service was completed on time.`,
      ],
      long: [
        `I really appreciated the service at ${business} in Pune. The staff were helpful and honest, my two-wheeler was serviced on time, and the billing was fair. It is reassuring to find a TVS service centre you can trust.`,
      ],
    },
  };
  const toneOptions = options[tone] || options.Professional;
  return toneOptions[mode] || toneOptions.medium;
}

function getFallbackStartIndex(optionCount, topics, tone, mode) {
  const seed = `${topics.join("|")}:${tone}:${mode}:${Date.now()}:${state.generationCount}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return optionCount ? hash % optionCount : 0;
}

function capitalizeFirst(value) {
  return String(value || "").replace(/^./, (char) => char.toUpperCase());
}

function trimReviewToMode(review, mode) {
  const limits = {
    short: 110,
    medium: 190,
    long: 460,
  };
  const limit = limits[mode] || limits.medium;
  const clean = sanitizeReview(review);
  if (clean.length <= limit) {
    return clean;
  }
  if (mode === "short") {
    return "";
  }
  const trimmed = clean.slice(0, limit - 1).replace(/\s+\S*$/, "").replace(/[,.!?;:]+$/, "");
  return `${trimmed}.`;
}

function buildDistinctFallbackVariant(review, mode) {
  const clean = sanitizeReview(review);
  if (!hasExactReviewMatch(clean) && !hasOpeningSentenceMatch(clean) && !hasRepeatedSentenceMatch(clean)) {
    return clean;
  }

  return getOpeningSafeFallback(mode);
}

function getOpeningSafeFallback(mode) {
  const fallbacks = mode === "short"
    ? [
      "Helpful staff and a smooth service experience.",
      "Timely service and friendly staff.",
      "A genuine and hassle-free service visit.",
    ]
    : [
      "The service was timely and the staff were genuinely helpful.",
      "A smooth visit with helpful staff and honest service.",
      "The team handled my two-wheeler well and the billing was fair.",
      "Service was done on time and the staff were friendly throughout.",
      "A reliable and hassle-free service experience overall.",
    ];
  return fallbacks.find((fallback) => !hasOpeningSentenceMatch(fallback) && !hasRepeatedSentenceMatch(fallback)) || fallbacks[0];
}

function getReviewStyleAngle(attempt) {
  const angles = [
    "warm and conversational, like a real customer sharing what they liked",
    "specific and concise, with a different opening than previous suggestions",
    "friendly and appreciative, focusing on the customer experience",
    "simple and believable, avoiding generic praise",
    "fresh wording with a natural recommendation at the end",
  ];
  const index = (state.generationCount + attempt) % angles.length;
  return angles[index];
}

function isRedundantReview(candidate) {
  const normalizedCandidate = normalizeForSimilarity(candidate);
  if (!normalizedCandidate) {
    return true;
  }

  return getReviewHistory().some((previousReview) => {
    const score = getSimilarityScore(normalizedCandidate, normalizeForSimilarity(previousReview));
    return score >= config.duplicateSimilarityLimit;
  });
}

function isReviewQualityAcceptable(candidate) {
  return !hasExactReviewMatch(candidate)
    && !hasOpeningSentenceMatch(candidate)
    && !hasRepeatedSentenceMatch(candidate)
    && !hasAwkwardReviewWording(candidate)
    && !isRedundantReview(candidate);
}

function hasExactReviewMatch(candidate) {
  const normalizedCandidate = normalizeExactReview(candidate);
  if (!normalizedCandidate) {
    return false;
  }
  return getReviewHistory().some((previousReview) => normalizeExactReview(previousReview) === normalizedCandidate);
}

function normalizeExactReview(review) {
  return sanitizeReview(review).toLowerCase();
}

function hasOpeningSentenceMatch(candidate) {
  const opening = normalizeOpeningSentence(candidate);
  if (!opening) {
    return false;
  }
  return getReviewHistory().some((previousReview) => normalizeOpeningSentence(previousReview) === opening);
}

function normalizeOpeningSentence(review) {
  const firstSentence = sanitizeReview(review).split(/[.!?]/)[0] || "";
  return firstSentence.toLowerCase().trim();
}

function hasRepeatedSentenceMatch(candidate) {
  const candidateSentences = getNormalizedReviewSentences(candidate);
  if (!candidateSentences.length) {
    return false;
  }
  const previousSentences = new Set(getReviewHistory().flatMap(getNormalizedReviewSentences));
  return candidateSentences.some((sentence) => previousSentences.has(sentence));
}

function getNormalizedReviewSentences(review) {
  return sanitizeReview(review)
    .split(/[.!?]/)
    .map((sentence) => sentence.toLowerCase().trim())
    .filter(Boolean);
}

function hasAwkwardReviewWording(candidate) {
  const normalized = String(candidate || "").toLowerCase().replace(/\s+/g, " ").trim();
  const blockedPatterns = [
    /\bprocess clarity and process clarity\b/,
    /\b(\w+(?:\s+\w+)?) and \1 were handled\b/,
    /\bshowed clearly in the final result\b/,
    /\bprocess clarity showed clearly\b/,
    /\battention to detail was handled\b/,
    /\bwas handled really well\b/,
    /\bwork reflected attention to detail\b/,
    /\bvalued how .* handled the project\b/,
    /\bmade the process feel calm\b/,
    /\bthankful for how .* guided us\b/,
  ];
  return blockedPatterns.some((pattern) => pattern.test(normalized));
}

function getSimilarityScore(firstReview, secondReview) {
  const firstWords = new Set(firstReview.split(" ").filter(Boolean));
  const secondWords = new Set(secondReview.split(" ").filter(Boolean));
  if (!firstWords.size || !secondWords.size) {
    return 0;
  }

  const sharedWords = [...firstWords].filter((word) => secondWords.has(word)).length;
  const uniqueWords = new Set([...firstWords, ...secondWords]).size;
  return sharedWords / uniqueWords;
}

function normalizeForSimilarity(review) {
  const commonWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "for",
    "had",
    "i",
    "it",
    "of",
    "the",
    "to",
    "was",
  ]);

  return String(review || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !commonWords.has(word))
    .join(" ");
}

function rememberGeneratedReview(review) {
  const history = [sanitizeReview(review), ...getReviewHistory()]
    .filter(Boolean)
    .slice(0, config.maxReviewHistory);
  localStorage.setItem(getReviewHistoryKey(), JSON.stringify(history));
  state.generationCount += 1;
}

function getReviewHistory() {
  return JSON.parse(localStorage.getItem(getReviewHistoryKey()) || "[]");
}

function getReviewHistoryKey() {
  return `reviewFunnelRecentSuggestions:${config.businessName}`;
}

function getSoftUniquenessSuffix() {
  const suffixes = [
    "The whole visit felt personal and well looked after.",
    "It felt like a team that pays attention to the small details.",
    "That extra care made the service easy to appreciate.",
  ];
  return suffixes[state.generationCount % suffixes.length];
}

function getSelectedTopics() {
  return Array.from(document.querySelectorAll('#positiveTopics input[type="checkbox"]:checked')).map(
    (input) => input.value,
  );
}

function getStaffName() {
  if (!staffName) return "";
  // Allow letters, spaces, and a few common name characters; keep it short.
  return staffName.value
    .replace(/[^\p{L}\s.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

async function copyReview() {
  const text = reviewText.value.trim();
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast("Review copied.");
  } catch (error) {
    reviewText.focus();
    reviewText.select();
    document.execCommand("copy");
    showToast("Review selected. Copy it if needed.");
  }
}

function savePostedReview() {
  saveToServer("postedReviews", "customer_self_reported_google_post", {
    rating: state.rating,
    ratingEventId: state.ratingEventId,
    reviewText: reviewText.value.trim(),
    status: "self_reported_posted",
  });
}

function getGoogleReviewUrl() {
  const place = String(config.googlePlaceId || "").trim();
  if (!place || place === "PASTE_GOOGLE_PLACE_ID") return "";
  if (/^https?:\/\//i.test(place)) return place;
  return `https://g.page/r/${encodeURIComponent(place)}/review`;
}

function getExperienceQuestion() {
  const branch = String(config.branchName || "").trim();
  const business = String(config.businessName || "Shelar TVS").trim();
  if (branch && !["main", "pune"].includes(branch.toLowerCase())) {
    return `How was your experience at ${business}, ${branch}?`;
  }
  return `How was your experience at ${business}?`;
}

function showThankYou(isPositive, openedGoogle = false, googleReviewUrl = "") {
  window.clearTimeout(state.redirectTimer);
  window.clearInterval(state.countdownTimer);

  thankYouMessage.textContent = isPositive
    ? openedGoogle
      ? "Thank you, this means a lot to us. Your review has been copied and you will be redirected to Google Reviews shortly."
      : "Your review test has been saved. Add a Google Place ID later to enable the redirect."
    : "Thank you for your review! We truly value your input and our team will work on making your next experience even better.";
  reviewInstructions.hidden = !isPositive || !openedGoogle;
  document.querySelector("#postedButton").hidden = true;
  showStep("thankYou");

  if (isPositive && openedGoogle && googleReviewUrl) {
    startGoogleRedirectCountdown(googleReviewUrl);
  }
}

function startGoogleRedirectCountdown(googleReviewUrl) {
  const countdownElement = document.querySelector("#redirectCountdown");
  let secondsLeft = 5;
  if (countdownElement) {
    countdownElement.textContent = String(secondsLeft);
  }

  state.countdownTimer = window.setInterval(() => {
    secondsLeft -= 1;
    if (countdownElement) {
      countdownElement.textContent = String(Math.max(secondsLeft, 0));
    }
    if (secondsLeft <= 0) {
      window.clearInterval(state.countdownTimer);
    }
  }, 1000);

  state.redirectTimer = window.setTimeout(() => {
    window.location.href = googleReviewUrl;
  }, 5000);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function saveScanEvent(type, payload) {
  const collection = getCollectionForEvent(type);
  if (collection) {
    saveToServer(collection, type, payload);
  }

  const events = JSON.parse(localStorage.getItem("reviewFunnelEvents") || "[]");
  events.push({
    type,
    payload: {
      ...payload,
      sessionId: state.sessionId,
      businessId: config.businessId,
      branchId: config.branchId,
      qrCodeId: config.qrCodeId,
    },
    context: config.qrContext,
    createdAt: new Date().toISOString(),
  });
  localStorage.setItem("reviewFunnelEvents", JSON.stringify(events));
}

function getCollectionForEvent(type) {
  if (type === "rating_selected") {
    return "ratings";
  }
  if (type === "negative_feedback_submitted") {
    return "feedback";
  }
  if (type === "google_review_clicked") {
    return "reviewEvents";
  }
  return "";
}

async function saveToServer(collection, type, payload) {
  try {
    const response = await fetch("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collection,
        type,
        userAgent: navigator.userAgent,
        payload: {
          ...payload,
          businessId: config.businessId,
          branchId: config.branchId,
          branchName: config.branchName,
          qrCodeId: config.qrCodeId,
          qrLabel: config.qrLabel,
          source: config.qrSource || config.qrContext.source,
          campaign: config.campaign || config.qrContext.campaign,
          sessionId: state.sessionId,
          context: config.qrContext,
        },
      }),
    });

    if (!response.ok) {
      throw new Error("Firestore save failed");
    }
  } catch (error) {
    console.warn(error.message);
  }
}

function getOrCreateSessionId() {
  const key = "reviewFunnelSessionId";
  const existing = sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(key, id);
  return id;
}
