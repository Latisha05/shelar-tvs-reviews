const pageParams = new URLSearchParams(window.location.search);
const appContext = resolveAppContext();

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
  reviewModel: "gemini-3.1-flash-lite",
  reviewSystemPrompt:
    "You write realistic, natural Google reviews from real customers of Shelar TVS, a TVS two-wheeler showroom and service centre in Pune. Output only one review — no title, no bullets, no quotes, no explanation. Sound like a genuine local customer sharing a real purchase or service experience, not a marketing copy. Vary sentence structure every time. Weave in one or two search-relevant phrases naturally — such as Shelar TVS, TVS showroom Pune, Apache near me, Jupiter near me, TVS bike near me, best TVS deals Pune, TVS service Pune, genuine TVS parts — only if they fit the sentence. Never list keywords. Mention concrete touches: a friendly executive, a test ride, smooth EMI, on-time delivery, fair pricing, clean workshop. Do not use emojis, hashtags, AI/SEO mentions, incentive language, or the phrase highly recommended more than once.",
  maxReviewHistory: 12,
  maxGenerationAttempts: 5,
  duplicateSimilarityLimit: 0.72,
  aiTone: "Enthusiastic",
  aiLength: "medium",
  reviewTopics: [
    "New Bike Purchase",
    "New Scooter Purchase",
    "Test Ride Experience",
    "Best Price/Deal",
    "Quick Delivery",
    "Smooth Paperwork",
    "Easy EMI Process",
    "Helpful Staff",
    "Knowledgeable Executive",
    "Genuine Parts",
    "Timely Service",
  ],
  feedbackTopics: [
    "Service Delay",
    "Long Wait for Delivery",
    "Parts Issue",
    "Hidden Charges",
    "Staff Behavior",
    "Test Ride Denied",
    "Billing Problem",
    "Insurance/Loan Issue",
    "Lack of Information",
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
  vehicleTopic: "",
  vehicleModel: "",
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
const vehicleModal = document.querySelector("#vehicleModal");
const vehicleModalOverlay = document.querySelector("#vehicleModalOverlay");
const vehicleModalClose = document.querySelector("#vehicleModalClose");
const vehicleModalKicker = document.querySelector("#vehicleModalKicker");
const vehicleModalTitle = document.querySelector("#vehicleModalTitle");
const vehicleQuickOptions = document.querySelector("#vehicleQuickOptions");
const vehicleModelInput = document.querySelector("#vehicleModelInput");
const vehicleContext = document.querySelector("#vehicleContext");
const vehicleContextText = document.querySelector("#vehicleContextText");
const editVehicleButton = document.querySelector("#editVehicleButton");
const skipVehicleButton = document.querySelector("#skipVehicleButton");
const saveVehicleButton = document.querySelector("#saveVehicleButton");

const purchaseTopicLabels = new Set(["New Bike Purchase", "New Scooter Purchase"]);
const reviewToneCycle = ["Professional", "Enthusiastic", "Appreciative"];
const vehicleQuickOptionsByTopic = {
  "New Bike Purchase": ["Apache RTR 160", "Apache RTR 200", "Raider", "Radeon"],
  "New Scooter Purchase": ["Jupiter", "Ntorq", "iQube", "Zest"],
};

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

positiveTopics.addEventListener("change", handlePositiveTopicsChange);
if (staffName) {
  // Regenerate shortly after the reviewer finishes typing the staff name.
  staffName.addEventListener("input", () => scheduleGenerateReview());
}
reviewMode.addEventListener("change", () => scheduleGenerateReview());
document.querySelector("#reviewTone").addEventListener("change", () => scheduleGenerateReview());

document.querySelector("#regenerateButton").addEventListener("click", () => generateReview());
if (editVehicleButton) editVehicleButton.addEventListener("click", () => openVehicleModal(getSelectedPurchaseTopic()));
if (vehicleModalOverlay) vehicleModalOverlay.addEventListener("click", closeVehicleModal);
if (vehicleModalClose) vehicleModalClose.addEventListener("click", closeVehicleModal);
if (skipVehicleButton) skipVehicleButton.addEventListener("click", skipVehicleDetail);
if (saveVehicleButton) saveVehicleButton.addEventListener("click", saveVehicleDetail);
if (vehicleModelInput) {
  vehicleModelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveVehicleDetail();
    }
    if (event.key === "Escape") {
      closeVehicleModal();
    }
  });
}

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
  state.vehicleTopic = "";
  state.vehicleModel = "";
  window.clearTimeout(state.redirectTimer);
  window.clearInterval(state.countdownTimer);
  googleReviewButton.disabled = false;
  googleReviewButton.textContent = "Post review on Google";
  document.querySelectorAll(".rating-button").forEach((ratingButton) => {
    ratingButton.classList.remove("is-selected", "is-filled");
  });
  showStep("rating");
  updateVehicleContext();
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

