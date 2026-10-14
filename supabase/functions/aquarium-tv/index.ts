import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });
const encoder = new TextEncoder();
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}
function randomCode() {
  const data = crypto.getRandomValues(new Uint32Array(1))[0];
  return String(data % 1_000_000).padStart(6, '0');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Сервер не настроен: отсутствуют параметры Supabase.' }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/aquarium-tv/, '') || '/';

  if (path === '/tv/pair/create' && req.method === 'POST') {
    let body: { deviceToken?: string } = {};
    try { body = await req.json(); } catch { /* empty body is allowed */ }
    let token = typeof body.deviceToken === 'string' && body.deviceToken.length <= 128 ? body.deviceToken : '';
    let tokenHash = token ? await sha256(token) : '';
    let device = tokenHash ? await admin.from('tv_devices').select('device_token_hash').eq('device_token_hash', tokenHash).maybeSingle() : { data: null, error: null };
    if (device.error) return json({ error: 'Не удалось подготовить подключение.' }, 500);
    if (!device.data) {
      token = randomHex(32);
      tokenHash = await sha256(token);
      const inserted = await admin.from('tv_devices').insert({ device_token_hash: tokenHash, owner_id: null }).select('device_token_hash').single();
      if (inserted.error) return json({ error: 'Не удалось создать устройство. Попробуй ещё раз.' }, 500);
    } else {
      const reset = await admin.from('tv_devices').update({ owner_id: null, last_seen_at: new Date().toISOString() }).eq('device_token_hash', tokenHash);
      if (reset.error) return json({ error: 'Не удалось обновить устройство.' }, 500);
      await admin.from('tv_pair_codes').delete().eq('device_token_hash', tokenHash);
    }
    const code = randomCode();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const saved = await admin.from('tv_pair_codes').insert({ code_hash: await sha256(code), device_token_hash: tokenHash, expires_at: new Date(expiresAt * 1000).toISOString() });
    if (saved.error) return json({ error: 'Не удалось сохранить код подключения.' }, 500);
    return json({ deviceToken: token, code, expiresAt });
  }

  if (path === '/tv/state' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    if (token.length < 32 || token.length > 128) return json({ error: 'Токен телевизора неверный.' }, 401);
    const tokenHash = await sha256(token);
    const found = await admin.from('tv_devices').select('device_token_hash,owner_id').eq('device_token_hash', tokenHash).maybeSingle();
    if (found.error || !found.data) return json({ error: 'Устройство не найдено. Обнови код на телевизоре.' }, 401);
    await admin.from('tv_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_token_hash', tokenHash);
    if (!found.data.owner_id) {
      const latest = await admin.from('tv_pair_codes').select('expires_at,claimed_at').eq('device_token_hash', tokenHash).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const expired = !latest.data || new Date(latest.data.expires_at).getTime() <= Date.now();
      return json({ paired: false, expired });
    }
    const ownerId = found.data.owner_id;
    const [aq, fishResult, decorResult] = await Promise.all([
      admin.from('aquariums').select('background,settings,updated_at').eq('user_id', ownerId).maybeSingle(),
      admin.from('fish').select('id,name,object_key,width,height,created_at').eq('user_id', ownerId).order('created_at', { ascending: true }),
      admin.from('decorations').select('id,kind,x,y,created_at').eq('user_id', ownerId).order('created_at', { ascending: true }),
    ]);
    if (aq.error || fishResult.error || decorResult.error) return json({ error: 'Не удалось загрузить аквариум.' }, 500);
    const fish = (await Promise.all((fishResult.data || []).map(async (item) => {
      const signed = await admin.storage.from('fish-images').createSignedUrl(item.object_key, 86400);
      if (signed.error || !signed.data?.signedUrl) return null;
      return { id: item.id, name: item.name, width: item.width, height: item.height, imageUrl: signed.data.signedUrl };
    }))).filter((item) => item !== null);
    return json({
      paired: true,
      aquarium: { background: aq.data?.background || 'neutral', settings: aq.data?.settings || { speed: 1, bubbles: true }, updatedAt: aq.data?.updated_at || null },
      fish,
      decorations: decorResult.data || [],
    });
  }
  return json({ error: 'Неизвестный запрос.' }, 404);
});
