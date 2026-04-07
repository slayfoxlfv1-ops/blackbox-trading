// api/link-paddle-user.js
// Vincula user_id de Supabase con la suscripción de Paddle
// Se llama desde register.html después de checkout.completed + signUp()
// Esto garantiza que futuros webhooks (renovaciones) puedan identificar al usuario por user_id

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { user_id, subscription_id, email } = req.body || {};

  if (!user_id || !subscription_id) {
    return res.status(400).json({ error: 'Missing user_id or subscription_id' });
  }

  const PADDLE_API_KEY  = process.env.PADDLE_API_KEY;
  const SUPABASE_URL    = process.env.SUPABASE_URL;
  const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

  try {
    // 1. Actualizar el subscription en Paddle para incluir user_id en customData
    //    Así, todos los futuros webhooks (renovaciones, cancelaciones) tendrán user_id
    if (PADDLE_API_KEY) {
      const paddleResp = await fetch(`https://api.paddle.com/subscriptions/${subscription_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${PADDLE_API_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          custom_data: { user_id: user_id, email: email || '' }
        })
      });

      if (!paddleResp.ok) {
        const err = await paddleResp.text();
        console.warn('[link-paddle-user] Paddle update failed (non-fatal):', err);
        // No bloqueamos — el plan ya está activo desde el frontend
      } else {
        console.log('[link-paddle-user] Paddle subscription updated with user_id:', user_id);
      }
    }

    // 2. Asegurarse de que el profile tiene el paddle_subscription_id guardado
    if (SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({
          paddle_subscription_id: subscription_id
        })
      });
    }

    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('[link-paddle-user] Error:', e.message);
    // Error no crítico — el plan ya está activo
    return res.status(200).json({ ok: true, warning: e.message });
  }
}