function handlePositiveTopicsChange(event) {
  if (event?.target?.checked && purchaseTopicLabels.has(event.target.value)) {
    positiveTopics.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      if (purchaseTopicLabels.has(input.value) && input.value !== event.target.value) {
        input.checked = false;
      }
    });
  }

  const selectedPurchaseTopic = getSelectedPurchaseTopic();
  if (!selectedPurchaseTopic) {
    state.vehicleTopic = "";
    state.vehicleModel = "";
    updateVehicleContext();
    scheduleGenerateReview();
    return;
  }

  if (state.vehicleTopic && state.vehicleTopic !== selectedPurchaseTopic) {
    state.vehicleModel = "";
  }
  state.vehicleTopic = selectedPurchaseTopic;
  updateVehicleContext();

  if (event?.target?.checked && purchaseTopicLabels.has(event.target.value) && !state.vehicleModel) {
    openVehicleModal(selectedPurchaseTopic);
    return;
  }

  scheduleGenerateReview();
}

function getSelectedPurchaseTopic() {
  const selectedTopics = getSelectedTopics();
  if (selectedTopics.includes("New Bike Purchase")) return "New Bike Purchase";
  if (selectedTopics.includes("New Scooter Purchase")) return "New Scooter Purchase";
  return "";
}

function openVehicleModal(topic) {
  if (!vehicleModal || !topic) return;
  state.vehicleTopic = topic;
  const options = vehicleQuickOptionsByTopic[topic] || [];
  if (vehicleModalKicker) vehicleModalKicker.textContent = topic === "New Scooter Purchase" ? "Scooter purchased" : "Bike purchased";
  if (vehicleModalTitle) vehicleModalTitle.textContent = topic === "New Scooter Purchase" ? "Which scooter was it?" : "Which bike was it?";
  if (vehicleQuickOptions) {
    vehicleQuickOptions.innerHTML = options
      .map((option) => `<button class="vehicle-option" type="button" data-vehicle="${escapeHtml(option)}">${escapeHtml(option)}</button>`)
      .join("");
    vehicleQuickOptions.querySelectorAll("[data-vehicle]").forEach((button) => {
      button.addEventListener("click", () => {
        state.vehicleModel = button.dataset.vehicle || "";
        if (vehicleModelInput) vehicleModelInput.value = state.vehicleModel;
        saveVehicleDetail();
      });
    });
  }
  if (vehicleModelInput) vehicleModelInput.value = state.vehicleModel || "";
  vehicleModal.classList.add("is-active");
  vehicleModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => vehicleModelInput?.focus(), 80);
}

function closeVehicleModal() {
  if (!vehicleModal) return;
  vehicleModal.classList.remove("is-active");
  vehicleModal.setAttribute("aria-hidden", "true");
}

function skipVehicleDetail() {
  state.vehicleModel = "";
  updateVehicleContext();
  closeVehicleModal();
  scheduleGenerateReview();
}

function saveVehicleDetail() {
  state.vehicleModel = sanitizeVehicleModel(vehicleModelInput?.value || state.vehicleModel);
  updateVehicleContext();
  closeVehicleModal();
  scheduleGenerateReview();
}

function updateVehicleContext() {
  if (!vehicleContext || !vehicleContextText) return;
  if (!state.vehicleTopic) {
    vehicleContext.hidden = true;
    vehicleContextText.textContent = "";
    return;
  }
  const label = state.vehicleTopic === "New Scooter Purchase" ? "Scooter" : "Bike";
  vehicleContext.hidden = false;
  vehicleContextText.textContent = state.vehicleModel ? `${label}: ${state.vehicleModel}` : `${label} model not added`;
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
    const response = await fetch(apiUrl(`/api/config?${params}`));
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
  if (toneEl) toneEl.value = getRotatingTone(0);
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
  const maxAttempts = topics.length ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const generated = await generateWithGemini(mode, topics, attempt);
    const candidate = sanitizeReview(generated);
    if (candidate && isReviewLengthValid(candidate, mode) && isReviewQualityAcceptable(candidate, topics)) {
      rememberGeneratedReview(candidate);
      return candidate;
    }
  }
  // All LLM attempts failed or were rejected, so caller handles fallback.
  throw new Error("No acceptable LLM review generated.");
}

