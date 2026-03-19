// api/create-checkout.js
// Creates a Paddle checkout session and returns the URL

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const PADDLE_API_KEY  = process.env.PADDLE_API_KEY;
  const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID;

  if (!PADDLE_API_KEY || !PADDLE_PRICE_ID) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  try {
    // Create or find customer in Paddle
    const customerResp = await fetch('https://api.paddle.com/customers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, name: name || '' })
    });

    const customerData = await customerResp.json();
    const customerId = customerData.data?.id;

    // Build Paddle checkout URL
    // Using Paddle.js overlay checkout
    const checkoutUrl = `https://buy.paddle.com/product/${PADDLE_PRICE_ID}?customer_email=${encodeURIComponent(email)}&custom_data[email]=${encodeURIComponent(email)}&success_url=${encodeURIComponent('https://pattro.com/dashboard?payment=success')}`;

    return res.status(200).json({
      ok:          true,
      checkoutUrl: checkoutUrl,
      customerId:  customerId
    });

  } catch(e) {
    console.error('[Checkout] Error:', e.message);
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
}
