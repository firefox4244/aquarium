/* =========================================================
   АКВАРИУМ ДЛЯ ТВ — основной скрипт
   ========================================================= */

const canvas   = document.getElementById('tank');
const ctx      = canvas.getContext('2d');
const panel    = document.getElementById('tvPanel');
const tvCode   = document.getElementById('tvCode');
const tvStatus = document.getElementById('tvStatus');
const tvHint   = document.getElementById('tvHint');
const tvCornerCode = document.getElementById('tvCornerCode');
const tvCornerCodeValue = document.getElementById('tvCornerCodeValue');

const EMOJI = {
  chest:   '🪙',
  coral:   '🪸',
  seaweed: '🌿',
  statue:  '🗿',
  ruins:   '🏛️',
  shell:   '🐚',
};

const BACKGROUNDS = {
  neutral:    ['#5a8a7a', '#3a6a6a', '#1a3a4a'],  // обычный аквариум с растениями
  ocean:      ['#1a4a6a', '#0a2a4a', '#02121f'],  // морской, глубокий
  freshwater: ['#4a7a5a', '#2a5a3a', '#0f2a1f'],  // пруд с растениями
  night:      ['#0a1a2a', '#050f1a', '#02060d'],  // ночной, с синей подсветкой
  reef:       ['#2a6a7a', '#1a4a5a', '#0a2a3a'],  // риф, бирюзово-серый
};

/* ---------- Глобальное состояние ---------- */

let state         = null;
let lastStateJson = '';
let lastPoll      = 0;
let lastFrame     = 0;
let w = 0, h = 0;
let dpr           = 1;
let bubbleSeed    = 0;
let bubbles       = [];

let fishes       = new Map();
let images       = new Map();
let decorations  = [];

let deviceToken  = localStorage.getItem('aquarium_tv_device_token') || '';
let initialized  = false;
let lastImageRefresh = 0;
let codeExpiry   = 0;
let codeTimer    = null;

/* =========================================================
   УТИЛИТЫ
   ========================================================= */

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/* =========================================================
   РАЗМЕРЫ ХОЛСТА И ПУЗЫРИ
   ========================================================= */

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = window.innerWidth;
  h = window.innerHeight;

  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const count = Math.min(42, Math.round(w / 38));
  bubbles = Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: rand(1.5, 5),
    v: rand(8, 26),
    a: rand(0.12, 0.35),
    phase: rand(0, 6),
  }));
}

window.addEventListener('resize', resize);
resize();

/* =========================================================
   СТАТУС КОДА ПОДКЛЮЧЕНИЯ
   ========================================================= */

function setCodeStatus(message, error = false) {
  tvStatus.textContent = message;
  tvStatus.style.color = error ? '#ffb8bd' : '#c5dfe7';
}

/* =========================================================
   ГЕНЕРАЦИЯ QR-КОДА (Model 2, Version 1-L, mask 0)
   ========================================================= */

function qrCodewords(value) {
  const bits = [];
  const put = (n, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((n >>> i) & 1);
  };

  put(1, 4);
  put(value.length, 10);

  for (let i = 0; i < value.length; i += 3) {
    const part = value.slice(i, i + 3);
    put(Number(part), part.length === 3 ? 10 : part.length === 2 ? 7 : 4);
  }

  for (let i = 0; i < Math.min(4, 152 - bits.length); i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    data.push(b);
  }

  for (let pad = 0; data.length < 19; pad++) {
    data.push(pad % 2 ? 0x11 : 0xec);
  }

  const mul = (a, b) => {
    let out = 0;
    while (b) {
      if (b & 1) out ^= a;
      a <<= 1;
      if (a & 0x100) a ^= 0x11d;
      b >>= 1;
    }
    return out;
  };

  const polyMul = (a, b) => {
    const out = Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        out[i + j] ^= mul(a[i], b[j]);
      }
    }
    return out;
  };

  let gen = [1];
  let alpha = 1;
  for (let i = 0; i < 7; i++) {
    gen = polyMul(gen, [1, alpha]);
    alpha = mul(alpha, 2);
  }

  const msg = data.concat(Array(7).fill(0));
  for (let i = 0; i < 19; i++) {
    const factor = msg[i];
    if (factor) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= mul(gen[j], factor);
      }
    }
  }

  return data.concat(msg.slice(19));
}

