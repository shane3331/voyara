# Voyara . what is live and what is next

## Turning things on

Everything runs with no credentials. Each environment variable you add in
Vercel flips one provider from mock to live. Check what is on at any time:

    /api/health

Add variables at:
Vercel . Settings . Environment Variables . then Redeploy

| Variable | Turns on | Where to get it |
|---|---|---|
| `DUFFEL_TOKEN` | Flight search | dashboard.duffel.com |
| `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` | Waitlist and persisted audit chain | Supabase . Project Settings . API |
| `AEROAPI_KEY` | Real flight status | flightaware.com/aeroapi |
| `LITEAPI_KEY` | Real hotels today. Free sandbox, no paperwork. | liteapi.travel |
| `HOTELBEDS_API_KEY` and `HOTELBEDS_SECRET` | Hotel net rates, the margin engine | developer.hotelbeds.com |
| `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` | Membership payments | dashboard.stripe.com |
| `SITE_URL` | Correct redirect back from Stripe | your own domain, optional |
| `ALLOW_LIVE_BOOKING` | Real purchases, air and hotel. Leave unset until ready. | set to `true` by hand |
| `VOYARA_MARKUP` | What Voyara adds to the net rate. Default 0.04 | your call |
| `CRON_SECRET` | Locks the scan endpoint. Set this. | invent a long random string |
| `SUPABASE_ANON_KEY` | Sign in. Public key, bounded by row level security. | Supabase . Settings . API |
| `INBOUND_SECRET` | Locks the inbound email endpoint | invent a long random string |
| `CASH_EARN_AIR` | Cash earned on flights. Default 0.02 | your call |
| `CASH_BURN_CAP` | Share of a stay Cash can cover. Default 0.30 | your call |
| `CASH_EARN_CAP_MINOR` | Annual earn cap. Default 25000 | your call |
| `CASH_EXPIRY_MONTHS` | Default 24 | your call |
| `WATCH_DISRUPT_MINUTES` | Delay that opens a disruption. Default 45 | your call |
| `RECOVER_STALE_MINUTES` | How long before a run counts as stranded. Default 10 | your call |
| `RECOVER_MAX_ATTEMPTS` | Give up to a human after this many. Default 8 | your call |
| `WATCH_AUTO_REBOOK` | `true` allows automatic rebooking in the refund window | leave unset until proven |
| `WATCH_MIN_BENEFIT_MINOR` | Ignore drops below this. Default 2000 (twenty dollars) | your call |

## Database setup, five minutes

1. Supabase . SQL Editor . New query
2. Paste all of `supabase-setup.sql` . Run
3. Supabase . Project Settings . API . copy the **Project URL** and the
   **service_role** key (the secret one, not anon)
4. Add both to Vercel as `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
5. Redeploy

The service role key must only ever live in Vercel. It bypasses row level
security, which is fine on the server and catastrophic in a browser.

## Routes

| Route | Does |
|---|---|
| `GET /api/health` | What is live right now |
| `GET /api/waitlist` | Public signup count |
| `POST /api/waitlist` | Capture a lead |
| `GET /api/audit` | The persisted chain plus verification |
| `POST /api/audit` | Append a record |
| `GET /api/flights/search` | Search flights |
| `GET /api/flights/offer` | Re-price one offer before purchase |
| `POST /api/flights/book` | Buy a ticket. Idempotent, verified after write. |
| `GET /api/stays/search` | Search hotels. Hotelbeds if set, else LiteAPI, else fixtures. |
| `GET /api/stays/hotel` | One property: photos, description, amenities, every bookable room |
| `POST /api/stays/book` | Book a room. Prebook, idempotent, verified after write. |
| `GET /api/watch/run` | Cron target. Scans watched flights for price drops. |
| `GET /api/watch/orders` | Watched bookings and their scan history |
| `POST /api/watch/orders` | Start watching a booking |
| `GET /api/collections` | Curated destinations. Add `?slug=x` for one. |
| `GET /api/signature` | Curated luxury properties for a destination |
| `POST /api/signature` | Request a property not in live inventory |
| `GET /api/trips` | A traveller's trips and reservations |
| `POST /api/trips` | Create a trip, or attach a reservation to one |
| `POST /api/stays/cancel` | Cancel a booking. Preview first, then verified. |
| `GET /api/cash` | Voyara Cash balance and ledger |
| `POST /api/cash` | earn, burn, quote, reverse |
| `POST /api/auth` | Passwordless sign in, six digit code |
| `GET /api/config` | Public config for the browser |
| `POST /api/inbound/email` | Forwarded confirmations land here |
| `GET /api/recover` | Cron. Reconciles anything left stranded. |
| `GET /api/villas` | The curated villa collection |
| `POST /api/villas` | A request to book a villa |
| `GET /api/status` | Flight status |
| `POST /api/checkout` | Start a membership subscription |
| `POST /api/stripe-webhook` | Stripe tells us a membership started, renewed, lapsed or was refunded |

## Still not built

- **Authentication.** No accounts, no sessions. The approval flow is simulated.
- **Email ingestion.** The import pipeline in the app is a simulation.
- **Stripe webhooks.** Memberships do not renew or expire in any record.
- **Refund and cancellation.** Booking exists. Undoing a booking does not.
- **Durable workflows.** A crash mid execution has no recovery.

## Before taking real money

- Seller of Travel registration: California, Florida, Hawaii, Iowa, Washington
- Errors and omissions insurance
- Terms of service and privacy policy published
- A refund path you have tested, not just a booking path


## Stripe setup

1. dashboard.stripe.com . sign up
2. **Products** . Add product . name it Voyara Signature . price it as a
   **recurring** yearly amount . Save. Copy the **price ID**, it starts `price_`
3. **Developers . API keys** . copy the **Secret key**, it starts `sk_test_`
4. In Vercel add `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` . Redeploy
5. **Developers . Webhooks . Add endpoint**
   - URL: `https://YOUR-DOMAIN/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `charge.refunded`
