// api/paddle-config.js
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const isSandbox = process.env.PADDLE_ENV === 'sandbox';

  console.log('[paddle-config] PADDLE_ENV:', process.env.PADDLE_ENV);
  console.log('[paddle-config] isSandbox:', isSandbox);
  console.log('[paddle-config] PADDLE_TOKEN exists:', !!process.env.PADDLE_TOKEN);
  console.log('[paddle-config] PADDLE_TOKEN_SANDBOX exists:', !!process.env.PADDLE_TOKEN_SANDBOX);
  console.log('[paddle-config] PADDLE_PRICE_ID exists:', !!process.env.PADDLE_PRICE_ID);
  console.log('[paddle-config] PADDLE_PRICE_ID_SANDBOX exists:', !!process.env.PADDLE_PRICE_ID_SANDBOX);

  const token   = isSandbox
    ? process.env.PADDLE_TOKEN_SANDBOX
    : process.env.PADDLE_TOKEN;

  const priceId = isSandbox
    ? process.env.PADDLE_PRICE_ID_SANDBOX
    : process.env.PADDLE_PRICE_ID;

  if (!token || !priceId) {
    console.error('[paddle-config] Missing:', { token: !!token, priceId: !!priceId });
    return res.status(500).json({ 
      error: 'Paddle not configured',
      debug: {
        env: process.env.PADDLE_ENV,
        isSandbox,
        hasToken: !!token,
        hasPriceId: !!priceId
      }
    });
  }

  return res.status(200).json({
    token,
    priceId,
    sandbox: isSandbox
  });
}