function makeQrMatrix(value) {
  const size = 21;
  const m = Array.from({ length: size }, () => Array(size).fill(null));

  const set = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = !!v;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inside && (
          r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        );
        set(rr, cc, dark);
      }
    }
  };

  finder(0, 0);
  finder(0, 14);
  finder(14, 0);

  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === null) set(6, i, i % 2 === 0);
    if (m[i][6] === null) set(i, 6, i % 2 === 0);
  }

  // Зарезервировать области формата перед укладкой данных
  for (let i = 0; i <= 5; i++) set(i, 8, false);
  set(7, 8, false);
  set(8, 8, false);
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, false);

  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);
  set(8, 7, false);
  for (let i = 9; i < 15; i++) set(8, 15 - i - 1, false);
  set(size - 8, 8, true);

  const codewords = qrCodewords(value);
  const stream = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) stream.push((cw >>> i) & 1);
  }

  let index = 0;
  let up = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (m[row][col] !== null) continue;
        let bit = stream[index++] || 0;
        if ((row + col) % 2 === 0) bit ^= 1;
        set(row, col, bit);
      }
    }
    up = !up;
  }

  const formatData = 8;
  let rem = formatData << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  const format = ((formatData << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 6; i++) set(i, 8, (format >>> i) & 1);
  set(7, 8, (format >>> 6) & 1);
  set(8, 8, (format >>> 7) & 1);
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, (format >>> i) & 1);

  for (let i = 0; i < 8; i++) set(8, size - 1 - i, (format >>> i) & 1);
  set(8, 7, (format >>> 8) & 1);
  for (let i = 9; i < 15; i++) set(8, 15 - i - 1, (format >>> i) & 1);
  set(size - 8, 8, true);

  return m;
}

function renderQr(code) {
  const c = document.getElementById('pairQr');
  if (!c) return;

  const g = c.getContext('2d');
  const matrix = makeQrMatrix(code);
  const scale = 5;
  const margin = 4;

  c.width = c.height = (21 + margin * 2) * scale;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);

  g.fillStyle = '#001b2d';
  for (let r = 0; r < 21; r++) {
    for (let col = 0; col < 21; col++) {
      if (matrix[r][col]) {
        g.fillRect((col + margin) * scale, (r + margin) * scale, scale, scale);
      }
    }
  }
}

/* =========================================================
   ЗАПРОСЫ К СЕРВЕРУ
   ========================================================= */

