// ============================================================
//  Утилиты
// ============================================================

const $ = (id) => document.getElementById(id);

const state = {
  fishFile: null,
  previewBlob: null,
  aquarium: null,
  fish: [],
  decorations: [],
};

const decorationEmoji = {
  chest: '🪙 Сундук',
  coral: '🪸 Кораллы',
  seaweed: '🌿 Растение',
  statue: '🗿 Статуя',
  ruins: '🏛️ Руины',
  shell: '🐚 Ракушка',
};

// ============================================================
//  Supabase
// ============================================================

let sbPromise;

async function getSupabase() {
  if (!sbPromise) {
    sbPromise = (async () => {
      const cfg = window.AQUARIUM_CONFIG || {};

      const isPlaceholder =
        !cfg.SUPABASE_URL ||
        !cfg.SUPABASE_ANON_KEY ||
        cfg.SUPABASE_URL.includes('YOUR_PROJECT') ||
        cfg.SUPABASE_ANON_KEY.includes('YOUR_SUPABASE');

      if (isPlaceholder) {
        throw new Error(
          'Сначала укажи SUPABASE_URL и SUPABASE_ANON_KEY в файле config.js. Инструкция есть в README.'
        );
      }

      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');

      return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    })();
  }

  return sbPromise;
}

function throwIfError(error) {
  if (!error) return;

  const raw = error.message || 'Запрос не выполнен.';
  let message = raw;

  if (/anonymous.*disabled|anonymous sign-ins are disabled/i.test(raw)) {
    message = 'Включи Anonymous Sign-Ins в настройках Authentication проекта Supabase.';
  } else if (/row-level security/i.test(raw)) {
    message = 'Доступ запрещён политикой безопасности. Проверь SQL-миграцию.';
  } else if (/rate limit/i.test(raw)) {
    message = 'Слишком много запросов. Подожди немного и попробуй снова.';
  }

  throw new Error(message);
}

async function currentUser(sb) {
  const { data, error } = await sb.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Сначала войди в аккаунт.');
  return data.user;
}

async function signedFish(sb, rows) {
  const result = [];

  for (const row of rows || []) {
    const { data, error } = await sb.storage
      .from('fish-images')
      .createSignedUrl(row.object_key, 86400);

    throwIfError(error);
    result.push({ ...row, imageUrl: data.signedUrl });
  }

  return result;
}

// ============================================================
//  API (тонкая обёртка над Supabase)
// ============================================================

