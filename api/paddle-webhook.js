// api/paddle-webhook.js
// VERSIÓN DEFINITIVA — fusión de ambas versiones
// Fixes: C2 (búsqueda por user_id), C3 (una sola versión), I2 (fecha real de Paddle)
//
// Configurar en Paddle Dashboard → Notifications → Webhook URL:
// https://www.pattro.com/api/paddle-webhook

import crypto from 'crypto';

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// ── Verificación de firma (método robusto con raw body) ──
// Paddle envía: Paddle-Signature: ts=1234567890;h1=abc123...
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = {};
  signatureHeader.split(';').forEach(part => {
    const eqIdx = part.indexOf('=');
    if (eqIdx > -1) {
      parts[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  });
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;
  const signed   = `${ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h1, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

// ── Leer el body raw (necesario para verificar la firma correctamente) ──
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

// ── Helper: actualizar profile en Supabase via REST directo ──
// Evita importar el SDK — más liviano y sin overhead de auth
async function updateProfile(filter, updates) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${filter}`, {
    method:  'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(updates)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase PATCH failed: ${err}`);
  }
  return resp;
}

// ── Construir el filtro correcto: user_id tiene prioridad sobre email ──
function buildFilter(customData) {
  const userId = customData?.user_id;
  const email  = customData?.email;
  if (userId)  return `id=eq.${encodeURIComponent(userId)}`;
  if (email)   return `email=eq.${encodeURIComponent(email)}`;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody  = await getRawBody(req);
  const sigHeader = req.headers['paddle-signature'] || '';

  // Verificar firma si el secret está configurado
  if (PADDLE_WEBHOOK_SECRET) {
    if (!verifySignature(rawBody, sigHeader, PADDLE_WEBHOOK_SECRET)) {
      console.error('[Paddle] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const type       = event.event_type;
  const data       = event.data || {};
  const customData = data.custom_data || data.transaction?.custom_data || {};

  console.log('[Paddle] Event:', type, '| user_id:', customData.user_id || '(none)', '| email:', customData.email || '(none)');

  try {

    // ── subscription.activated — nueva suscripción ──
    if (type === 'subscription.activated') {
      const filter        = buildFilter({ ...customData, email: customData.email || data.customer?.email });
      const subscriptionId = data.id;
      const customerId    = data.customer_id;
      // FIX I2: usar next_billed_at de Paddle, no calcular manualmente
      const nextBilling   = data.next_billed_at || (() => {
        const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString();
      })();

      if (!filter) {
        console.error('[Paddle] subscription.activated — no user identifier in customData');
        // Retorna 200 para que Paddle no reintente (el frontend ya activó el plan)
        return res.status(200).json({ ok: true, warning: 'no_user_id' });
      }

      await updateProfile(filter, {
        plan:                   'pro',
        plan_expires_at:        nextBilling,
        paddle_customer_id:     customerId,
        paddle_subscription_id: subscriptionId
      });

      console.log('[Paddle] Plan activated for filter:', filter);

      // Enviar email de bienvenida
      const email = customData.email || data.customer?.email;
      if (email) {
        sendWelcomeEmail(email, '').catch(e => console.warn('[Paddle] Welcome email failed:', e.message));
      }
    }

    // ── transaction.completed — pago inicial o renovación ──
    if (type === 'transaction.completed') {
      const filter        = buildFilter({ ...customData, email: customData.email || data.customer?.email });
      const subscriptionId = data.subscription_id;
      const customerId    = data.customer_id;

      // FIX I2: para renovaciones, usar next_billed_at del subscription object
      // Paddle incluye subscription_id en transaction.completed para suscripciones recurrentes
      const nextBilling = data.subscription?.next_billed_at || (() => {
        const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString();
      })();

      if (!filter) {
        console.error('[Paddle] transaction.completed — no user identifier');
        return res.status(200).json({ ok: true, warning: 'no_user_id' });
      }

      if (!subscriptionId) {
        // Transacción sin suscripción — ignorar (e.g. checkout de prueba)
        return res.status(200).json({ ok: true, ignored: 'no_subscription_id' });
      }

      await updateProfile(filter, {
        plan:                   'pro',
        plan_expires_at:        nextBilling,
        paddle_customer_id:     customerId,
        paddle_subscription_id: subscriptionId
      });

      console.log('[Paddle] Transaction completed, plan extended to:', nextBilling);
    }

    // ── subscription.updated — cambio en la suscripción ──
    if (type === 'subscription.updated') {
      const subscriptionId = data.id;
      const status         = data.status;
      // FIX I2: usar next_billed_at real
      const nextBilling    = data.next_billed_at;

      if (subscriptionId && nextBilling) {
        const updates = { plan_expires_at: nextBilling };
        if (status === 'active') updates.plan = 'pro';

        await updateProfile(`paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, updates);
        console.log('[Paddle] Subscription updated, next billing:', nextBilling);
      }
    }

    // ── subscription.canceled ──
    if (type === 'subscription.canceled') {
      const subscriptionId = data.id;
      // Usar scheduled_change_at si existe (acceso hasta fin de período)
      const endsAt = data.scheduled_change?.effective_at || data.canceled_at || new Date().toISOString();

      if (subscriptionId) {
        await updateProfile(`paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, {
          plan:            'free',
          plan_expires_at: endsAt
        });
        console.log('[Paddle] Subscription canceled, access until:', endsAt);
      }
    }

  } catch (err) {
    console.error('[Paddle] Handler error:', err.message);
    // Retornar 200 igualmente para evitar reintentos infinitos de Paddle
    // El error quedará en los logs para revisión manual
  }

  return res.status(200).json({ ok: true });
}

// ── Welcome email via Resend ──
// FIX M6: usar support@pattro.com, no onboarding@resend.dev
async function sendWelcomeEmail(email, name) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;

  const firstName = (name || '').split(' ')[0] || 'trader';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    'Pattro <support@pattro.com>',
      to:      [email],
      subject: 'Welcome to Pattro 🎉',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0a0a0b;padding:40px 20px">
          <div style="max-width:480px;margin:0 auto;background:#111113;border:1px solid #26262e;border-top:2px solid #3ecfcf;border-radius:14px;padding:36px 40px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
              <span style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#eeeef0">P</span>
              <span style="font-size:18px;font-weight:700;color:#eeeef0;letter-spacing:-.5px">pattro</span>
            </div>
            <h1 style="font-size:22px;font-weight:700;color:#eeeef0;margin-bottom:8px">
              Welcome, ${firstName}! 🎉
            </h1>
            <p style="font-size:13px;color:#9898a6;line-height:1.75;margin-bottom:24px">
              Your Pattro Pro subscription is now active. Full access to Mental Score, AI Coach, Psychology tracking and everything else.
            </p>
            <div style="background:#18181b;border:1px solid #26262e;border-radius:10px;padding:20px;margin-bottom:24px">
              <p style="font-size:12px;font-weight:700;color:#eeeef0;margin-bottom:12px">What to do now:</p>
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
              Questions? Contact us at support@pattro.com<br>
              © 2025 Pattro · Trading Psychology Engine
            </p>
          </div>
        </div>
      `
    })
  });
}