async function getJson(path, options = {}) {
  const cfg = window.AQUARIUM_CONFIG || {};

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR_PROJECT')) {
    throw new Error('Сначала настрой config.js по инструкции README.');
  }

  const route = path.replace(/^\/api/, '');
  const r = await fetch(`${cfg.SUPABASE_URL}/functions/v1/aquarium-tv${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'apikey': cfg.SUPABASE_ANON_KEY,
      ...(options.headers || {}),
    },
  });

  const d = await r.json();
  if (!r.ok) throw new Error(d.error || d.message || 'Ошибка запроса');
  return d;
}

/* =========================================================
   ПОДКЛЮЧЕНИЕ ТВ (код + QR)
   ========================================================= */

async function createCode() {
  try {
    const d = await getJson('/tv/pair/create', {
      method: 'POST',
      body: JSON.stringify({ deviceToken }),
    });

    initialized = true;
    deviceToken = d.deviceToken;
    localStorage.setItem('aquarium_tv_device_token', deviceToken);

    tvCode.textContent = d.code;
    renderQr(d.code);
	tvCornerCodeValue.textContent = d.code;
	tvCornerCode.classList.remove('hidden');

    codeExpiry = d.expiresAt * 1000;
    panel.classList.remove('hidden');
    tvHint.classList.add('hidden');

    setCodeStatus('Введи этот код в разделе «Подключение ТВ» на телефоне.');

    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((codeExpiry - Date.now()) / 1000));

      if (seconds <= 0) {
        setCodeStatus('Код истёк. Нажми «Обновить код».', true);
        clearInterval(codeTimer);
      } else {
        const mm = Math.floor(seconds / 60);
        const ss = String(seconds % 60).padStart(2, '0');
        setCodeStatus(`Код действует ещё ${mm}:${ss}. Введи его на телефоне.`);
      }
    }, 1000);
  } catch (e) {
    setCodeStatus(e.message, true);
  }
}

document.getElementById('newCode').addEventListener('click', createCode);

document.getElementById('fullscreen').addEventListener('click', () => {
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f' && !e.repeat && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
});

/* =========================================================
   РЫБЫ
   ========================================================= */

function makeFish(item) {
  let f = fishes.get(item.id);

  if (!f) {
    f = {
      id: item.id,
      x: rand(w * 0.15, w * 0.85),
      y: rand(h * 0.2, h * 0.75),
      vx: rand(-35, 35),
      vy: rand(-15, 15),
      speed: rand(24, 65),
      phase: rand(0, Math.PI * 2),
      turn: rand(1, 2.8),
      targetX: rand(w * 0.1, w * 0.9),
      targetY: rand(h * 0.15, h * 0.8),
      targetTime: 0,
      scale: rand(0.72, 1.28),
      width: 100,
      height: 65,
      image: null,
      angle: 0,
    };
    fishes.set(item.id, f);
  }

  f.name = item.name;
  f.baseW = item.width || 800;
  f.baseH = item.height || 600;

  const newSrc = new URL(item.imageUrl, location.href).href;
  if (!f.image || f.image.src !== newSrc) {
    const img = new Image();
    img.onload = () => { f.image = img; };
    img.onerror = () => { f.image = null; };
    img.src = item.imageUrl;
  }

  return f;
}

function applyState(next) {
  const wanted = new Set((next.fish || []).map((f) => f.id));

  for (const id of fishes.keys()) {
    if (!wanted.has(id)) fishes.delete(id);
  }

  (next.fish || []).forEach(makeFish);
  decorations = next.decorations || [];
  state = next;

  if (!fishes.size && next.fish?.length) next.fish.forEach(makeFish);
}

/* =========================================================
   ОПРОС СЕРВЕРА
   ========================================================= */

async function poll() {
  if (!deviceToken) {
    await createCode();
    return;
  }

  try {
    const next = await getJson(`/tv/state?token=${encodeURIComponent(deviceToken)}`);

    if (!next.paired) {
      panel.classList.remove('hidden');
      if (!initialized || next.expired) {
        await createCode();
        return;
      }
      setCodeStatus('Ожидаем, пока ты введёшь код на телефоне…');
      return;
    }

    initialized = true;

    const refreshImages = Date.now() - lastImageRefresh > 20 * 60 * 60 * 1000;
    const sig = JSON.stringify({
      aquarium: next.aquarium,
      fish: next.fish.map((f) => [f.id, f.name, f.width, f.height]),
      decorations: next.decorations,
      refreshImages: refreshImages ? Date.now() : 0,
    });

    if (sig !== lastStateJson) {
      applyState(next);
      lastStateJson = sig;
      if (refreshImages) lastImageRefresh = Date.now();
    }

    panel.classList.add('hidden');
    tvHint.classList.remove('hidden');
  } catch (e) {
    setCodeStatus('Не удалось синхронизировать аквариум. Проверяем соединение…', true);
  }
}

/* =========================================================
   ОТРИСОВКА
   ========================================================= */

function gradient() {
  const key = state?.aquarium?.background || 'neutral';
  const c = BACKGROUNDS[key] || BACKGROUNDS.neutral;

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, c[0]);
  g.addColorStop(0.52, c[1]);
  g.addColorStop(1, c[2]);
  return g;
}

function drawBackground(dt, time) {
  ctx.fillStyle = gradient();
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(
    w * 0.5, h * 0.05, 2,
    w * 0.5, h * 0.05, Math.max(w, h) * 1.1
  );
  glow.addColorStop(0, '#ffffff22');
  glow.addColorStop(0.4, '#aaffff11');
  glow.addColorStop(1, '#00152b00');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Мягкие лучи света
  ctx.save();
  ctx.globalAlpha = 0.055;
  for (let i = 0; i < 5; i++) {
    const x = i * w / 4 + Math.sin(time * 0.00015 + i) * w * 0.035;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + w * 0.07, h * 0.72);
    ctx.lineTo(x + w * 0.16, h * 0.72);
    ctx.lineTo(x + w * 0.09, 0);
    ctx.closePath();
    ctx.fillStyle = '#b8ffff';
    ctx.fill();
  }
  ctx.restore();

  const settings = state?.aquarium?.settings || {};
  if (settings.bubbles === false) return;

  for (const b of bubbles) {
    b.y -= b.v * dt;
    if (b.y < -12) {
      b.y = h + 12;
      b.x = rand(0, w);
    }
    ctx.beginPath();
    ctx.arc(b.x + Math.sin(time * 0.0006 + b.phase) * 5, b.y, b.r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(200,250,255,${b.a})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Песчаное дно
  const sand = ctx.createLinearGradient(0, h * 0.88, 0, h);
  sand.addColorStop(0, '#c4b99808');
  sand.addColorStop(0.5, '#b8a87a18');
  sand.addColorStop(1, '#a8987033');
  ctx.fillStyle = sand;
  ctx.fillRect(0, h * 0.88, w, h * 0.12);
}

function drawDecorations(time) {
  for (const d of decorations) {
    const x = d.x * w;
    const y = d.y * h;

    ctx.save();
    ctx.font = `${Math.max(26, Math.min(84, h * 0.085))}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#00131c88';
    ctx.shadowBlur = 8;
    ctx.fillText(EMOJI[d.kind] || '🪸', x, y + Math.sin(time * 0.001 + d.x * 9) * 2);
    ctx.restore();
  }
}

