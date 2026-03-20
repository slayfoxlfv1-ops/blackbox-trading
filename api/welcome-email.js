// api/welcome-email.js
// Sends welcome email when a new user registers
// Called from register.html after successful signup

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email not configured' });

  const firstName = (name || email.split('@')[0]).split(' ')[0];

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { background:#0a0a0b; color:#eeeef0; font-family:Georgia,serif; margin:0; padding:0; }
    .wrap { max-width:560px; margin:0 auto; padding:40px 24px; }
    .logo { font-size:28px; font-weight:700; color:#fff; letter-spacing:-.5px; margin-bottom:4px; }
    .logo span { color:#3ecfcf; }
    .sub { font-size:10px; color:#5a9e9e; letter-spacing:2px; margin-bottom:40px; font-family:monospace; }
    h1 { font-size:24px; font-weight:700; color:#eeeef0; margin-bottom:12px; }
    p { font-size:14px; color:#9898a6; line-height:1.8; margin-bottom:16px; font-family:Arial,sans-serif; }
    .highlight { color:#eeeef0; }
    .steps { background:#111113; border:1px solid #26262e; border-radius:12px; padding:24px; margin:24px 0; }
    .step { display:flex; gap:14px; margin-bottom:18px; align-items:flex-start; }
    .step:last-child { margin-bottom:0; }
    .step-num { background:#3ecfcf; color:#0a0a0b; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; flex-shrink:0; font-family:monospace; margin-top:2px; }
    .step-text { font-size:13px; color:#9898a6; line-height:1.6; font-family:Arial,sans-serif; }
    .step-title { color:#eeeef0; font-weight:600; display:block; margin-bottom:3px; }
    .btn { display:inline-block; padding:13px 28px; background:#3ecfcf; color:#0a0a0b; font-family:monospace; font-size:13px; font-weight:800; border-radius:8px; text-decoration:none; letter-spacing:.3px; margin:8px 0 24px; }
    .divider { border:none; border-top:1px solid #26262e; margin:32px 0; }
    .footer { font-size:11px; color:#5a9e9e; font-family:monospace; line-height:1.8; }
    .footer a { color:#5a9e9e; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">pattro<span>.</span></div>
    <div class="sub">TRADING JOURNAL</div>

    <h1>Welcome, ${firstName} — thank you for trusting Pattro 👋</h1>
    <p>
      You've just joined a community of traders who are serious about improving from the inside out.
      Pattro is built to help you understand <strong style="color:#eeeef0">why you make bad decisions</strong> —
      not just track how much you won or lost.
    </p>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">
          <span class="step-title">Create your trading account</span>
          Click "+ Add account" in the sidebar. One account = one funded account or paper trading setup.
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          <span class="step-title">Log your first trade</span>
          Use "+ Log Trade" after every trade. Fill in your emotion and discipline tag — this is what makes the analysis work.
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          <span class="step-title">Set up your checklist & rules</span>
          Go to Discipline → Checklist and Rules. Pattro will automatically detect when you break them.
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text">
          <span class="step-title">Do the daily mental check</span>
          Every morning before trading. Sleep, stress, focus and financial pressure — 4 questions, 30 seconds.
        </div>
      </div>
    </div>

    <p>With 15+ trades, the AI Coach can generate your full psychological profile — dominant pattern, main saboteur, best trading hours and a concrete work plan.</p>

    <a href="https://pattro.com/dashboard" class="btn">Open Pattro →</a>

    <hr class="divider">
    <div class="footer">
      Questions? Reply to this email or contact us at
      <a href="mailto:support@pattro.com">support@pattro.com</a><br>
      pattro.com · Trading Psychology Engine
    </div>
  </div>
</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Pattro <support@pattro.com>',
        to:      [email],
        subject: `Welcome to Pattro, ${firstName} 👋`,
        html:    html
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('[Welcome] Resend error:', data);
      return res.status(400).json({ error: 'Failed to send email' });
    }
    return res.status(200).json({ ok: true });

  } catch(e) {
    console.error('[Welcome] Exception:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
