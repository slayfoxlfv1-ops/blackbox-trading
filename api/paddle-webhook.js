// api/paddle-webhook.js
// Receives Paddle events and updates Supabase accordingly

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role key — has full access
);

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

  // Verify signature
  if (secret && !verifyPaddleSignature(rawBody, signature, secret)) {
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
    // ── subscription.activated — new subscriber ──
    if (type === 'subscription.activated') {
      const email           = data.custom_data?.email || data.customer?.email || '';
      const customerId      = data.customer_id;
      const subscriptionId  = data.id;
      const nextBilling     = data.next_billed_at;

      if (email) {
        // Find user by email
        const { data: users } = await sb.auth.admin.listUsers();
        const user = users?.users?.find(u => u.email === email);
        if (user) {
          await sb.from('profiles').update({
            plan:                   'pro',
            plan_expires_at:        nextBilling,
            paddle_customer_id:     customerId,
            paddle_subscription_id: subscriptionId
          }).eq('id', user.id);

          // Send welcome email
          await sendWelcomeEmail(email, user.user_metadata?.full_name || '');
        }
      }
    }

    // ── transaction.completed — one-time or renewal payment ──
    if (type === 'transaction.completed') {
      const email          = data.customer?.email || data.custom_data?.email || '';
      const customerId     = data.customer_id;
      const subscriptionId = data.subscription_id;

      if (email && subscriptionId) {
        // Extend subscription
        const { data: users } = await sb.auth.admin.listUsers();
        const user = users?.users?.find(u => u.email === email);
        if (user) {
          // Calculate next billing date (30 days from now)
          const expires = new Date();
          expires.setDate(expires.getDate() + 31);
          await sb.from('profiles').update({
            plan:                   'pro',
            plan_expires_at:        expires.toISOString(),
            paddle_customer_id:     customerId,
            paddle_subscription_id: subscriptionId
          }).eq('id', user.id);
        }
      }
    }

    // ── subscription.updated ──
    if (type === 'subscription.updated') {
      const subscriptionId = data.id;
      const nextBilling    = data.next_billed_at;
      const status         = data.status;

      if (subscriptionId) {
        const updates = { plan_expires_at: nextBilling };
        if (status === 'active') updates.plan = 'pro';
        await sb.from('profiles')
          .update(updates)
          .eq('paddle_subscription_id', subscriptionId);
      }
    }

    // ── subscription.canceled ──
    if (type === 'subscription.canceled') {
      const subscriptionId = data.id;
      const canceledAt     = data.canceled_at || new Date().toISOString();

      if (subscriptionId) {
        await sb.from('profiles').update({
          plan:            'free',
          plan_expires_at: canceledAt
        }).eq('paddle_subscription_id', subscriptionId);
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