async function generateWithGemini(mode, topics, attempt = 0) {
  const recentReviews = getReviewHistory().slice(0, 4);
  const tone = getRotatingTone(attempt);
  const toneEl = document.querySelector("#reviewTone");
  if (toneEl) toneEl.value = tone;

  const response = await fetch(apiUrl("/api/review/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      tone,
      topics,
      vehicleModel: getVehicleModel(),
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
    if (isReviewQualityAcceptable(candidate, topics)) return candidate;
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
    "a new bike purchase":       "helped me find the right bike",
    "a new scooter purchase":    "helped me pick the right scooter",
    "the test ride experience":  "arranged a smooth test ride",
    "the best price":            "offered a genuinely good deal",
    "quick delivery":            "delivered quickly",
    "smooth paperwork":          "handled all the paperwork smoothly",
    "an easy emi process":       "made the EMI process simple",
    "helpful staff":             "had friendly, helpful staff",
    "a knowledgeable executive": "had a knowledgeable sales executive",
    "genuine tvs parts":         "used genuine TVS parts",
    "timely service":            "serviced my vehicle on time",
  };
  return clauses[topic] || `made ${topic} stand out`;
}

function getReviewTopicClause(topic) {
  const clauses = {
    "a new bike purchase":       "helped me find and buy the right bike",
    "a new scooter purchase":    "helped me choose and buy a new scooter",
    "the test ride experience":  "arranged a smooth test ride",
    "the best price":            "offered a genuinely good deal",
    "quick delivery":            "delivered on time",
    "smooth paperwork":          "handled all the paperwork without hassle",
    "an easy emi process":       "made the EMI process really simple",
    "helpful staff":             "had friendly, helpful staff",
    "a knowledgeable executive": "had a sales executive who really knew the bikes",
    "genuine tvs parts":         "used genuine TVS parts throughout",
    "timely service":            "completed the service on time",
  };
  return clauses[topic] || `made ${topic} stand out`;
}

function getReviewTopicNounPhrase(topic) {
  const phrases = {
    "a new bike purchase":       "a smooth bike-buying experience",
    "a new scooter purchase":    "a smooth scooter-buying experience",
    "the test ride experience":  "a great test ride",
    "the best price":            "a competitive price",
    "quick delivery":            "quick delivery",
    "smooth paperwork":          "smooth paperwork",
    "an easy emi process":       "a hassle-free EMI process",
    "helpful staff":             "helpful staff",
    "a knowledgeable executive": "a knowledgeable executive",
    "genuine tvs parts":         "genuine TVS parts",
    "timely service":            "timely service",
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
    "New Bike Purchase":       "a new bike purchase",
    "New Scooter Purchase":    "a new scooter purchase",
    "Test Ride Experience":    "the test ride experience",
    "Best Price/Deal":         "the best price",
    "Quick Delivery":          "quick delivery",
    "Smooth Paperwork":        "smooth paperwork",
    "Easy EMI Process":        "an easy EMI process",
    "Helpful Staff":           "helpful staff",
    "Knowledgeable Executive": "a knowledgeable executive",
    "Genuine Parts":           "genuine TVS parts",
    "Timely Service":          "timely service",
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
      `Visited ${business} for a new TVS and had a smooth experience.`,
      `${business} handled the whole purchase process professionally.`,
      `Good experience at ${business} in Pune.`,
      `${business} is a reliable TVS dealership in Pune.`,
      `The team at ${business} kept things organised throughout.`,
      `Purchased my TVS from ${business} and the process was straightforward.`,
    ],
    Enthusiastic: [
      `${business} genuinely impressed me from the moment I walked in.`,
      `The team at ${business} made buying a TVS so easy.`,
      `Had a fantastic experience at ${business} in Pune.`,
      `Really happy with my experience at ${business}.`,
      `${business} is easily the best TVS showroom in Pune.`,
      `Loving my new TVS — buying from ${business} was a great decision.`,
    ],
    Appreciative: [
      `Thankful for the helpful team at ${business}.`,
      `${business} took great care of us throughout the purchase.`,
      `I really valued the patience and honesty of the staff at ${business}.`,
      `The team at ${business} was thoughtful and genuinely helpful.`,
      `Grateful for the smooth experience at ${business} in Pune.`,
      `${business} made what can be a stressful process really easy.`,
    ],
  };
  return openings[tone] || openings.Professional;
}

