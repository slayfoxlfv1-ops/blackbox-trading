// api/paddle-config.js
// Returns only the Paddle CLIENT token (safe to expose) and price ID
// The actual API key (apikey_) stays server-side only
// Called by register.html before opening checkout

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const isSandbox = process.env.PADDLE_ENV === 'sandbox';

  // Use sandbox credentials if PADDLE_ENV=sandbox, else production
  const token   = isSandbox
    ? process.env.PADDLE_TOKEN_SANDBOX
    : process.env.PADDLE_TOKEN;

  const priceId = isSandbox
    ? process.env.PADDLE_PRICE_ID_SANDBOX
    : process.env.PADDLE_PRICE_ID;

  if (!token || !priceId) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  // Return token, priceId, AND whether we're in sandbox
  // register.html uses the sandbox flag to call Paddle.Environment.set('sandbox')
  return res.status(200).json({
    token:      token,
    priceId:    priceId,
    sandbox:    isSandbox
  });
}
