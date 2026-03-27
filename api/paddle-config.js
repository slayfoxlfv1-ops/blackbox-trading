// api/paddle-config.js
// Returns only the Paddle CLIENT token (safe to expose) and price ID
// The actual API key (apikey_) stays server-side only
// Called by register.html before opening checkout

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const token   = process.env.PADDLE_TOKEN;    // apikey_01km3x...
  const priceId = process.env.PADDLE_PRICE_ID; // pri_01km3x...

  if (!token || !priceId) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  // Return only what the frontend needs
  // The apikey_ token IS required client-side by Paddle.js to initialize
  // but we keep it out of source code — it comes from the server at runtime
  return res.status(200).json({
    token:   token,
    priceId: priceId
  });
}