function getNaturalTopicPhrase(topic) {
  const phrases = {
    "a new bike purchase":       "buying my new TVS bike here was a smooth experience",
    "a new scooter purchase":    "picking up my new scooter was a smooth process",
    "the test ride experience":  "the test ride was well arranged with no pressure",
    "the best price":            "they gave me a genuinely good deal",
    "quick delivery":            "delivery was quick and right on time",
    "smooth paperwork":          "the paperwork was handled without any hassle",
    "an easy emi process":       "the EMI process was simple and clear",
    "helpful staff":             "the staff were friendly and actually helpful",
    "a knowledgeable executive": "the sales executive really knew every model",
    "genuine tvs parts":         "they used genuine TVS parts throughout",
    "timely service":            "my vehicle was serviced and returned on time",
  };
  return phrases[topic] || `${topic} stood out`;
}

function getFallbackOutcomes(tone) {
  const outcomes = {
    Professional: [
      "the whole purchase experience felt smooth and straightforward",
      "the delivery was on time and the paperwork was hassle-free",
      "the billing was clear and pricing was transparent",
      "everything was handled professionally from test ride to delivery",
      "I am satisfied with the overall buying experience",
      "I would recommend them to anyone looking for a TVS in Pune",
    ],
    Enthusiastic: [
      "the whole process was quick and hassle-free",
      "my new TVS was delivered ahead of schedule",
      "the experience was honestly fantastic",
      "I left the showroom really happy",
      "it was easily the best TVS dealership experience in Pune",
      "I will definitely come back for my next TVS",
    ],
    Appreciative: [
      "I really appreciated how smoothly everything was handled",
      "the team made the whole buying process feel easy",
      "it felt good to be taken care of so well",
      "the patience and honesty of the staff really stood out",
      "I am grateful for a dealership experience this good",
      "the experience left me genuinely satisfied and confident in my purchase",
    ],
  };
  return outcomes[tone] || outcomes.Professional;
}