async function api(path, options = {}) {
  const sb = await getSupabase();
  const url = new URL(path, location.origin);
  const method = (options.method || 'GET').toUpperCase();

  const body = options.body instanceof FormData
    ? options.body
    : typeof options.body === 'string'
      ? (() => {
          try {
            return JSON.parse(options.body);
          } catch {
            return {};
          }
        })()
      : options.body || {};

  const p = url.pathname;

  // --- Состояние аквариума ---
  if (p === '/api/state' && method === 'GET') {
    const user = await currentUser(sb);

    let { data: aquarium, error } = await sb
      .from('aquariums')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    throwIfError(error);

    if (!aquarium) {
      const created = await sb
        .from('aquariums')
        .insert({ user_id: user.id })
        .select('*')
        .single();
      throwIfError(created.error);
      aquarium = created.data;
    }

    const fishQuery = await sb
      .from('fish')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    throwIfError(fishQuery.error);

    const decorQuery = await sb
      .from('decorations')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    throwIfError(decorQuery.error);

    return {
      user: { id: user.id, anonymous: !!user.is_anonymous },
      aquarium: {
        background: aquarium.background || 'neutral',
        settings: aquarium.settings || {},
        updatedAt: aquarium.updated_at,
      },
      fish: await signedFish(sb, fishQuery.data),
      decorations: decorQuery.data || [],
    };
  }

  // --- Фон аквариума ---
  if (p === '/api/aquarium/background' && method === 'POST') {
    const user = await currentUser(sb);
    const allowed = ['neutral', 'ocean', 'freshwater', 'night', 'reef'];

    if (!allowed.includes(body.background)) {
      throw new Error('Неизвестный фон.');
    }

    const { error } = await sb.from('aquariums').upsert({
      user_id: user.id,
      background: body.background,
      updated_at: new Date().toISOString(),
    });
    throwIfError(error);

    return { ok: true };
  }

  // --- Настройки аквариума ---
  if (p === '/api/aquarium/settings' && method === 'POST') {
    const user = await currentUser(sb);
    const settings = {
      speed: Math.max(0.4, Math.min(2.2, Number(body.settings?.speed) || 1)),
      bubbles: body.settings?.bubbles !== false,
    };

    const { error } = await sb.from('aquariums').upsert({
      user_id: user.id,
      settings,
      updated_at: new Date().toISOString(),
    });
    throwIfError(error);

    return { ok: true };
  }

  // --- Добавить рыбку ---
  if (p === '/api/fish' && method === 'POST') {
    const user = await currentUser(sb);
    const image = body instanceof FormData ? body.get('image') : null;

    if (!(image instanceof File) || !image.type.startsWith('image/')) {
      throw new Error('Не найден файл изображения.');
    }
    if (image.size > 8 * 1024 * 1024) {
      throw new Error('Обработанное изображение должно быть меньше 8 МБ.');
    }

    const id = crypto.randomUUID();
    const objectKey = `${user.id}/${id}.png`;

    const uploaded = await sb.storage
      .from('fish-images')
      .upload(objectKey, image, { contentType: 'image/png', upsert: false });
    throwIfError(uploaded.error);

    const name = String(body.get('name') || 'Моя рыбка').trim().slice(0, 80) || 'Моя рыбка';
    const width = Math.max(1, Math.min(5000, Number(body.get('width')) || 1));
    const height = Math.max(1, Math.min(5000, Number(body.get('height')) || 1));

    const inserted = await sb
      .from('fish')
      .insert({ id, user_id: user.id, name, object_key: objectKey, width, height })
      .select('*')
      .single();

    if (inserted.error) {
      await sb.storage.from('fish-images').remove([objectKey]);
      throwIfError(inserted.error);
    }

    return { ok: true, fish: inserted.data };
  }

  // --- Удалить всех рыбок ---
  if (p === '/api/fish' && method === 'DELETE') {
    const user = await currentUser(sb);
    const rows = await sb.from('fish').select('object_key').eq('user_id', user.id);
    throwIfError(rows.error);

    if (rows.data?.length) {
      const removed = await sb.storage
        .from('fish-images')
        .remove(rows.data.map((x) => x.object_key));
      throwIfError(removed.error);
    }

    const deleted = await sb.from('fish').delete().eq('user_id', user.id);
    throwIfError(deleted.error);

    return { ok: true };
  }

  // --- Удалить одну рыбку ---
  const fishId = p.match(/^\/api\/fish\/([^/]+)$/);
  if (fishId && method === 'DELETE') {
    const user = await currentUser(sb);
    const row = await sb
      .from('fish')
      .select('id,object_key')
      .eq('id', fishId[1])
      .eq('user_id', user.id)
      .maybeSingle();
    throwIfError(row.error);

    if (!row.data) throw new Error('Рыбка не найдена.');

    const removed = await sb.storage.from('fish-images').remove([row.data.object_key]);
    throwIfError(removed.error);

    const deleted = await sb
      .from('fish')
      .delete()
      .eq('id', fishId[1])
      .eq('user_id', user.id);
    throwIfError(deleted.error);

    return { ok: true };
  }

  // --- Добавить декорацию ---
  if (p === '/api/decorations' && method === 'POST') {
    const user = await currentUser(sb);
    const kinds = ['chest', 'coral', 'seaweed', 'statue', 'ruins', 'shell'];

    if (!kinds.includes(body.kind)) {
      throw new Error('Неизвестная декорация.');
    }

    const inserted = await sb
      .from('decorations')
      .insert({
        user_id: user.id,
        kind: body.kind,
        x: Math.max(0, Math.min(1, Number(body.x) || 0.5)),
        y: Math.max(0, Math.min(1, Number(body.y) || 0.82)),
      })
      .select('*')
      .single();
    throwIfError(inserted.error);

    return { ok: true, decoration: inserted.data };
  }

  // --- Удалить декорацию ---
  const decorId = p.match(/^\/api\/decorations\/([^/]+)$/);
  if (decorId && method === 'DELETE') {
    const user = await currentUser(sb);
    const { error } = await sb
      .from('decorations')
      .delete()
      .eq('id', decorId[1])
      .eq('user_id', user.id);
    throwIfError(error);

    return { ok: true };
  }

  // --- Привязка ТВ по коду ---
  if (p === '/api/tv/pair/claim' && method === 'POST') {
    const user = await currentUser(sb);
    const { data, error } = await sb.rpc('claim_tv_pair', {
      p_code: String(body.code || ''),
    });
    throwIfError(error);

    if (!data?.ok) {
      throw new Error(data?.message || 'Код неверный, истёк или уже использован.');
    }

    return { message: 'Телевизор подключён к твоему аквариуму.' };
  }

  throw new Error(`Неизвестный запрос: ${method} ${p}`);
}

