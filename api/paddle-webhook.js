// api/paddle-webhook.js
// Receives Paddle events and updates Supabase accordingly

import crypto from 'crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_KEY;

// Helper: Supabase REST call with service key
async function sbAdmin(method, path, body) {
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: resp.ok, status: resp.status, data: text }; }
}

// Helper: Supabase Auth Admin API
async function sbAuth(method, path, body) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: resp.ok, status: resp.status, data: text }; }
}

function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  // Paddle sends: ts=timestamp;h1=hash
  const parts = {};
  signatureHeader.split(';').forEach(part => {
    const [k, v] = part.split('=');
    parts[k] = v;
  });
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;
  const signed = `${ts}:${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signed)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(h1), Buffer.from(expected));
}

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers['paddle-signature'] || '';
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  // Verify Paddle signature — skip in sandbox for testing resent events
  const isSandbox = process.env.PADDLE_ENV === 'sandbox';
  if (secret && !isSandbox && !verifyPaddleSignature(rawBody, signature, secret)) {
    console.error('[Paddle] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const type = event.event_type;
  const data = event.data;

  console.log('[Paddle] Event:', type);

  try {
    // ── subscription.activated / subscription.created — new subscriber ──
    if (type === 'subscription.activated' || type === 'subscription.created') {
      const email           = data.custom_data?.email || data.customer?.email || '';
      const username        = data.custom_data?.username || '';
      const full_name       = data.custom_data?.full_name || '';
      const country         = data.custom_data?.country || '';
      const customerId      = data.customer_id;
      const subscriptionId  = data.id;
      const nextBilling     = data.next_billed_at;

      if (email) {
        // Check if user already exists
        // Find user by email via admin API
        const listResp = await sbAuth('GET', `/admin/users?email=${encodeURIComponent(email)}&per_page=1`);
        const existingUser = listResp.data?.users?.[0] || null;

        if (existingUser) {
          // User already exists — just update plan
          await sbAdmin('PATCH', `/rest/v1/profiles?id=eq.${existingUser.id}`, {
            plan:                   'pro',
            plan_expires_at:        nextBilling,
            paddle_customer_id:     customerId,
            paddle_subscription_id: subscriptionId
          });
        } else {
          // New user — create account server-side
          try {
            // Create auth user
            const createResp = await sbAuth('POST', '/admin/users', {
              email,
              email_confirm: true,
              user_metadata: { username, full_name }
            });
            if (!createResp.ok) throw new Error(JSON.stringify(createResp.data));
            const userId = createResp.data.id;

            // Save profile with pro plan
            const expires = new Date();
            expires.setMonth(expires.getMonth() + 1);

            await sbAdmin('POST', '/rest/v1/profiles', {
              id:                     userId,
              email,
              username:               username || email.split('@')[0],
              full_name,
              country,
              plan:                   'pro',
              plan_expires_at:        nextBilling || expires.toISOString(),
              paddle_customer_id:     customerId,
              paddle_subscription_id: subscriptionId
            });

            // Send magic link so user can set password and log in
            await sbAuth('POST', '/admin/generate_link', {
              type: 'magiclink',
              email,
              options: { redirect_to: 'https://www.pattro.com/dashboard?payment=success' }
            });

            console.log('[Paddle] Account created for:', email);
          } catch(createErr) {
            console.error('[Paddle] Failed to create account for', email, ':', createErr.message);
          }
        }
      }
    }

    // ── transaction.completed — new subscription or renewal payment ──
    if (type === 'transaction.completed') {
      const email          = data.customer?.email || data.custom_data?.email || '';
      const customerId     = data.customer_id;
      const subscriptionId = data.subscription_id;
      const username       = data.custom_data?.username || (email ? email.split('@')[0] : '');
      const full_name      = data.custom_data?.full_name || '';
      const country        = data.custom_data?.country || '';


      if (email && subscriptionId) {
        try {
          // Try to create user — handle already-exists gracefully
          const createResp = await sbAuth('POST', '/admin/users', {
            email,
            email_confirm: true,
            user_metadata: { username, full_name }
          });


          let userId = null;

          if (createResp.ok && createResp.data?.id) {
            // New user created
            userId = createResp.data.id;
          } else {
            // User already exists — find them by fetching all users and filtering
              const allR = await sbAuth('GET', '/admin/users?per_page=1000&page=1');
            const found = (allR.data?.users || []).find(u => u.email === email);
            if (found) {
              userId = found.id;
              }
          }

          if (userId) {
            const expires = new Date();
            expires.setMonth(expires.getMonth() + 1);

            // Upsert profile
            // Use upsert to handle both new and existing profiles
            const profileBody = {
              id:                     userId,
              email,
              username:               username || email.split('@')[0],
              full_name,
              country,
              plan:                   'pro',
              plan_expires_at:        expires.toISOString(),
              paddle_customer_id:     customerId,
              paddle_subscription_id: subscriptionId
            };
            const profileResp = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
              method: 'POST',
              headers: {
                'apikey':        SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        'resolution=merge-duplicates,return=minimal'
              },
              body: JSON.stringify(profileBody)
            });
            const profileResp2 = { status: profileResp.status, ok: profileResp.ok };

            // Send magic link for login
            const linkResp = await sbAuth('POST', '/admin/generate_link', {
              type:    'magiclink',
              email,
              options: { redirect_to: 'https://www.pattro.com/dashboard?payment=success' }
            });
            console.log('[Paddle] ✅ Account ready for:', email);
          } else {
            console.error('[Paddle] Could not find or create user for:', email);
          }
        } catch(e) {
          console.error('[Paddle] Account creation error:', e.message);
        }
      }
    }

    // ── subscription.updated ──
    if (type === 'subscription.updated') {
      const subscriptionId = data.id;
      const nextBilling    = data.next_billed_at;
      const status         = data.status;
      const scheduledChange = data.scheduled_change;

      if (subscriptionId) {
        const updates = {};

        if (status === 'active') updates.plan = 'pro';
        if (nextBilling) updates.plan_expires_at = nextBilling;

        // Handle scheduled cancellation — keep pro until effective_at date
        if (scheduledChange && scheduledChange.action === 'cancel') {
          updates.plan_expires_at = scheduledChange.effective_at;
          // Keep plan as 'pro' until expiry — don't set to 'free' yet
          updates.plan = 'pro';
          console.log('[Paddle] Scheduled cancellation — expires:', scheduledChange.effective_at);
        }

        if (Object.keys(updates).length > 0) {
          await sbAdmin('PATCH', `/rest/v1/profiles?paddle_subscription_id=eq.${subscriptionId}`, updates);
        }
      }
    }

    // ── subscription.canceled ──
    if (type === 'subscription.canceled') {
      const subscriptionId = data.id;
      const canceledAt     = data.canceled_at || new Date().toISOString();

      if (subscriptionId) {
        if (subscriptionId) await sbAdmin('PATCH', `/rest/v1/profiles?paddle_subscription_id=eq.${subscriptionId}`, {
          plan:            'free',
          plan_expires_at: canceledAt
        });
      }
    }

  } catch(err) {
    console.error('[Paddle] Handler error:', err.message);
    // Still return 200 so Paddle doesn't retry forever
  }

  return res.status(200).json({ ok: true });
}

// ── Welcome email via Resend ──
async function sendWelcomeEmail(email, name) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;

  const firstName = name.split(' ')[0] || 'trader';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from:    'Pattro <onboarding@resend.dev>',
      to:      [email],
      subject: 'Welcome to Pattro 🎉',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0a0a0b;padding:40px 20px">
          <div style="max-width:480px;margin:0 auto;background:#111113;border:1px solid #26262e;border-top:2px solid #3ecfcf;border-radius:14px;padding:36px 40px">
            
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
              <div style="position:relative;width:32px;height:32px;flex-shrink:0">
                <span style="font-family:Georgia,serif;font-size:30px;font-weight:700;color:#eeeef0;line-height:1;position:absolute;left:0;bottom:0">P</span>
                <span style="position:absolute;top:0;right:0;width:8px;height:8px;border-radius:50%;background:#3ecfcf;display:block"></span>
              </div>
              <span style="font-size:18px;font-weight:700;color:#eeeef0;letter-spacing:-.5px">pattro</span>
            </div>

            <h1 style="font-size:22px;font-weight:700;color:#eeeef0;margin-bottom:8px;letter-spacing:-.3px">
              Welcome, ${firstName}! 🎉
            </h1>
            <p style="font-size:13px;color:#9898a6;line-height:1.75;margin-bottom:24px">
              Your Pattro Pro subscription is now active. You have full access to all features — Mental Score, AI Coach, Psychology tracking, and everything else.
            </p>

            <div style="background:#18181b;border:1px solid #26262e;border-radius:10px;padding:20px;margin-bottom:24px">
              <p style="font-size:12px;font-weight:700;color:#eeeef0;margin-bottom:12px">What you can do now:</p>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div style="font-size:12px;color:#9898a6">✓ &nbsp;Log your first trade and emotion</div>
                <div style="font-size:12px;color:#9898a6">✓ &nbsp;Set up your daily checklist</div>
                <div style="font-size:12px;color:#9898a6">✓ &nbsp;Configure your trading rules</div>
                <div style="font-size:12px;color:#9898a6">✓ &nbsp;After 20 trades, unlock the AI Coach</div>
              </div>
            </div>

            <a href="https://pattro.com/dashboard" 
               style="display:block;text-align:center;background:#3ecfcf;color:#0a0a0b;padding:13px 24px;border-radius:9px;font-size:13px;font-weight:800;text-decoration:none;letter-spacing:.5px">
              GO TO MY DASHBOARD →
            </a>

            <p style="font-size:11px;color:#52525e;margin-top:24px;text-align:center;line-height:1.6">
              Questions? Reply to this email or contact us at support@pattro.com<br>
              © 2025 Pattro · Trading Psychology Engine
            </p>
          </div>
        </div>
      `
    })
  });
}
