// The Oasis — lead capture handler.
//
// Every submission is stored as a contact in Wix CRM. All Wix calls happen
// server-side only; the Wix API key is read from environment variables and is
// never exposed to the browser.
//
// Required env vars (set in Vercel, never in source):
//   WIX_API_KEY   — API key from the Wix API Keys Manager
//   WIX_SITE_ID   — site ID (Contacts is a site-level API, so this is required)
//   WIX_ACCOUNT_ID — optional; only needed for account-level calls

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 8;
const rateLimitStore = new Map();

const WIX_API_BASE = 'https://www.wixapis.com';
const GENERIC_ERROR = 'Lead could not be submitted. Please WhatsApp us directly.';

// Frontend option codes -> human-readable values stored in Wix.
const PLOT_LABELS = {
  '3687': 'Approx. 3,687 sq.ft.',
  '4236': 'Approx. 4,236 sq.ft.',
  'any': 'Open to any available plot',
};
const BUDGET_LABELS = {
  '75-90': '₹75L – ₹90L',
  '90-110': '₹90L – ₹1.1 Cr',
  'above-110': '₹1.1 Cr+',
  'guidance': 'Needs budget guidance',
};
const PURPOSE_LABELS = {
  'bungalow': 'Private Bungalow',
  'investment': 'Long-Term Investment',
  'both': 'Both',
};

const ALLOWED_PLOTS = new Set(['', '3687', '4236', 'any']);
const ALLOWED_BUDGETS = new Set(['', '75-90', '90-110', 'above-110', 'guidance']);
const ALLOWED_PURPOSES = new Set(['', 'bungalow', 'investment', 'both']);

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

// ── HTTP response helpers ───────────────────────────────────────────────────
// Same-origin form post from the Vercel site: no origin allow/deny list, so the
// old "Origin not allowed" failure mode is gone. Headers stay permissive.
function responseHeaders(origin) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function json(status, body, origin) {
  return { status, headers: responseHeaders(origin), body: JSON.stringify(body) };
}

// ── Input sanitising & validation ───────────────────────────────────────────
function sanitize(value, max = 500) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizePhone(value) {
  return sanitize(value, 20).replace(/[^\d+]/g, '');
}

