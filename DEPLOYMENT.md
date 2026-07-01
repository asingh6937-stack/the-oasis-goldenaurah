# The Oasis — Deployment

## Architecture

- **Frontend:** static `index.html` + `oasis/` images, served by Vercel. Unchanged.
- **Backend:** one Vercel serverless function at `/api/leads` (`api/leads.js` → `lib/leads-handler.js`).
- **Lead storage:** Wix CRM. Every submission is created as a contact in Wix Contacts.

The form posts JSON to `/api/leads` (same origin, so no CORS setup). The function
validates the input and creates a Wix contact server-side. The Wix API key is read
from an environment variable and is never sent to the browser.

There is no Supabase, no database to manage, and no CORS allow-list.

## Required environment variables (Vercel)

Set these in **Vercel → Project → Settings → Environment Variables**:

```bash
WIX_API_KEY=your-wix-api-key      # from https://manage.wix.com/account/api-keys
WIX_SITE_ID=your-wix-site-id      # required (Contacts is a site-level API)
# WIX_ACCOUNT_ID=your-account-id  # optional, only for account-level calls
```

The API key needs these permission scopes:
- **Manage Contacts** (required — creates the contact)
- **Manage Contact Labels** (optional — adds the Project / Lead Source / Platform tags)
- **Manage Contact Extended Fields** (optional — stores plot size, budget, purpose, visit date, requirements, and UTM attribution)

If the label/extended-field scopes are missing, the lead is still saved with name +
phone; only the extra tagging/detail is skipped. No lead is ever lost over a missing scope.

## What lands in Wix CRM

For each submission a contact is created with:
- **Name** and **mobile number** (structured contact fields).
- **Labels:** `Project: The Oasis`, `Lead Source: Oasis Landing Page`, `Platform: Vercel`.
- **Custom fields** (auto-created on first use, prefixed `The Oasis –`): Preferred Plot Size,
  Budget, Purchase Purpose, Preferred Visit Date, Additional Requirements, and a
  Marketing Attribution field holding UTM params, gclid, fbclid, landing page, and timestamp.

Labels and custom fields are created automatically via Wix's find-or-create endpoints
the first time a lead comes in, so there is no manual Wix schema setup.

## Google Ads and Meta setup

In `index.html`, in the `window.OASIS_CONFIG` block, replace:
- `AW-XXXXXXXXXX` with your Google Ads conversion ID.
- `XXXXXXXXXXXXXXX` with your Google Ads conversion label.
- `000000000000000` with your Meta Pixel ID.

The Google Ads conversion and Meta `Lead` events fire **only after** `/api/leads`
returns success. Meta `Contact` fires on WhatsApp clicks. WhatsApp buttons are unchanged.

## Response contract

- Success: `{ "ok": true }`
- Validation problem: `{ "ok": false, "error": "<clean, user-facing message>" }` (HTTP 400)
- Server/Wix failure: `{ "ok": false, "error": "Lead could not be submitted. Please WhatsApp us directly." }` (HTTP 500)

Raw Wix errors are logged server-side (never the API key) and are never shown to users.

## Launch checklist

1. Add `WIX_API_KEY` and `WIX_SITE_ID` in Vercel and redeploy.
2. Replace the Google Ads and Meta Pixel placeholders in `index.html`.
3. Submit a test enquiry on the live page and confirm the contact appears in
   Wix Contacts with the labels and custom fields populated.
4. Update canonical, sitemap, robots, and Open Graph URLs if you move to a custom domain.
