# Voyara

Travel operations platform. Navi proposes, the platform validates, the traveller
approves, the workflow executes, the audit log proves.

This repo is the deployable version of the investor demo. The traveller app is a
single static file. Everything that needs a secret runs server side.

---

## Deploy in about five minutes

You need a GitHub account and a Vercel account. Both free to start.

1. Put this folder in a GitHub repository.
2. Go to vercel.com, click **Add New, Project**, and import that repository.
3. Vercel detects Next.js on its own. Click **Deploy**. Change nothing.
4. Open the URL it gives you. The whole app works immediately, in mock mode.

There is no step five. Credentials come later, one at a time.

### Alternative, no GitHub

```bash
npx vercel
```

Answer the prompts. It deploys from this folder directly.

---

## Mock mode and live mode

With no environment variables set, every supplier falls back to fixtures and the
app runs end to end. Check what is live at any time:

```
GET /api/health
```

```json
{ "providers": { "air": "mock", "stays": "mock", "status": "mock", "payments": "mock" } }
```

Add a credential in Vercel under **Settings, Environment Variables**, redeploy,
and that one provider flips to `live`. Nothing else changes. See `.env.example`
for the full list.

**Turn things on in this order:**

1. `DUFFEL_TOKEN` (test token from dashboard.duffel.com). Air search goes live.
   Duffel Managed Content means you sell on their accreditation, so you do not
   need your own IATA or ARC to start.
2. `HOTELBEDS_API_KEY` and `HOTELBEDS_SECRET`. Hotels go live. This is the
   margin engine, because airlines pay close to nothing.
3. `AEROAPI_KEY`. Real flight status, which drives the disruption workflow.
4. `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID`. Memberships become real money.

---

## Verify before trusting a real card

The three supplier adapters were written to each vendor's documented request and
response shape, but they were **not executed against those vendors' servers**
when this repo was built, because the build environment has no outbound access to
them. Before any live booking, run these and read the output:

```bash
curl "$SITE/api/health"
curl "$SITE/api/flights/search?origin=JFK&destination=MIL&departOn=2026-09-12"
curl "$SITE/api/stays/search?destination=Milan&checkIn=2026-09-13&checkOut=2026-09-18&guests=2"
curl "$SITE/api/status?ident=AZ631"
```

If `mode` says `live:duffel` and offers come back with sane prices, the adapter is
correct. If it returns `supplier_unavailable`, the detail field carries the
vendor's own error, which is usually a version header or a field name. Confirm
`DUFFEL_VERSION` against Duffel's current docs first, since that is the most
likely mismatch.

---

## Why the money maths lives on the server

`lib/rate.ts` computes the rebate. It runs only in API routes, never in the
browser. The traveller sees the net price, but cannot change what Voyara keeps by
opening dev tools. Percentages are configured by environment variable, so the
commercial model can be tuned without a code change.

All money is integer minor units. Never floats.

---

## Layout

```
app/api/health          what is live right now
app/api/flights/search  Duffel, or fixtures
app/api/stays/search    Hotelbeds, or fixtures
app/api/status          AeroAPI, or fixtures
app/api/checkout        Stripe membership subscription
app/api/audit           SHA-256 hash chained audit records
lib/env.ts              every environment variable, read in one place
lib/rate.ts             the commercial model
lib/audit.ts            hash chain and verification
lib/providers/          one adapter per supplier, one router
prisma/schema.prisma    the Release 1 data model, not yet wired
public/app.html         the traveller and operator app
```

## What is not built yet

Honest list, in the order it matters:

- **Persistence.** The API routes are stateless. `prisma/schema.prisma` is the
  agreed target. Provision Postgres in Vercel Storage, set `DATABASE_URL`, run
  `npx prisma migrate dev`.
- **Authentication.** No accounts, no sessions, no passkeys. The approval flow in
  the app is simulated until this lands.
- **Booking.** Search is real once credentials are set. Actually issuing a ticket
  or confirming a room is a separate route and a separate conversation with each
  supplier, and it needs idempotency keys and a verification read after write.
- **Durable workflows.** The spec calls for Temporal. Nothing here is durable yet,
  so a crash mid execution has no recovery.
- **Email ingestion.** The import pipeline in the app is simulated.
- **Webhooks.** Stripe subscription lifecycle is not handled, so memberships do
  not yet expire or renew in any system of record.

## Before taking real money

- Seller of Travel registration for California, Florida, Hawaii, Iowa and
  Washington residents. California reaches the furthest.
- Errors and omissions insurance.
- Terms of service, privacy policy, and a data processing posture for EU
  travellers.
