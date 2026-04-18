const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleSignup(request, env) {
  const data = await request.json();
  const email = (data.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'Email is required' }, 400);

  const key = `signup:${email}`;
  const existing = await env.EMAIL_SIGNUPS.get(key);
  if (existing) return json({ ok: true, duplicate: true });

  await env.EMAIL_SIGNUPS.put(
    key,
    JSON.stringify({
      email,
      name: data.name || '',
      phone: data.phone || '',
      signal: data.signal || '',
      source: data.source || '',
      submitted_at: new Date().toISOString(),
    }),
  );

  return json({ ok: true });
}

async function handleOnboarding(request, env) {
  const data = await request.json();
  const id = `onboarding:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await env.ONBOARDING_RESPONSES.put(
    id,
    JSON.stringify({
      ...data,
      submitted_at: new Date().toISOString(),
    }),
  );

  return json({ ok: true });
}

async function handleFeedback(request, env) {
  const data = await request.json();
  const id = `feedback:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await env.WORKSHOP_FEEDBACK.put(
    id,
    JSON.stringify({
      ...data,
      submitted_at: new Date().toISOString(),
    }),
  );

  return json({ ok: true });
}

async function handleList(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const store = url.searchParams.get('store') || 'signups';

  const kv =
    store === 'onboarding'
      ? env.ONBOARDING_RESPONSES
      : store === 'feedback'
        ? env.WORKSHOP_FEEDBACK
        : env.EMAIL_SIGNUPS;

  const keys = await kv.list();
  const entries = await Promise.all(
    keys.keys.map(async (k) => {
      const val = await kv.get(k.name);
      return { key: k.name, data: JSON.parse(val) };
    }),
  );

  return json({ count: entries.length, entries });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST') {
      if (path === '/signup') return handleSignup(request, env);
      if (path === '/onboarding') return handleOnboarding(request, env);
      if (path === '/feedback') return handleFeedback(request, env);
    }

    if (request.method === 'GET' && path === '/list') {
      return handleList(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },
};
