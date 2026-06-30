const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateLimitStore = new Map();

const ALLOWED_PLOTS = new Set(['', '3687', '4236', 'any']);
const ALLOWED_BUDGETS = new Set(['', '75-90', '90-110', 'above-110', 'guidance']);
const ALLOWED_PURPOSES = new Set(['', 'bungalow', 'investment', 'both']);

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function allowedOrigins() {
  return env('ALLOWED_ORIGINS', 'https://asingh6937-stack.github.io,http://localhost:3000,http://localhost:8888')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  const allowed = allowedOrigins();
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || 'https://asingh6937-stack.github.io';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  };
}

function json(status, body, origin) {
  return { status, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

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

function isFutureOrToday(dateValue) {
  if (!dateValue) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return false;
  const selected = new Date(`${dateValue}T00:00:00Z`);
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return !Number.isNaN(selected.getTime()) && selected >= today;
}

function normalizeLead(input) {
  const lead = {
    name: sanitize(input.name, 80),
    phone: normalizePhone(input.phone),
    budget: sanitize(input.budget, 30),
    plot_interest: sanitize(input.plot_interest || input.plot, 30),
    preferred_visit_date: sanitize(input.preferred_visit_date || input.visit_date, 20) || null,
    message: sanitize(input.message, 1000),
    source: sanitize(input.source || 'landing_page', 80),
    campaign: sanitize(input.campaign, 120),
    ad_id: sanitize(input.ad_id, 120),
    landing_page: sanitize(input.landing_page, 300),
    timestamp: new Date().toISOString(),
    utm_source: sanitize(input.utm_source, 120),
    utm_medium: sanitize(input.utm_medium, 120),
    utm_campaign: sanitize(input.utm_campaign, 120),
    utm_content: sanitize(input.utm_content, 120),
    utm_term: sanitize(input.utm_term, 120),
    gclid: sanitize(input.gclid, 180),
    fbclid: sanitize(input.fbclid, 180),
  };
  return lead;
}

function validateLead(lead) {
  if (lead.name.length < 2) return 'Please enter a valid name.';
  if (!/^\+?\d{8,15}$/.test(lead.phone)) return 'Please enter a valid mobile number.';
  if (!ALLOWED_PLOTS.has(lead.plot_interest)) return 'Please select a valid plot option.';
  if (!ALLOWED_BUDGETS.has(lead.budget)) return 'Please select a valid budget range.';
  if (!ALLOWED_PURPOSES.has(sanitize(lead.purpose, 30))) return 'Please select a valid purpose.';
  if (!isFutureOrToday(lead.preferred_visit_date)) return 'Please choose a valid future site visit date.';
  return '';
}

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

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Request failed with ${res.status}`);
  return text ? JSON.parse(text) : {};
}

async function storeInSupabase(lead) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const table = env('SUPABASE_LEADS_TABLE', 'leads');
  if (!url || !key) return { skipped: true, provider: 'supabase' };
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}`;
  await postJson(endpoint, lead, {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'return=minimal',
  });
  return { ok: true, provider: 'supabase' };
}

async function storeInGoogleSheets(lead) {
  const webhook = env('GOOGLE_SHEETS_WEBHOOK_URL');
  if (!webhook) return { skipped: true, provider: 'google_sheets' };
  await postJson(webhook, lead);
  return { ok: true, provider: 'google_sheets' };
}

async function storeLead(lead) {
  const errors = [];
  for (const store of [storeInSupabase, storeInGoogleSheets]) {
    try {
      const result = await store(lead);
      if (result.ok) return result;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join(' | ') || 'No lead storage provider configured.');
}

function leadMessage(lead) {
  return [
    'New The Oasis lead',
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `Budget: ${lead.budget || '-'}`,
    `Plot interest: ${lead.plot_interest || '-'}`,
    `Visit date: ${lead.preferred_visit_date || '-'}`,
    `Message: ${lead.message || '-'}`,
    `Source: ${lead.source || '-'}`,
    `Campaign: ${lead.campaign || lead.utm_campaign || '-'}`,
    `GCLID: ${lead.gclid || '-'}`,
    `FBCLID: ${lead.fbclid || '-'}`,
    `Landing page: ${lead.landing_page || '-'}`,
    `Timestamp: ${lead.timestamp}`,
  ].join('\n');
}

async function sendWhatsApp(lead) {
  const token = env('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID');
  const to = env('WHATSAPP_TO_NUMBER');
  if (!token || !phoneNumberId || !to) return { skipped: true, provider: 'whatsapp' };
  const endpoint = `https://graph.facebook.com/v20.0/${encodeURIComponent(phoneNumberId)}/messages`;
  await postJson(endpoint, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: leadMessage(lead) },
  }, {
    Authorization: `Bearer ${token}`,
  });
  return { ok: true, provider: 'whatsapp' };
}

