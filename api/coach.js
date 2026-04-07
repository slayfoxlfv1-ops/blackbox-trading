// api/coach.js
// AI Coach endpoint — conecta el dashboard con Claude (Anthropic)
// Rate limit: máximo 5 llamadas por usuario por mes (guardado en Supabase)
// Modelo: claude-haiku-4-5-20251001 (barato + funcional)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;

const MAX_CALLS_PER_MONTH = 5;
const MODEL               = 'claude-haiku-4-5-20251001';
const MAX_TOKENS          = 1000;

// ── Obtener el mes actual como clave (ej: "2026-04") ──
function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

// ── Leer el contador de llamadas del usuario en Supabase ──
async function getCallCount(userId, monthKey) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_usage?user_id=eq.${encodeURIComponent(userId)}&month=eq.${monthKey}&select=call_count`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    }
  );
  if (!resp.ok) return 0;
  const rows = await resp.json();
  return rows.length ? (rows[0].call_count || 0) : 0;
}

// ── Incrementar el contador en Supabase (upsert) ──
async function incrementCallCount(userId, monthKey, currentCount) {
  await fetch(`${SUPABASE_URL}/rest/v1/coach_usage`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      user_id:    userId,
      month:      monthKey,
      call_count: currentCount + 1,
      updated_at: new Date().toISOString()
    })
  });
}

// ── Verificar que el usuario tiene plan activo ──
async function getUserPlan(userId) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=plan,plan_expires_at`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    }
  );
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows.length ? rows[0] : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── Validar que tenemos las env vars necesarias ──
  if (!ANTHROPIC_API_KEY) {
    console.error('[Coach] ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'AI Coach not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[Coach] Supabase env vars missing');
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { prompt, max_tokens, user_id } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const monthKey = currentMonthKey();

  // ── Rate limit: verificar si el usuario está autenticado ──
  // El user_id viene del dashboard (currentUser.id de Supabase)
  if (user_id) {
    try {
      // Verificar plan activo
      const profile = await getUserPlan(user_id);
      if (profile) {
        const isPro      = profile.plan === 'pro' || profile.plan === 'lifetime';
        const notExpired = !profile.plan_expires_at || new Date(profile.plan_expires_at) > new Date();
        if (!isPro || !notExpired) {
          return res.status(403).json({ error: 'Active subscription required' });
        }
      }

      // Verificar rate limit mensual
      const callCount = await getCallCount(user_id, monthKey);
      if (callCount >= MAX_CALLS_PER_MONTH) {
        const remaining = new Date();
        remaining.setMonth(remaining.getMonth() + 1);
        remaining.setDate(1);
        return res.status(429).json({
          error:     'Monthly coach limit reached',
          limit:     MAX_CALLS_PER_MONTH,
          used:      callCount,
          resets_at: remaining.toISOString().slice(0, 10)
        });
      }
    } catch (e) {
      console.warn('[Coach] Rate limit check failed (non-fatal):', e.message);
      // Si falla la verificación, dejamos pasar (mejor experiencia de usuario)
    }
  }

  // ── Llamar a Claude ──
  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: Math.min(max_tokens || MAX_TOKENS, MAX_TOKENS),
        system: `You are Pattro's AI Coach — a professional trading psychology coach.
You analyze trading data and provide personalized, direct, actionable feedback.
Rules:
- Always respond in the same language the prompt is written in
- Be direct and honest, not overly positive
- Use specific data from the prompt (numbers, patterns, timestamps)
- Keep responses under 400 words
- Structure: diagnosis → main error → what they did well → 2-3 concrete actions
- Never give financial advice or predict market direction`,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!claudeResp.ok) {
      const err = await claudeResp.json().catch(() => ({}));
      console.error('[Coach] Anthropic error:', claudeResp.status, err);

      // Errores conocidos de Anthropic
      if (claudeResp.status === 401) {
        return res.status(500).json({ error: 'AI Coach API key invalid' });
      }
      if (claudeResp.status === 529 || claudeResp.status === 503) {
        return res.status(503).json({ error: 'AI Coach temporarily unavailable, try again in a moment' });
      }
      return res.status(500).json({ error: 'AI Coach request failed' });
    }

    const claudeData = await claudeResp.json();
    const text = claudeData.content?.[0]?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'AI Coach returned empty response' });
    }

    // ── Incrementar contador solo si la llamada fue exitosa ──
    if (user_id) {
      try {
        const callCount = await getCallCount(user_id, monthKey);
        await incrementCallCount(user_id, monthKey, callCount);
      } catch (e) {
        console.warn('[Coach] Failed to increment call count:', e.message);
      }
    }

    // ── Devolver respuesta ──
    return res.status(200).json({
      text,
      usage: {
        input_tokens:  claudeData.usage?.input_tokens  || 0,
        output_tokens: claudeData.usage?.output_tokens || 0
      }
    });

  } catch (e) {
    console.error('[Coach] Exception:', e.message);
    return res.status(500).json({ error: 'AI Coach connection failed' });
  }
}
