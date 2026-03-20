// api/cancel-subscription.js
// Cancels a Paddle subscription via API
// Called from the app — API key never exposed to client

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { subscription_id, user_id } = req.body || {};
  if (!subscription_id || !user_id) {
    return res.status(400).json({ error: 'Missing subscription_id or user_id' });
  }

  const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  // Verify the subscription belongs to this user (security check via Supabase)
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: profile } = await sb
    .from('profiles')
    .select('paddle_subscription_id')
    .eq('id', user_id)
    .single();

  if (!profile || profile.paddle_subscription_id !== subscription_id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Cancel at end of billing period (not immediately)
    const resp = await fetch(`https://api.paddle.com/subscriptions/${subscription_id}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ effective_from: 'next_billing_period' })
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[Cancel] Paddle error:', data);
      return res.status(400).json({ error: data.error?.detail || 'Failed to cancel' });
    }

    // Update Supabase to reflect scheduled cancellation
    await sb.from('profiles').update({
      plan: 'pro' // still pro until period ends
    }).eq('id', user_id);

    return res.status(200).json({ ok: true, message: 'Subscription cancelled successfully' });

  } catch(e) {
    console.error('[Cancel] Exception:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
