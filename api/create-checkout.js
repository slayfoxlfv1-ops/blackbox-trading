// api/create-checkout.js
// Nota: este endpoint actualmente no se usa — el registro usa Paddle.js overlay directamente.
// Se mantiene limpio por si se necesita en el futuro (e.g. upgrade desde el dashboard).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, name, user_id } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID;

  if (!PADDLE_PRICE_ID) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  try {
    // FIX I3: custom_data debe ir como JSON en el query param correcto de Paddle
    // Los brackets sin encodear ([email]) no son válidos en URLs
    // La forma correcta para Paddle Billing es pasar custom_data como JSON string
    const customData = JSON.stringify({ email, user_id: user_id || '' });

    const checkoutUrl = [
      `https://buy.paddle.com/product/${PADDLE_PRICE_ID}`,
      `?customer_email=${encodeURIComponent(email)}`,
      `&custom_data=${encodeURIComponent(customData)}`,
      `&success_url=${encodeURIComponent('https://pattro.com/dashboard?payment=success')}`
    ].join('');

    return res.status(200).json({
      ok:          true,
      checkoutUrl: checkoutUrl
    });

  } catch(e) {
    console.error('[Checkout] Error:', e.message);
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
}