// Wix generates the E.164 number from a national number + country code, so give
// it the national digits when the number is clearly Indian. Storage never fails
// on this — a non-matching number is still saved as-is.
function toIndiaNationalNumber(normalizedPhone) {
  let digits = normalizedPhone.replace(/^\+/, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  return digits;
}

function isFutureOrToday(dateValue) {
  if (!dateValue) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return false;
  const selected = new Date(`${dateValue}T00:00:00Z`);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return !Number.isNaN(selected.getTime()) && selected >= today;
}

function normalizeLead(input) {
  const plot_interest = sanitize(input.plot_interest || input.plot, 30);
  const budget = sanitize(input.budget, 30);
  const purpose = sanitize(input.purpose, 30);
  return {
    name: sanitize(input.name, 80),
    phone: normalizePhone(input.phone),
    plot_interest,
    budget,
    purpose,
    plot_label: PLOT_LABELS[plot_interest] || 'Need expert recommendation',
    budget_label: BUDGET_LABELS[budget] || 'Not specified',
    purpose_label: PURPOSE_LABELS[purpose] || 'Not specified',
    preferred_visit_date: sanitize(input.preferred_visit_date || input.visit_date, 20) || '',
    message: sanitize(input.message, 1000),
    landing_page: sanitize(input.landing_page, 300),
    utm_source: sanitize(input.utm_source, 120),
    utm_medium: sanitize(input.utm_medium, 120),
    utm_campaign: sanitize(input.utm_campaign, 120),
    utm_content: sanitize(input.utm_content, 120),
    utm_term: sanitize(input.utm_term, 120),
    gclid: sanitize(input.gclid, 180),
    fbclid: sanitize(input.fbclid, 180),
    timestamp: new Date().toISOString(),
  };
}

function validateLead(lead) {
  // Hard requirements: name + phone. These are also `required` in the form UI.
  if (lead.name.length < 2) return 'Please enter your full name.';
  if (!/^\+?\d{8,15}$/.test(lead.phone)) return 'Please enter a valid mobile number.';
  // Plot size: an empty selection is accepted and mapped to "Need expert
  // recommendation" so we never drop an ad lead over an unselected dropdown.
  if (!ALLOWED_PLOTS.has(lead.plot_interest)) return 'Please select a valid plot option.';
  if (!ALLOWED_BUDGETS.has(lead.budget)) return 'Please select a valid budget range.';
  if (!ALLOWED_PURPOSES.has(lead.purpose)) return 'Please select a valid purpose.';
  if (!isFutureOrToday(lead.preferred_visit_date)) return 'Please choose a valid future site visit date.';
  return '';
}

// ── Spam protection ─────────────────────────────────────────────────────────
function getClientIp(headers, fallbackIp) {
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  return String(forwarded || fallbackIp || 'unknown').split(',')[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateLimitStore.get(ip) || [];
  const recent = bucket.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitStore.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// ── Wix API access ──────────────────────────────────────────────────────────
// Never log the contents of these headers; they contain the API key.
function wixHeaders() {
  const apiKey = env('WIX_API_KEY');
  if (!apiKey) throw new Error('WIX_API_KEY is not configured.');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': apiKey,
  };
  const siteId = env('WIX_SITE_ID');
  const accountId = env('WIX_ACCOUNT_ID');
  if (siteId) headers['wix-site-id'] = siteId;
  if (accountId) headers['wix-account-id'] = accountId;
  return headers;
}

async function wixPost(path, payload) {
  const res = await fetch(`${WIX_API_BASE}${path}`, {
    method: 'POST',
    headers: wixHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    parsed = { message: text };
  }
  if (!res.ok) {
    const error = new Error(parsed.message || `Wix request failed with ${res.status}`);
    error.status = res.status;
    error.wixResponse = parsed;
    throw error;
  }
  return parsed;
}

// Labels and custom fields must exist before a contact can reference them.
// find-or-create is idempotent; keys are cached for the life of the instance.
const resolvedFieldKeys = new Map();
const resolvedLabelKeys = new Map();

async function resolveExtendedFieldKey(displayName, dataType = 'TEXT') {
  if (resolvedFieldKeys.has(displayName)) return resolvedFieldKeys.get(displayName);
  const data = await wixPost('/contacts/v4/extended-fields', { displayName, dataType });
  const key = data.field && data.field.key;
  if (key) resolvedFieldKeys.set(displayName, key);
  return key;
}

async function resolveLabelKey(displayName) {
  if (resolvedLabelKeys.has(displayName)) return resolvedLabelKeys.get(displayName);
  const data = await wixPost('/contacts/v4/labels', { displayName });
  const key = data.label && data.label.key;
  if (key) resolvedLabelKeys.set(displayName, key);
  return key;
}

function splitName(fullName) {
  const parts = fullName.split(' ').filter(Boolean);
  if (parts.length <= 1) return { first: fullName, last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function attributionSummary(lead) {
  return [
    'Project: The Oasis',
    'Lead Source: Oasis Landing Page',
    'Platform: Vercel',
    `Submitted: ${lead.timestamp}`,
    `Landing page: ${lead.landing_page || '-'}`,
    `utm_source: ${lead.utm_source || '-'}`,
    `utm_medium: ${lead.utm_medium || '-'}`,
    `utm_campaign: ${lead.utm_campaign || '-'}`,
    `utm_content: ${lead.utm_content || '-'}`,
    `utm_term: ${lead.utm_term || '-'}`,
    `gclid: ${lead.gclid || '-'}`,
    `fbclid: ${lead.fbclid || '-'}`,
  ].join('\n');
}

async function storeInWix(lead) {
  const info = {
    name: splitName(lead.name),
    phones: {
      items: [{ tag: 'MOBILE', countryCode: 'IN', phone: toIndiaNationalNumber(lead.phone) }],
    },
  };

  // Best-effort enrichment. If any custom field / label can't be resolved
  // (e.g. missing API scope), we omit just that piece — the contact is still
  // created with name + phone, so no lead is ever lost.
  const fieldSpecs = [
    ['The Oasis – Preferred Plot Size', lead.plot_label],
    ['The Oasis – Budget', lead.budget_label],
    ['The Oasis – Purchase Purpose', lead.purpose_label],
    ['The Oasis – Preferred Visit Date', lead.preferred_visit_date],
    ['The Oasis – Additional Requirements', lead.message],
    ['The Oasis – Marketing Attribution', attributionSummary(lead)],
  ].filter(([, value]) => value);

  const extendedItems = {};
  await Promise.all(fieldSpecs.map(async ([displayName, value]) => {
    try {
      const key = await resolveExtendedFieldKey(displayName, 'TEXT');
      if (key) extendedItems[key] = value;
    } catch (error) {
      console.warn(`Wix custom field "${displayName}" unavailable:`, error.status || error.message);
    }
  }));
  if (Object.keys(extendedItems).length) info.extendedFields = { items: extendedItems };

  const labelNames = ['Project: The Oasis', 'Lead Source: Oasis Landing Page', 'Platform: Vercel'];
  const labelKeys = [];
  await Promise.all(labelNames.map(async (displayName) => {
    try {
      const key = await resolveLabelKey(displayName);
      if (key) labelKeys.push(key);
    } catch (error) {
      console.warn(`Wix label "${displayName}" unavailable:`, error.status || error.message);
    }
  }));
  if (labelKeys.length) info.labelKeys = { items: labelKeys };

  const result = await wixPost('/contacts/v4/contacts', { info, allowDuplicates: true });
  return result.contact && result.contact.id;
}

// ── Request handler ─────────────────────────────────────────────────────────
async function handleLeadRequest({ method, headers = {}, body, ip }) {
  const origin = headers.origin || headers.Origin || '';

  if (method === 'OPTIONS') return json(204, {}, origin);
  if (method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' }, origin);

  const clientIp = getClientIp(headers, ip);
  if (isRateLimited(clientIp)) {
    return json(429, { ok: false, error: 'Too many submissions. Please try again in a few minutes.' }, origin);
  }

  let input;
  try {
    input = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch (error) {
    return json(400, { ok: false, error: 'Invalid request.' }, origin);
  }

  // Honeypot: bots fill the hidden "company" field. Accept silently, store nothing.
  if (sanitize(input.company, 80)) return json(200, { ok: true }, origin);

  const lead = normalizeLead(input);
  const validationError = validateLead(lead);
  if (validationError) return json(400, { ok: false, error: validationError }, origin);

  try {
    const contactId = await storeInWix(lead);
    console.log('Wix contact created:', {
      id: contactId || '(id not returned)',
      plot: lead.plot_interest || '(default)',
      budget: lead.budget || '-',
      utm_campaign: lead.utm_campaign || '-',
    });
    return json(200, { ok: true }, origin);
  } catch (error) {
    // Log useful debugging info server-side, but never the API key.
    console.error('Wix lead submission failed:', {
      status: error.status || null,
      message: error.message || String(error),
      wixResponse: error.wixResponse || null,
    });
    return json(500, { ok: false, error: GENERIC_ERROR }, origin);
  }
}

module.exports = { handleLeadRequest };