6. Test with card `4242 4242 4242 4242`, any future expiry, any CVC

Stay in test mode until you can answer, in writing, what a member gets and when.

### How the webhook proves an event is real

It does not trust the posted body. It takes the event id and re-fetches that
event from Stripe using the secret key. A forged payload dies at that lookup
because the id will not exist. Every event id is also written to
`webhook_events`, whose primary key rejects Stripe's retries, so a membership
cannot be activated twice.


## Hotels

Three routes, in the order they get you furthest:

1. **LiteAPI** at liteapi.travel. Free sandbox, no paperwork, and their sandbox
   is the same surface as production. Set `LITEAPI_KEY` and hotel search is
   real the same day. Start here.
2. **Hotelbeds** at developer.hotelbeds.com. Sandbox access on registration.
   Net rates with no markup floor, meaning the retail price is genuinely yours
   to set rather than a commission you rebate afterwards. This is the margin
   engine, and the code prefers it automatically once its keys are set.
3. **Amadeus Self-Service** if you want a third source later.

Optional LiteAPI tuning: `LITEAPI_COUNTRY`, `LITEAPI_CURRENCY`,
`LITEAPI_NATIONALITY`, `LITEAPI_BASE`.

## Villas

There is no self serve villa API worth using. The properties in aggregator
feeds are not the properties a member wants, which is why Le Collectionist,
Onefinestay and Plum Guide are curated businesses rather than API businesses.

So villas are a curated collection with a request to book flow. Requests land
in `villa_requests` and an operator confirms availability and quotes before
anything is charged.

**Adding a real villa takes no code.** Supabase . Table Editor . `villas` .
Insert row. Fill in slug, name, location, bedrooms, sleeps, nightly_minor
(in cents), and an `image_id`. It appears on the site immediately.

`commission_pct` and `keep_pct` are per property, so a villa where you have
negotiated 20% can return more to the traveller than one at 12%.

The eight seed properties are placeholders. Replace them as you sign real ones.


## How hotel pricing actually works

