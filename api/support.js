// api/support.js — Vercel serverless function
// Receives support messages and forwards to team email
// The destination email is never exposed to the client

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from_name, from_email, subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Use Resend API (free tier: 100 emails/day)
  // Sign up at resend.com and add RESEND_API_KEY to Vercel env vars
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  
  if (!RESEND_API_KEY) {
    // Fallback: log and return ok (message lost but no error shown to user)
    console.log('Support message (no API key):', { from_name, from_email, subject, message });
    return res.status(200).json({ ok: true });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Pattro Support <support@pattro.com>',
        to:   ['blackbosstrad@gmail.com'],
        subject: `[Pattro Support] ${subject}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px">
            <h2 style="color:#3ecfcf">New Support Message</h2>
            <p><strong>From:</strong> ${from_name} (${from_email})</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <hr style="border-color:#eee">
            <p style="white-space:pre-wrap">${message}</p>
          </div>
        `
      })
    });

    if (resp.ok) {
      return res.status(200).json({ ok: true });
    } else {
      throw new Error('Resend API error');
    }
  } catch(e) {
    console.error('Support email error:', e);
    return res.status(500).json({ error: 'Failed to send' });
  }
}
