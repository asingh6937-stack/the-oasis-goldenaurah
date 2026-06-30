# The Oasis Landing Page Deployment

## Recommended path

Use Vercel for the production ad landing page. GitHub Pages can host the static page, but it cannot run the secure `/api/leads` backend needed for lead storage, WhatsApp notifications, rate limiting, CORS, and secret handling.

Netlify is also supported through `netlify.toml`, which routes `/api/leads` to `/.netlify/functions/leads`.

## Required production settings

Add these as server-side environment variables in Vercel or Netlify. Do not add real values to frontend code.

```bash
ALLOWED_ORIGINS=https://your-production-domain.com,https://asingh6937-stack.github.io

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
SUPABASE_LEADS_TABLE=leads

WHATSAPP_ACCESS_TOKEN=your-whatsapp-cloud-api-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_TO_NUMBER=918446860026

RESEND_API_KEY=re_your_key
EMAIL_FROM=The Oasis <leads@yourdomain.com>
EMAIL_TO=you@example.com
```

Optional alternatives/add-ons:

```bash
GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/your-script-id/exec
META_PIXEL_ID=your-meta-pixel-id
META_CAPI_ACCESS_TOKEN=your-meta-capi-token
```

## Supabase table

Create a private `leads` table. The backend uses the service-role key server-side, so the frontend never talks directly to Supabase.

```sql
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  budget text,
  plot_interest text,
  preferred_visit_date date,
  message text,
  source text,
  campaign text,
  ad_id text,
  landing_page text,
  timestamp timestamptz not null default now(),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  gclid text,
  fbclid text,
  purpose text,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;
```

## Google Ads and Meta setup

In `index.html`, replace:

- `AW-XXXXXXXXXX` with your Google Ads conversion ID.
- `XXXXXXXXXXXXXXX` with your Google Ads conversion label.
- `000000000000000` with your Meta Pixel ID.

The page fires:

- Google Ads conversion only after `/api/leads` returns success.
- Meta `Lead` only after `/api/leads` returns success.
- Meta `Contact` on WhatsApp clicks.
- Click events for WhatsApp, Call, Brochure, Site Visit, and Map actions.

## WhatsApp Cloud API

The backend sends a text message containing the lead details to `WHATSAPP_TO_NUMBER`. Make sure the number is allowed by your WhatsApp Business setup and that the access token has permission to send messages from `WHATSAPP_PHONE_NUMBER_ID`.

If WhatsApp delivery fails and Resend is configured, the backend sends a fallback email to `EMAIL_TO`.

## Final launch checklist

1. Deploy this repo to Vercel.
2. Add the environment variables above.
3. Create the Supabase table or configure `GOOGLE_SHEETS_WEBHOOK_URL`.
4. Replace Google Ads and Meta placeholders in `index.html`.
5. Update canonical, sitemap, robots, and Open Graph URLs if using a custom domain.
6. Submit a test enquiry and confirm Supabase/Sheets, WhatsApp, fallback email, Google conversion, and Meta Lead events.