function getNoTopicFallbackOptions(mode, tone, business) {
  const options = {
    Professional: {
      short: [`Good experience at ${business} in Pune.`, `${business} handled the visit well.`],
      medium: [
        `Good experience at ${business}. The whole visit felt smooth, comfortable, and professionally handled.`,
        `${business} in Pune left a positive impression. Everything felt easy, clear, and well managed.`,
      ],
      long: [
        `Visited ${business} in Pune and had a genuinely good experience. The team made the visit feel smooth and comfortable, and the overall process left a positive impression. It felt like a dependable place to buy a TVS.`,
      ],
    },
    Enthusiastic: {
      short: [`Really good experience at ${business}!`, `Great showroom visit at ${business} in Pune.`],
      medium: [
        `Really happy with ${business}. The whole experience felt easy, welcoming, and genuinely pleasant.`,
        `Had a very nice experience at ${business} in Pune. The team made the visit feel smooth and comfortable from start to finish.`,
      ],
      long: [
        `Had a fantastic experience at ${business} in Pune. The atmosphere was welcoming, the team was pleasant to deal with, and the whole visit felt smooth from beginning to end. I came away feeling genuinely happy with the experience.`,
      ],
    },
    Appreciative: {
      short: [`Grateful for the kind experience at ${business}.`, `${business} made the visit feel comfortable.`],
      medium: [
        `I really appreciated the experience at ${business}. The whole visit felt calm, easy, and thoughtfully handled.`,
        `${business} made the experience feel genuinely comfortable. The team was courteous and easy to deal with throughout.`,
      ],
      long: [
        `I am really grateful for the experience at ${business} in Pune. The team made the whole visit feel comfortable and well handled, and the overall experience stayed smooth from start to finish. It felt like a place that genuinely values customers.`,
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
      "A genuinely good experience at Shelar TVS.",
      "A smooth and pleasant showroom visit.",
      "The whole experience felt easy and comfortable.",
    ]
    : [
      "The whole experience felt smooth, comfortable, and easy to appreciate.",
      "A genuinely positive visit that felt well handled from start to finish.",
      "The team made the showroom experience feel easy and welcoming.",
      "A pleasant overall experience with a calm and comfortable process.",
      "A reliable showroom experience that left a good impression.",
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

function getRotatingTone(attempt = 0) {
  const configuredTone = normalizeReviewToneValue(config.aiTone || document.querySelector("#reviewTone")?.value || "Enthusiastic");
  const cycle = [configuredTone, ...reviewToneCycle.filter((tone) => tone !== configuredTone)];
  return cycle[(state.generationCount + attempt) % cycle.length];
}

function normalizeReviewToneValue(tone) {
  return reviewToneCycle.includes(tone) ? tone : "Enthusiastic";
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

function isReviewQualityAcceptable(candidate, topics = []) {
  return !hasExactReviewMatch(candidate)
    && !hasOpeningSentenceMatch(candidate)
    && !hasRepeatedSentenceMatch(candidate)
    && !hasAwkwardReviewWording(candidate)
    && !hasOverusedAnchorWords(candidate)
    && !hasSeoOveroptimization(candidate)
    && !hasTemplateLikeRepetition(candidate)
    && !hasUniversalNoSelectionRisk(candidate, topics)
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

function hasOverusedAnchorWords(candidate) {
  const normalized = String(candidate || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const anchors = ["pleasant", "smooth", "professional", "welcoming", "comfortable", "friendly", "helpful", "great"];
  const matched = anchors.filter((word) => normalized.includes(word));
  return matched.length >= 3;
}

function hasSeoOveroptimization(candidate) {
  const normalized = String(candidate || "").toLowerCase().replace(/\s+/g, " ").trim();
  const exactPhrases = [
    "shelar tvs",
    "tvs showroom pune",
    "tvs service in pune",
    "tvs service pune",
    "genuine tvs parts",
    "tvs bike service pune",
    "best tvs deals pune",
    "apache near me",
    "jupiter near me",
  ];
  const phraseHits = exactPhrases.filter((phrase) => normalized.includes(phrase)).length;
  const businessMentions = (normalized.match(/\bshelar tvs\b/g) || []).length;
  const puneMentions = (normalized.match(/\bpune\b/g) || []).length;
  return phraseHits > 2 || businessMentions > 1 || puneMentions > 1;
}

function hasTemplateLikeRepetition(candidate) {
  const normalized = String(candidate || "").toLowerCase().replace(/\s+/g, " ").trim();
  const blockedPatterns = [
    /\bit is (always a )?(pleasure|relief) to find\b/,
    /\bi (felt|feel) (genuinely |truly )?(valued|special)\b/,
    /\bit is clear (that )?they (truly )?value\b/,
    /\bthe entire process felt\b/,
    /\bmy visit to shelar tvs was\b/,
    /\bi had a (really |very )?pleasant (visit|experience)\b/,
  ];
  return blockedPatterns.some((pattern) => pattern.test(normalized));
}

function hasUniversalNoSelectionRisk(candidate, topics) {
  if (Array.isArray(topics) && topics.length) {
    return false;
  }

  const normalized = String(candidate || "").toLowerCase().replace(/\s+/g, " ").trim();
  const blockedPhrases = [
    "felt genuinely valued",
    "truly valued",
    "truly special",
    "always a pleasure",
    "a relief to find",
    "thrilled",
    "delighted",
    "beyond expectations",
    "went above and beyond",
    "made my day",
    "truly respects their customers",
    "best place",
    "best showroom",
    "best service center",
    "my bike",
    "my scooter",
    "delivery time",
    "ahead of schedule",
    "well ahead of schedule",
    "test ride",
    "emi",
    "paperwork",
    "workshop",
    "servicing",
    "service center",
    "repair",
    "billing",
    "offers",
    "parts",
  ];

  if (blockedPhrases.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const subjectiveClaims = [
    /\bi will definitely come back\b/,
    /\bi will definitely return\b/,
    /\bi would definitely recommend\b/,
    /\bit is rare to find\b/,
    /\bit is great to have\b/,
    /\beverything went exactly as expected\b/,
    /\bfrom start to finish\b/,
  ];

  return subjectiveClaims.some((pattern) => pattern.test(normalized));
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
  return `reviewFunnelRecentSuggestions:${appContext.namespace || "root"}:${config.businessId}:${config.branchId}:${config.qrCodeId}`;
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

function getVehicleModel() {
  return sanitizeVehicleModel(state.vehicleModel);
}

function sanitizeVehicleModel(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s.'+/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
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
  if (/^ChI[A-Za-z0-9_-]+$/.test(place)) {
    return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(place)}`;
  }
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
    const response = await fetch(apiUrl("/api/events"), {
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

function resolveAppContext() {
  const path = window.location.pathname;
  if (path.startsWith("/eesweb/")) {
    return { namespace: "/eesweb" };
  }
  if (path.startsWith("/shelar/")) {
    return { namespace: "/shelar" };
  }
  return { namespace: "" };
}

function apiUrl(pathname) {
  return `${appContext.namespace}${pathname}`;
}