// ============================================================
//  UI-хелперы
// ============================================================

function showMsg(el, message, error = false) {
  el.textContent = message || '';
  el.classList.toggle('error', !!error);
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// ============================================================
//  Загрузка приложения
// ============================================================

$('authMsg').textContent =
  'Подключаемся к облаку. Регистрация и электронная почта не нужны.';

async function loadApp() {
  const data = await api('/api/state');

  state.aquarium = data.aquarium;
  state.fish = data.fish;
  state.decorations = data.decorations;

  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('welcomeEmail').textContent =
    'Аквариум привязан к этому браузеру. Для ТВ используй QR-код или шестизначный код.';

  $('background').value = data.aquarium.background;
  $('speed').value = data.aquarium.settings.speed || 1;
  $('bubbles').checked = data.aquarium.settings.bubbles !== false;

  renderFish();
  renderDecorations();
}

async function init() {
  try {
    const sb = await getSupabase();
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    throwIfError(sessionError);

    if (!sessionData.session) {
      const { error } = await sb.auth.signInAnonymously();
      throwIfError(error);
    }

    await loadApp();
  } catch (e) {
    const message =
      /anonymous.*disabled|anonymous sign-ins are disabled/i.test(e.message || '')
        ? 'В Supabase нужно включить Anonymous Sign-Ins: Authentication → Sign In / Providers → Anonymous. После этого обнови страницу.'
        : e.message ||
          'Не удалось подключиться к Supabase. Проверь config.js и настройки проекта.';

    showMsg($('authMsg'), message, true);
  }
}

// ============================================================
//  Вкладки
// ============================================================

function setTab(tab) {
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.tab-panel').forEach((el) =>
    el.classList.toggle('hidden', el.id !== `tab-${tab}`)
  );
}

document.querySelectorAll('.nav-item').forEach((button) =>
  button.addEventListener('click', () => setTab(button.dataset.tab))
);

// ============================================================
//  Фон и настройки
// ============================================================

$('background').addEventListener('change', async () => {
  try {
    await api('/api/aquarium/background', {
      method: 'POST',
      body: JSON.stringify({ background: $('background').value }),
    });
    toast('Фон сохранён');
  } catch (e) {
    toast(e.message);
  }
});

$('saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/aquarium/settings', {
      method: 'POST',
      body: JSON.stringify({
        settings: {
          speed: Number($('speed').value),
          bubbles: $('bubbles').checked,
        },
      }),
    });
    toast('Настройки сохранены');
  } catch (e) {
    toast(e.message);
  }
});

// ============================================================
//  Декорации
// ============================================================

document.querySelectorAll('[data-decoration]').forEach((button) =>
  button.addEventListener('click', async () => {
    try {
      await api('/api/decorations', {
        method: 'POST',
        body: JSON.stringify({
          kind: button.dataset.decoration,
          x: 0.2 + Math.random() * 0.6,
          y: 0.72 + Math.random() * 0.2,
        }),
      });

      const data = await api('/api/state');
      state.decorations = data.decorations;
      renderDecorations();
      toast('Декорация добавлена');
    } catch (e) {
      toast(e.message);
    }
  })
);

function renderDecorations() {
  const list = $('decorList');
  list.replaceChildren();

  if (!state.decorations.length) {
    const p = document.createElement('p');
    p.className = 'muted tiny';
    p.textContent = 'Декораций пока нет.';
    list.append(p);
    return;
  }

  for (const item of state.decorations) {
    const chip = document.createElement('span');
    chip.className = 'decor-chip';
    chip.textContent = decorationEmoji[item.kind] || item.kind;

    const del = document.createElement('button');
    del.textContent = '×';
    del.setAttribute('aria-label', 'Удалить декорацию');
    del.style.cssText = 'padding:0 0 0 7px;background:none;color:#a52b35';

    del.addEventListener('click', async () => {
      try {
        await api(`/api/decorations/${item.id}`, { method: 'DELETE' });
        state.decorations = state.decorations.filter((d) => d.id !== item.id);
        renderDecorations();
      } catch (e) {
        toast(e.message);
      }
    });

    chip.append(del);
    list.append(chip);
  }
}

