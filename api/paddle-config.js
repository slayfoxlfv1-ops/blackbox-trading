// api/paddle-config.js
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const isSandbox = (process.env.PADDLE_ENV || '').toLowerCase() === 'sandbox';

  const token   = isSandbox
    ? process.env.PADDLE_TOKEN_SANDBOX
    : process.env.PADDLE_TOKEN;

  const priceId = isSandbox
    ? process.env.PADDLE_PRICE_ID_SANDBOX
    : process.env.PADDLE_PRICE_ID;

  if (!token || !priceId) {
    return res.status(500).json({ error: 'Paddle not configured' });
  }

  return res.status(200).json({
    token,
    priceId,
    sandbox: isSandbox
  });
}
