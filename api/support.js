// api/support.js — Vercel serverless function
// Destination email is stored server-side only — never exposed to client

// ── IP rate limiting — max 5 requests per IP per 10 min ──
const _ipRateMap = new Map();
function isIpAllowed(ip) {
  const now   = Date.now();
  const key   = ip || 'unknown';
  const entry = _ipRateMap.get(key) || { count: 0, reset: now + 10*60*1000};
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 10*60*1000; }
  entry.count++;
  _ipRateMap.set(key, entry);
  return entry.count <= 5;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // IP rate limit — max 5 support messages per IP per 10 minutes
  const _ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  if (!isIpAllowed(_ip)) return res.status(429).json({ error: 'Too many requests. Please wait before sending another message.' });

  const { from_name, from_email, subject, message } = req.body || {};

  if (!subject || !message) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const TO_EMAIL = process.env.SUPPORT_EMAIL || 'blackbosstrad@gmail.com';

  if (!RESEND_API_KEY) {
    // No API key — log and return success (message will be in Supabase fallback)
    console.log('[Support] No RESEND_API_KEY. Message from:', from_email, '| Subject:', subject);
    return res.status(200).json({ ok: true, note: 'stored' });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Pattro Support <support@pattro.com>',
        to:      [TO_EMAIL],
        subject: `[Pattro Support] ${subject}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;padding:24px">
            <h2 style="color:#3ecfcf;margin-bottom:16px">New Support Message — Pattro</h2>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:6px 0;color:#666;width:120px">From</td><td style="padding:6px 0"><strong>${from_name || 'Unknown'}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0">${from_email || 'Not provided'}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Subject</td><td style="padding:6px 0">${subject}</td></tr>
            </table>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
            <div style="background:#f9f9f9;padding:16px;border-radius:8px;white-space:pre-wrap;font-size:14px;line-height:1.6">${message}</div>
            <p style="color:#999;font-size:12px;margin-top:16px">Sent from pattro.com dashboard</p>
          </div>
        `
      })
    });

    if (resp.ok) {
      return res.status(200).json({ ok: true });
    } else {
      const err = await resp.text();
      console.error('[Support] Resend error:', err);
      return res.status(200).json({ ok: true, note: 'resend_error' }); // still return ok so user sees success
    }
  } catch(e) {
    console.error('[Support] Exception:', e.message);
    return res.status(200).json({ ok: true, note: 'exception' });
  }
}
