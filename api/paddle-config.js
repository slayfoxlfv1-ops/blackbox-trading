// api/paddle-config.js — TEMP TEST
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Log ALL env vars that start with PADDLE
  const paddleVars = Object.keys(process.env)
    .filter(k => k.startsWith('PADDLE'))
    .reduce((acc, k) => {
      acc[k] = process.env[k] ? '✓ set (' + process.env[k].slice(0,6) + '...)' : '✗ missing';
      return acc;
    }, {});

  console.log('[paddle-config] All PADDLE vars:', JSON.stringify(paddleVars));

  return res.status(200).json({
    paddleVars,
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV
  });
}