// ============================================================
//  Рыбки
// ============================================================

function renderFish() {
  const list = $('fishList');
  list.replaceChildren();

  if (!state.fish.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'Здесь пока пусто. Добавь первый рисунок рыбки — и он оживёт на экране.';
    list.append(empty);
    return;
  }

  for (const fish of state.fish) {
    const card = document.createElement('article');
    card.className = 'fish-card';

    const img = document.createElement('img');
    img.src = fish.imageUrl;
    img.alt = fish.name;
    img.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'fish-meta';

    const name = document.createElement('b');
    name.textContent = fish.name;

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Удалить';
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить рыбку «${fish.name}»?`)) return;
      try {
        await api(`/api/fish/${fish.id}`, { method: 'DELETE' });
        state.fish = state.fish.filter((f) => f.id !== fish.id);
        renderFish();
      } catch (e) {
        toast(e.message);
      }
    });

    meta.append(name, del);
    card.append(img, meta);
    list.append(card);
  }
}

// ============================================================
//  Обработка изображения: удаление фона бумаги
// ============================================================

// Удаляем только примыкающие к краям почти-белые пиксели,
// чтобы белые детали внутри рисунка сохранились.
async function removePaperBackground(file) {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const total = width * height;

  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const nearWhite = (i) => {
    const p = i * 4;
    const r = px[p];
    const g = px[p + 1];
    const b = px[p + 2];
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    return min > 184 && max - min < 48 && (r + g + b) / 3 > 198;
  };

  const push = (i) => {
    if (i < 0 || i >= total || seen[i] || !nearWhite(i)) return;
    seen[i] = 1;
    queue[tail++] = i;
  };

  // Заполняем очередь граничными пикселями.
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  // BFS по почти-белым пикселям.
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x + 1 < width) push(i + 1);
    if (i >= width) push(i - width);
    if (i + width < total) push(i + width);
  }

  for (let i = 0; i < total; i++) {
    const p = i * 4;

    if (seen[i]) {
      px[p + 3] = 0;
    } else {
      const min = Math.min(px[p], px[p + 1], px[p + 2]);
      const max = Math.max(px[p], px[p + 1], px[p + 2]);

      // Смягчаем оставшуюся светлую кромку; внутренние белые области сохраняем.
      if (min > 190 && max - min < 35) {
        px[p + 3] = Math.min(px[p + 3], Math.max(0, Math.round((255 - min) * 4)));
      }
    }
  }

  ctx.putImageData(image, 0, 0);

  // Обрезаем прозрачные поля бумаги, чтобы рыбка масштабировалась по рисунку, а не по всему фото.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error('Не удалось найти рисунок. Сними рыбку на более контрастном фоне.');
  }

  const pad = Math.max(4, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.035));

  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const cropped = document.createElement('canvas');
  cropped.width = cropW;
  cropped.height = cropH;
  cropped
    .getContext('2d')
    .drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

  const blob = await new Promise((resolve) => cropped.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Не удалось обработать изображение.');

  return {
    blob,
    width: cropW,
    height: cropH,
    url: URL.createObjectURL(blob),
  };
}

// ============================================================
//  Загрузка рыбки
// ============================================================

$('fishFile').addEventListener('change', async () => {
  const file = $('fishFile').files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showMsg($('fishMsg'), 'Выбери файл изображения.', true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showMsg($('fishMsg'), 'Исходная фотография должна быть меньше 15 МБ.', true);
    return;
  }

  showMsg($('fishMsg'), 'Удаляем фон бумаги…');
  $('uploadFish').disabled = true;

  try {
    const result = await removePaperBackground(file);

    if (state.previewBlob?.url) URL.revokeObjectURL(state.previewBlob.url);

    state.previewBlob = result;
    state.fishFile = file;

    $('preview').src = result.url;
    $('previewWrap').classList.remove('hidden');
    $('uploadFish').disabled = false;

    showMsg(
      $('fishMsg'),
      'Готово к загрузке. Если фон удалил светлые детали, попробуй фото при более ровном освещении.'
    );
  } catch (e) {
    showMsg($('fishMsg'), e.message, true);
  }
});

$('uploadFish').addEventListener('click', async () => {
  if (!state.previewBlob) return;

  const button = $('uploadFish');
  button.disabled = true;
  showMsg($('fishMsg'), 'Загружаем рыбку в облако…');

  try {
    const form = new FormData();
    form.append('image', state.previewBlob.blob, 'fish.png');
    form.append('name', $('fishName').value.trim() || 'Моя рыбка');
    form.append('width', String(state.previewBlob.width));
    form.append('height', String(state.previewBlob.height));

    await api('/api/fish', { method: 'POST', body: form });

    const data = await api('/api/state');
    state.fish = data.fish;
    renderFish();

    $('fishFile').value = '';
    $('fishName').value = '';
    $('previewWrap').classList.add('hidden');
    state.fishFile = null;

    if (state.previewBlob.url) URL.revokeObjectURL(state.previewBlob.url);
    state.previewBlob = null;

    showMsg($('fishMsg'), 'Рыбка сохранена! Она появится на экране телевизора.');
    toast('Рыбка добавлена');
  } catch (e) {
    showMsg($('fishMsg'), e.message, true);
  } finally {
    button.disabled = !state.previewBlob;
  }
});

$('clearFish').addEventListener('click', async () => {
  if (!confirm('Удалить всех рыбок из аквариума? Это действие нельзя отменить.')) return;

  try {
    await api('/api/fish', { method: 'DELETE', body: '{}' });
    state.fish = [];
    renderFish();
    toast('Все рыбки удалены');
  } catch (e) {
    toast(e.message);
  }
});

// ============================================================
//  Привязка телевизора
// ============================================================

$('pairTv').addEventListener('click', async () => {
  const code = $('pairCode').value.replace(/\D/g, '');

  if (code.length !== 6) {
    showMsg($('pairMsg'), 'Введите все 6 цифр.', true);
    return;
  }

  try {
    const data = await api('/api/tv/pair/claim', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    showMsg($('pairMsg'), data.message);
    $('pairCode').value = '';
    toast('Телевизор подключён');
  } catch (e) {
    showMsg($('pairMsg'), e.message, true);
  }
});

$('pairCode').addEventListener('input', () => {
  $('pairCode').value = $('pairCode').value.replace(/\D/g, '').slice(0, 6);
});

// ============================================================
//  Сканирование QR-кода
// ============================================================

let qrStream = null;
let qrScanning = false;

function stopQrScan() {
  qrScanning = false;

  if (qrStream) {
    qrStream.getTracks().forEach((track) => track.stop());
    qrStream = null;
  }

  $('qrVideo').srcObject = null;
  $('qrVideo').classList.add('hidden');
  $('scanQr').textContent = 'Сканировать QR';
}

$('scanQr').addEventListener('click', async () => {
  if (qrScanning) {
    stopQrScan();
    return;
  }

  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    showMsg(
      $('pairMsg'),
      'Сканирование QR не поддерживается этим браузером. Введи шестизначный код вручную.',
      true
    );
    return;
  }

  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });

    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    const video = $('qrVideo');
    video.srcObject = qrStream;
    video.classList.remove('hidden');
    await video.play();

    qrScanning = true;
    $('scanQr').textContent = 'Остановить камеру';
    showMsg($('pairMsg'), 'Наведи камеру на QR-код на телевизоре.');

    const scan = async () => {
      if (!qrScanning) return;

      try {
        const codes = await detector.detect(video);

        if (codes.length) {
          let value = codes[0].rawValue || '';

          try {
            const u = new URL(value);
            value = u.searchParams.get('code') || value;
          } catch {}

          const digits = value.match(/\d{6}/);

          if (digits) {
            $('pairCode').value = digits[0];
            stopQrScan();
            $('pairTv').click();
            return;
          }
        }
      } catch {}

      if (qrScanning) requestAnimationFrame(scan);
    };

    requestAnimationFrame(scan);
  } catch (e) {
    stopQrScan();
    showMsg(
      $('pairMsg'),
      'Не удалось открыть камеру. Проверь разрешение на использование камеры или введи код вручную.',
      true
    );
  }
});

window.addEventListener('pagehide', stopQrScan);

// ============================================================
//  Запуск
// ============================================================

init();