LiteAPI and Hotelbeds are net rate suppliers. They do not pay a commission,
they sell wholesale and let you set retail. So the numbers on a property page
are not a rebate, they are arithmetic:

    cost    what Voyara pays the supplier      (supplier's offerRetailRate)
    market  what an OTA charges for that room  (supplier's suggestedSellingPrice)
    yours   cost plus VOYARA_MARKUP, 4% by default
    saving  market minus yours

Every one of those four numbers is shown to the traveller on the room
breakdown, including what Voyara keeps. If a supplier only returns one of the
two prices, the other is derived from `RATE_HOTEL_COMMISSION` and the response
marks `basis: "derived"` so you always know which numbers are real.

## The booking flow

    search   /api/stays/search    live rates for a city
    property /api/stays/hotel     photos, rooms, per room pricing
    book     /api/stays/book      prebook, book, verify

`prebook` revalidates the rate with the hotel before anything is charged. If it
moved, the traveller is told and nothing happens. Booking requires an
idempotency key, so a retry cannot book two rooms, and the booking is retrieved
back from the supplier and compared before it is called confirmed.

A production LiteAPI key alone cannot take money. `ALLOW_LIVE_BOOKING` must also
be set to `true` deliberately.


## Collections

A collection is editorial framing around a real destination. It stores no
prices of its own on purpose: opening one pushes its destination and dates into
the search and runs a live query, so the copy can sit unchanged for months while
the rates are never more than a second old.

Dates are stored as `lead_days` and `nights` rather than fixed dates, so a
collection can never offer a date in the past. "Meet me in the Cyclades" with
`lead_days 60, nights 6` always opens sixty days out for six nights.

**Adding a collection takes no code.** Supabase . Table Editor . `collections` .
Insert row. Fill in slug, title, subtitle, destination, narrative, image_id,
nights, lead_days. It appears on the home page immediately.

The `destination` must be a place the search can resolve. The resolver knows 155
cities plus country names and handles "Positano", "milan, italy" and "Spain". If
you add somewhere unusual, search for it first and confirm results come back.


## Fare watch

Scans booked flights and captures a price drop where one can actually be
captured. Runs on a Vercel cron every two hours, configured in `vercel.json`.

### The constraint, stated plainly

Airlines do not refund a fare drop in cash. Hotels let you cancel free and
rebook, tickets do not work that way. There are three windows:

| Window | When | What you get |
|---|---|---|
| `VOID_WINDOW` | Within 24h of booking, 7+ days before departure | Full refund. US DOT requires it. Rebook clean, cash back. |
| `CREDIT` | After that | The difference comes back as airline credit, not money. Needs the traveller to decide. |
| `SCHEDULE` | Airline moves the flight materially | Rebooking or refund rights regardless of fare rules. |

Every scan records which window applied, so an action is always explainable
after the fact.

### What counts as a drop

Only the **same flight numbers, same cabin, no extra stops, and no loss of
baggage**. A cheaper connection through a different city at 6am is not a better
trip and is never presented as one. That comparison lives in `sameFlights()` and
the filter above it in `api/watch/run.js`.

A drop is acted on automatically only when all of these hold:

1. Same flight numbers
2. Inside the refund window
3. Benefit above `WATCH_MIN_BENEFIT_MINOR`
4. `WATCH_AUTO_REBOOK` is explicitly `true`

Anything else becomes a proposal. Proposals are idempotent on booking, price and
window, so a scan running twice cannot create two of them or rebook twice.

### Setup

1. Re-run `supabase-setup.sql`
2. Set `CRON_SECRET` in Vercel to a long random string
3. Deploy. Vercel registers the cron from `vercel.json` automatically
4. Confirm under Vercel . your project . Cron Jobs

Leave `WATCH_AUTO_REBOOK` unset until you have watched it propose correctly for
a few weeks. Cancelling a real ticket automatically is the highest risk action
in this codebase.


## What happens after a booking

A verified hotel booking writes a trip. This happens server side inside
`api/stays/book.js`, not in the browser, so a closed tab cannot lose it.

    book -> verify against the supplier -> file a trip -> appears in Your Trips

A second booking for the same traveller and the same start date joins the
existing trip rather than creating a duplicate, and reservations are deduped by
their supplier reference. Nobody thinks of a flight and a hotel in the same week
as two separate trips.

If filing the trip fails, the booking still succeeds and still reports success.
The traveller has a confirmed room either way, and a bookkeeping failure must
never be presented as a booking failure.

## Still not built

Honest list, in the order it matters:

- **Refund and cancellation.** You can book. You cannot undo a booking. Build
  this before real money.
- **Authentication.** No accounts, no sessions. Approvals are simulated.
- **Email ingestion.** The import pipeline in the app is a simulation.
- **Voyara Cash earn and burn.** Designed, not built.
- **Flight status.** Still simulated. Needs an AeroAPI key.
- **Durable workflows.** A crash mid execution has no recovery.


## Voyara Cash

**Earn on air, burn on stays.** Airlines pay roughly one percent, so a flight
reward cannot fund itself. It is funded by hotel margin, which is why Cash is
earned on flights and only spendable against rooms. That one rule is what makes
it self funding rather than a giveaway.

- Earn 2% on air, credited after travel
- Redemption capped at 30% of a stay, so it can never wipe out the margin on a
  single booking
- Expires after 24 months, which bounds the liability
- Annual earn cap, so a member who books flights and never rooms cannot drain it
- Closed loop, never withdrawable as money, which keeps it clear of money
  transmitter licensing
- Reversed automatically when a booking is cancelled

Watch hotel attach rate per member from week one. If it sits below about 60%,
the air earn is pure acquisition cost and the rate wants cutting.

## Cancellation

    preview -> read the policy -> show the refund -> cancel -> verify

The traveller always sees the number before deciding. A refund they did not
expect is a complaint whichever direction it goes in. Cancelling is idempotent,
verified by retrieving the booking afterwards, and an ambiguous supplier
response is never retried blindly. Cash earned on the booking is reversed at the
same time.

## Sign in

Passwordless. Six digit code by email through Supabase Auth, proxied through
`/api/auth` so the anon key is never needed in the browser.

1. Supabase . Authentication . Providers . enable **Email**
2. Copy the **anon** key from Settings . API
3. Set `SUPABASE_ANON_KEY` in Vercel

Trips, Voyara Cash and fare watches all scope to the signed in address.

## Forwarded confirmations

Point any inbound email provider at `POST /api/inbound/email`. It accepts the
shapes Postmark, Resend, SendGrid, Mailgun and CloudMailin post, because they
all name the same three fields differently.

Set `INBOUND_SECRET` and send it as an `X-Inbound-Secret` header.

The content hash is the primary key, so the same forward twice cannot create two
reservations. Parsing is deliberately conservative: a reference is only taken
when the text says it is one AND the token contains a digit and is not an
English word. Anything under 0.65 confidence is stored but not filed, because a
half read confirmation is worse than none. The traveller will believe it.

## Flight status and disruptions

The same cron that watches fares also polls flight status when `AEROAPI_KEY` is
set. Every observation is recorded, so a delay is a fact with a timestamp rather
than a screenshot. A delay past `WATCH_DISRUPT_MINUTES`, a cancellation or a
diversion opens a disruption, and only one stays open per flight because a delay
that keeps growing is the same event, not a new one every two hours.


## Durability

A serverless function can die between calling a supplier and recording what
happened. That leaves a real booking nobody knows about, which is the worst
failure this system has.

So every route that spends money writes an execution record **before** touching
the supplier, and advances it after each step:

    STARTED -> SUPPLIER_CALLED -> VERIFIED -> COMPLETE
                               \-> AMBIGUOUS  (needs reconciliation)
                               \-> FAILED     (terminal, nothing happened)

`/api/recover` runs hourly, finds records that never reached a terminal state,
and asks the supplier what actually happened. Because every step is idempotent,
asking again is always safe. **The recovery pass never books, cancels or charges
anything.** It only reads and records.

A run that already completed cannot be repeated, so a retry with the same
idempotency key returns the original booking rather than making a second one.
After `RECOVER_MAX_ATTEMPTS` it stops trying and escalates to a person, because
a loop that retries forever is how a real problem stays invisible.

This is not Temporal. It is the pattern the spec's transactional outbox
gestures at, sized for a serverless deployment. If volume ever justifies a real
workflow engine, the execution table is the seam to swap behind.

## Legal pages

`legal.html` is a working draft of terms, privacy and cancellation, linked from
the footer. It makes the commercial model explicit: Voyara acts as an agent, the
supplier's cancellation policy governs, Voyara Cash is a promotional credit and
not money, and pricing discloses cost and margin.

**It has not been reviewed by a lawyer.** Before taking money: have counsel read
it, add your registered entity and address, governing law and jurisdiction, and
your Seller of Travel registration numbers.

## Turning on the last two features

**Sign in**

1. Supabase . Authentication . Providers . enable **Email**
2. Supabase . Settings . API . copy the **anon** key
3. Vercel . add `SUPABASE_ANON_KEY` . Redeploy

**Forwarded confirmations**

1. Pick an inbound provider. Resend, Postmark and CloudMailin all work.
2. Point an inbound address at `https://YOUR-DOMAIN/api/inbound/email`
3. Set `INBOUND_SECRET` in Vercel and configure the provider to send it as an
   `X-Inbound-Secret` header
4. Forward a real confirmation and check the `inbound_emails` table
