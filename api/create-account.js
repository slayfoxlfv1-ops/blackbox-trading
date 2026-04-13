// api/create-account.js
// Called by paddle-webhook.js after a successful payment
// Uses service_role key to create Supabase account server-side

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function createUserAccount({ email, username, full_name, country, plan = 'pro' }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase service key not configured');
  }

  const headers = {
    'apikey':        SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json'
  };

  // ── Step 1: Create auth user via Admin API ──
  // Uses invite flow — sends a magic link email to the user
  const inviteResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      email,
      email_confirm: true,  // auto-confirm email
      user_metadata: { username, full_name }
    })
  });

  const inviteData = await inviteResp.json();

  // Handle "user already exists" gracefully
  let userId = inviteData.id;
  if (!userId && inviteData.msg && inviteData.msg.includes('already been registered')) {
    // User exists — find their ID
    const listResp = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers }
    );
    const listData = await listResp.json();
    userId = listData.users && listData.users[0] && listData.users[0].id;
  }

  if (!userId) {
    throw new Error(`Failed to create user: ${JSON.stringify(inviteData)}`);
  }

  // ── Step 2: Save profile with pro plan ──
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);

  const profileResp = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method:  'POST',
    headers: {
      ...headers,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      id:              userId,
      email,
      username:        username || email.split('@')[0],
      full_name:       full_name || '',
      country:         country || '',
      plan,
      plan_expires_at: expires.toISOString()
    })
  });

  if (!profileResp.ok) {
    const profileErr = await profileResp.text();
    throw new Error(`Failed to save profile: ${profileErr}`);
  }

  // ── Step 3: Send password setup email ──
  // Sends a magic link so user can set their password and log in
  await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      type:       'magiclink',
      email,
      options: {
        redirect_to: 'https://www.pattro.com/dashboard?payment=success'
      }
    })
  });

  return { userId, email };
}
