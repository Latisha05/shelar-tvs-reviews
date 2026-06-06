# Shelar TVS — Review Funnel

A mobile-first QR review page for **Shelar TVS**, a TVS two-wheeler sales and service dealership in Pune. It routes happy customers toward Google Reviews (boosting local SEO) and collects unhappy-customer feedback privately so it never reaches Google.

## What is built now

- One-click 1 to 5 rating flow, branded in TVS blue and red.
- Ratings 4 and 5 show an editable, SEO-aware AI review suggestion that naturally mentions Shelar TVS, TVS service in Pune, genuine parts, helpful staff, timely service, and quick delivery.
- Optional **"Staff who helped you?"** field on the positive step, woven naturally into the generated review.
- Copy review button plus direct Google review redirect.
- Ratings 1 to 3 show a private feedback form (Service Delay, Parts Issue, Billing Problem, Staff Behavior, Waiting Time).
- Multiple branches supported via the dynamic QR system (`/r/{qrCodeId}`) — print one QR per branch.
- Firestore event storage through the local Node server / Cloudflare Pages Functions.
- OpenRouter review generation using `meta-llama/llama-3.2-1b-instruct`, with an automotive fallback review if the API is unavailable.

## Local SEO

The review prompt is tuned so 4–5 star customers post genuine-sounding Google reviews that include locally relevant phrases (the business name, "TVS service in Pune", "bike servicing", "genuine TVS parts", staff names, etc.) without sounding like an ad. Over time this strengthens the dealership's Google Business Profile ranking for those searches. Negative experiences are diverted to the private feedback form instead of Google.

Run the local server, then open `http://127.0.0.1:5500`.
Use `http://127.0.0.1:5500/dashboard.html` to edit clone-friendly business, QR, topic, and review prompt settings.

## OpenRouter Review Generation

Add your real OpenRouter key to `.env` only:

```text
OPENROUTER_API_KEY="sk-or-v1..."
OPENROUTER_MODEL="meta-llama/llama-3.2-1b-instruct"
```

Do not paste the real key into `.env.example`; that file is only a shareable template. For Cloudflare Pages, set `OPENROUTER_API_KEY` as a secret instead of committing it.

If OpenRouter is unavailable or the key is missing, the page still generates a built-in fallback review.

## Environment File

`.env` has been created for your real keys. Keep it private. Use `.env.example` as the shareable template.

Important values:

- `GOOGLE_PLACE_ID`: used to build `https://g.page/r/[PLACE_ID]/review`.
  Leave this blank while testing AI review generation only.
- `REVIEW_TOPICS`: comma-separated 2-3 word positive review parameters for a specific client.
- `FEEDBACK_TOPICS`: comma-separated 2-3 word private feedback issue parameters for a specific client.
- `OPENROUTER_API_KEY`: paste your real `sk-or-v1...` key in `.env` only.
- `OPENROUTER_MODEL`: defaults to `meta-llama/llama-3.2-1b-instruct`.
- `REVIEW_SYSTEM_PROMPT`: controls the AI review style without editing code.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`: used by `server.js` to write Firestore securely.
  You can also paste the full Firebase service account JSON at the bottom of `.env`; `server.js` will read it automatically.
- WhatsApp values: needed later for owner alerts and customer messages.

## Run Locally

```bash
node server.js
```

Open:

```text
http://127.0.0.1:5500
```

Local dashboard:

```text
http://127.0.0.1:5500/dashboard.html
```

Dynamic QR target:

```text
http://127.0.0.1:5500/r/shelar-tvs-main
```

Use this URL inside any dynamic QR provider. The printed QR should point to `/r/{qrCodeId}`, not directly to `/`.
Later, you can change the redirect behavior in the app without changing the printed QR code.

### Multiple branches

Create one QR code per branch in the dashboard (QR Links), each with its own `qrCodeId`, branch name, and optional staff/source label, e.g. `/r/shelar-tvs-wakad`, `/r/shelar-tvs-hadapsar`. Each scan is tracked against its branch so the dashboard can break down ratings, reviews, and feedback per location.

## Dashboard

The dashboard edits safe `.env` settings only:

```text
Business name
Business, branch, and QR IDs
Google Place ID
Positive review parameters
Private feedback parameters
OpenRouter model
Review system prompt
```

Firebase service account values are not exposed in the dashboard. Keep the dashboard local until auth is added.

## Firestore Setup

1. Create a Firebase project at `console.firebase.google.com`.
2. Add a web app inside the Firebase project.
3. Copy the Firebase config values into `.env`.
4. Enable Firestore Database in production mode.
5. Create a Firebase service account key:
   - Firebase Console -> Project settings -> Service accounts.
   - Click Generate new private key.
   - Copy `client_email` to `FIREBASE_CLIENT_EMAIL`.
   - Copy `private_key` to `FIREBASE_PRIVATE_KEY`.
   - Or paste the full downloaded JSON object at the bottom of `.env`.
6. Seed the base business, branch, and QR documents:

```bash
node server.js --bootstrap
```

Firestore collections are created automatically when documents are written.

Use these collections:

```text
businesses/{businessId}
branches/{branchId}
qrCodes/{qrCodeId}
ratings/{ratingId}
feedback/{feedbackId}
reviewEvents/{eventId}
postedReviews/{postedReviewId}
```

Suggested document fields:

```json
{
  "businessId": "abc",
  "branchId": "ravet",
  "qrCodeId": "eesweb-main-campaign",
  "source": "support-desk",
  "rating": 5,
  "reviewText": "Only saved when customer clicks Google review or I posted it",
  "issues": ["Delay", "Service issue"],
  "message": "Feedback message",
  "customer": {
    "name": "Optional",
    "phone": "Optional"
  },
  "createdAt": "server timestamp"
}
```

Minimum Firestore security idea:

```text
- Public users can only create ratings and feedback.
- Public users cannot read dashboard data.
- Business owners can only read their own business documents.
- Super admin can read all documents.
```

Use Firebase Auth custom claims later for `superAdmin`, `businessOwner`, and `staff` roles.

## Simpler Database Recommendation

For the first working SaaS version, Supabase Postgres is simpler than Firestore because this app has relational data:

- Businesses have many branches.
- Branches have many QR codes.
- QR codes can map to branches, staff members, service sources, and campaigns.
- Dashboards need filters, counts, averages, date ranges, and conversion rates.

Suggested MVP tables:

```text
businesses
branches
staff
qr_codes
ratings
feedback
review_events
posted_reviews
```

Use Firestore if you want Firebase hosting, quick realtime updates, and simple document writes. Use Supabase or Postgres if you want cleaner analytics, SQL reports, subscriptions, and easier multi-tenant dashboard queries.