async function sendFallbackEmail(lead, reason) {
  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  const to = env('EMAIL_TO');
  if (!apiKey || !from || !to) return { skipped: true, provider: 'email' };
  await postJson('https://api.resend.com/emails', {
    from,
    to: [to],
    subject: 'The Oasis lead needs follow-up',
    text: `${leadMessage(lead)}\n\nFallback reason: ${reason || 'WhatsApp/API delivery failed'}`,
  }, {
    Authorization: `Bearer ${apiKey}`,
  });
  return { ok: true, provider: 'email' };
}

async function sendMetaConversionsApiLead(lead, headers) {
  const token = env('META_CAPI_ACCESS_TOKEN');
  const pixelId = env('META_PIXEL_ID');
  if (!token || !pixelId) return { skipped: true, provider: 'meta_capi' };
  const endpoint = `https://graph.facebook.com/v20.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
  await postJson(endpoint, {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: lead.landing_page,
      user_data: {
        client_ip_address: getClientIp(headers),
        client_user_agent: headers['user-agent'] || headers['User-Agent'] || '',
        fbc: lead.fbclid ? `fb.1.${Date.now()}.${lead.fbclid}` : undefined,
      },
      custom_data: {
        content_name: 'The Oasis enquiry',
        plot_interest: lead.plot_interest,
        budget: lead.budget,
      },
    }],
  });
  return { ok: true, provider: 'meta_capi' };
}

async function handleLeadRequest({ method, headers = {}, body, ip }) {
  const origin = headers.origin || headers.Origin || '';
  if (method === 'OPTIONS') return json(204, {}, origin);
  if (method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' }, origin);
  if (origin && !allowedOrigins().includes(origin)) return json(403, { ok: false, error: 'Origin not allowed.' }, origin);

  const clientIp = getClientIp(headers, ip);
  if (isRateLimited(clientIp)) return json(429, { ok: false, error: 'Too many submissions. Please try again shortly.' }, origin);

  let input;
  try {
    input = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch (error) {
    return json(400, { ok: false, error: 'Invalid request body.' }, origin);
  }
  if (sanitize(input.company, 80)) return json(200, { ok: true, filtered: true }, origin);

  const lead = normalizeLead(input);
  lead.ip_address = sanitize(clientIp, 80);
  lead.user_agent = sanitize(headers['user-agent'] || headers['User-Agent'], 300);
  lead.purpose = sanitize(input.purpose, 30);

  const validationError = validateLead(lead);
  if (validationError) return json(400, { ok: false, error: validationError }, origin);

  try {
    const storage = await storeLead(lead);
    let whatsapp = { skipped: true };
    try {
      whatsapp = await sendWhatsApp(lead);
    } catch (error) {
      await sendFallbackEmail(lead, error.message);
    }
    sendMetaConversionsApiLead(lead, headers).catch(() => {});
    return json(200, { ok: true, storage: storage.provider, whatsapp: whatsapp.provider || 'skipped' }, origin);
  } catch (error) {
    await sendFallbackEmail(lead, error.message).catch(() => {});
    return json(500, { ok: false, error: 'Lead could not be saved. Please WhatsApp us directly.' }, origin);
  }
}

module.exports = { handleLeadRequest };