function updateFish(f, dt, time) {
  f.targetTime -= dt;
  if (f.targetTime <= 0) {
    f.targetX = rand(w * 0.08, w * 0.92);
    f.targetY = rand(h * 0.12, h * 0.82);
    f.targetTime = rand(3, 8);
  }

  const marginX = Math.max(60, Math.min(w * 0.16, 150));
  const marginY = Math.max(50, Math.min(h * 0.15, 110));

  let ax = (f.targetX - f.x) * 0.055;
  let ay = (f.targetY - f.y) * 0.055;

  if (f.x < marginX) ax += (marginX - f.x) * 0.16;
  if (f.x > w - marginX) ax -= (f.x - (w - marginX)) * 0.16;
  if (f.y < marginY) ay += (marginY - f.y) * 0.15;
  if (f.y > h - marginY) ay -= (f.y - (h - marginY)) * 0.15;

  for (const other of fishes.values()) {
    if (other === f) continue;
    const dx = f.x - other.x;
    const dy = f.y - other.y;
    const dist2 = dx * dx + dy * dy;

    if (dist2 > 0 && dist2 < 130 * 130) {
      const dist = Math.sqrt(dist2);
      const force = (130 - dist) * 0.35;
      ax += (dx / dist) * force;
      ay += (dy / dist) * force;
    }
  }

  f.vx += ax * dt;
  f.vy += ay * dt;

  const globalSpeed = state?.aquarium?.settings?.speed || 1;
  const max = f.speed * globalSpeed;
  const speed = Math.hypot(f.vx, f.vy);

  if (speed > max) {
    f.vx = f.vx / speed * max;
    f.vy = f.vy / speed * max;
  }

  f.vx *= Math.pow(0.992, dt * 60);
  f.vy *= Math.pow(0.992, dt * 60);

  if (Math.abs(f.vx) + Math.abs(f.vy) < 7) {
    f.vx += rand(-2, 2);
    f.vy += rand(-1, 1);
  }

  f.x += f.vx * dt;
  f.y += f.vy * dt;

  const halfW = Math.min(120, Math.max(35, h * 0.09)) * f.scale;
  const halfH = halfW * 0.58;

  f.x = Math.max(halfW + 8, Math.min(w - halfW - 8, f.x));
  f.y = Math.max(halfH + 8, Math.min(h - halfH - 8, f.y));

  f.phase += dt * (5 + Math.hypot(f.vx, f.vy) * 0.045);

  const targetAngle = Math.atan2(f.vy, f.vx);
  f.angle += ((targetAngle - f.angle) || 0) * Math.min(1, dt * 2.2);
}

function drawFish(f, time) {
  if (!f.image || !f.image.complete || !f.image.naturalWidth) return;

  const img = f.image;
  const maxW = Math.min(w * 0.23, Math.max(88, h * 0.22)) * f.scale;
  const aspect = img.naturalWidth / img.naturalHeight;
  const dw = Math.min(maxW, maxW * aspect);
  const dh = dw / aspect;

  const facingRight = f.vx >= 0;
  const angle = Math.max(-0.38, Math.min(0.38, Math.atan2(f.vy, Math.max(10, Math.abs(f.vx)))));

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(angle);
  if (!facingRight) ctx.scale(-1, 1);

  // Рисуем узкие вертикальные срезы со смещением по синусу (эффект плавания)
  const slices = 28;
  const sliceW = img.naturalWidth / slices;
  const amplitude = Math.max(1.3, dh * 0.035);
  const tailW = 0.36;

  for (let i = 0; i < slices; i++) {
    const u = (i + 0.5) / slices;
    const tailFactor = facingRight
      ? Math.max(0, 1 - u / tailW)
      : Math.max(0, 1 - (1 - u) / tailW);

    const shift = Math.sin(f.phase - u * 1.3) * amplitude * tailFactor;
    const sx = i * sliceW;

    ctx.drawImage(
      img,
      sx, 0, sliceW + 0.8, img.naturalHeight,
      (u - 0.5) * dw, shift - dh / 2, dw / slices + 0.8, dh
    );
  }

  ctx.restore();
}

/* =========================================================
   ГЛАВНЫЙ ЦИКЛ
   ========================================================= */

function frame(time) {
  const dt = Math.min(0.04, Math.max(0, (time - lastFrame) / 1000 || 0));
  lastFrame = time;

  drawBackground(dt, time);
  drawDecorations(time);

  for (const f of fishes.values()) {
    if (!Number.isFinite(f.angle)) f.angle = f.vx >= 0 ? 0 : Math.PI;
    updateFish(f, dt, time);
    drawFish(f, time);
  }

  requestAnimationFrame(frame);
}

/* =========================================================
   ЗАПУСК
   ========================================================= */

setInterval(poll, 3500);
poll();
requestAnimationFrame(frame);