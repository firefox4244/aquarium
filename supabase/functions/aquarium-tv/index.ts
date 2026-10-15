// Supabase Edge Function: aquarium-tv
// Обрабатывает подключение ТВ и отдаёт состояние аквариума.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/aquarium-tv/, '');

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // --- Создать код подключения ---
    if (path === '/tv/pair/create' && req.method === 'POST') {
      const { deviceToken } = await req.json().catch(() => ({}));

      let token = deviceToken;
      if (!token) {
        token = crypto.randomUUID() + crypto.randomUUID();
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await sb.from('tv_devices').upsert({
        device_token: token,
        pair_code: code,
        code_expires_at: expiresAt,
        paired_user_id: null,
      }, { onConflict: 'device_token' });

      return json({
        deviceToken: token,
        code,
        expiresAt: Math.floor(new Date(expiresAt).getTime() / 1000),
      });
    }

    // --- Состояние аквариума для ТВ ---
    if (path === '/tv/state' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return json({ error: 'Missing token' }, 400);

      const { data: device } = await sb
        .from('tv_devices')
        .select('*')
        .eq('device_token', token)
        .maybeSingle();

      if (!device) return json({ error: 'Device not found' }, 404);

      if (!device.paired_user_id) {
        const expired = device.code_expires_at
          ? new Date(device.code_expires_at).getTime() < Date.now()
          : true;
        return json({ paired: false, expired });
      }

      const userId = device.paired_user_id;

      const { data: aquarium } = await sb
        .from('aquariums')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      const { data: fish } = await sb
        .from('fish')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      const { data: decorations } = await sb
        .from('decorations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      // Подписанные ссылки на изображения
      const fishWithUrls = [];
      for (const row of fish || []) {
        const { data: signed } = await sb.storage
          .from('fish-images')
          .createSignedUrl(row.object_key, 86400);
        fishWithUrls.push({ ...row, imageUrl: signed?.signedUrl || '' });
      }

      return json({
        paired: true,
        aquarium: {
          background: aquarium?.background || 'neutral',
          settings: aquarium?.settings || {},
        },
        fish: fishWithUrls,
        decorations: decorations || [],
      });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message || 'Server error' }, 500);
  }
});