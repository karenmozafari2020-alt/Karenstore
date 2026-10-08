'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const storage = require('./storage');

/* ------------------------------------------------------------------ */
/* تنظیمات                                                             */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const MAX_GAME_SIZE = 500 * 1024 * 1024;
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 10;
const CATEGORIES = ['Action', 'Adventure', 'Strategy', 'Simulation', 'Horror', 'RPG', 'Other'];
const ALLOWED_EXTENSIONS = [
  '.apk', '.aab', '.zip', '.rar', '.7z', '.exe', '.msi', '.jar',
  '.iso', '.ka', '.game', '.html', '.tar', '.gz',
];
// uploads/ فقط پوشه فایل موقت است؛ فایل نهایی هرگز اینجا نگه داشته نمی‌شود.
const TMP_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(TMP_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.warn('هشدار: متغیر DATABASE_URL تنظیم نشده است.');
}

/* ------------------------------------------------------------------ */
/* PostgreSQL                                                          */
/* ------------------------------------------------------------------ */

// پارامتر sslmode را از رشته اتصال حذف می‌کنیم، چون در pg باعث نادیده گرفتن تنظیم ssl می‌شود
// و گواهی Supabase/Render رد می‌شود. SSL همیشه از تنظیمات زیر خوانده می‌شود.
function cleanConnectionString(raw) {
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('ssl');
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch (err) {
    return raw;
  }
}

const pool = new Pool({
  connectionString: cleanConnectionString(process.env.DATABASE_URL || ''),
  // Supabase و بیشتر سرویس‌های ابری SSL می‌خواهند. برای PostgreSQL محلی: DATABASE_SSL=false
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version VARCHAR(40) NOT NULL,
  category VARCHAR(40) NOT NULL,
  developer VARCHAR(80) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  storage_path VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS games_user_id_idx ON games (user_id);
CREATE INDEX IF NOT EXISTS games_created_at_idx ON games (created_at DESC);
`;

async function initDatabase() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await pool.query(SCHEMA_SQL);
      console.log('دیتابیس آماده است.');
      return;
    } catch (err) {
      console.error(`ساخت جداول - تلاش ${attempt} ناموفق: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  console.error('ساخت جداول انجام نشد؛ /api/health وضعیت را نشان می‌دهد.');
}

const DUMMY_HASH = bcrypt.hashSync('karen-store-dummy-password', BCRYPT_ROUNDS);

/* ------------------------------------------------------------------ */
/* ابزارهای کمکی                                                       */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isDbUnavailable(err) {
  if (typeof err.code === 'string') {
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(err.code)) return true;
    if (err.code.startsWith('08')) return true; // connection exceptions
  }
  return /timeout exceeded when trying to connect/i.test(err.message || '');
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function getBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+([a-f0-9]{64})$/.exec(header);
  return match ? match[1] : null;
}

function validateUsername(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'نام کاربری نامعتبر است.');
  const username = value.trim();
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    throw new HttpError(400, 'نام کاربری باید ۳ تا ۳۲ کاراکتر و فقط شامل حروف انگلیسی، عدد و _ باشد.');
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 6) {
    throw new HttpError(400, 'رمز عبور باید حداقل ۶ کاراکتر باشد.');
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw new HttpError(400, 'رمز عبور بیش از حد طولانی است.');
  }
  return value;
}

function cleanText(value, label, min, max) {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} نامعتبر است.`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new HttpError(400, `${label} باید بین ${min} تا ${max} کاراکتر باشد.`);
  }
  return text;
}

function validateGameFields(body) {
  const data = body || {};
  const category = cleanText(data.category, 'دسته‌بندی', 1, 40);
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'دسته‌بندی انتخاب‌شده معتبر نیست.');
  return {
    title: cleanText(data.title, 'نام بازی', 1, 120),
    description: cleanText(data.description, 'توضیحات', 0, 2000),
    version: cleanText(data.version, 'نسخه', 1, 40),
    category,
    developer: cleanText(data.developer, 'نام سازنده', 1, 80),
  };
}

function sanitizeFilename(name) {
  const base = path.posix.basename(String(name || '').replace(/\\/g, '/'));
  const clean = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim();
  if (!clean) throw new HttpError(400, 'نام فایل نامعتبر است.');
  if (clean.length > 200) throw new HttpError(400, 'نام فایل خیلی طولانی است.');
  return clean;
}

function parseId(value) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) {
    throw new HttpError(404, 'بازی پیدا نشد.');
  }
  const id = Number(value);
  if (id < 1 || id > 2147483647) throw new HttpError(404, 'بازی پیدا نشد.');
  return id;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const GAME_SELECT = `
  SELECT g.id, g.title, g.description, g.version, g.category, g.developer,
         g.filename, g.file_size, g.downloads,
         g.user_id AS owner_id, u.username AS owner, g.created_at
  FROM games g
  JOIN users u ON u.id = g.user_id`;

function toGame(row) {
  return { ...row, file_size: Number(row.file_size) };
}

async function fetchGame(id) {
  const { rows } = await pool.query(`${GAME_SELECT} WHERE g.id = $1`, [id]);
  return rows[0] ? toGame(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

async function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) throw new HttpError(401, 'برای این کار باید وارد شوید.');
  const { rows } = await pool.query(
    `SELECT u.id, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)],
  );
  if (!rows[0]) throw new HttpError(401, 'نشست شما منقضی شده است. دوباره وارد شوید.');
  req.user = rows[0];
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.tmp`),
  }),
  limits: { fileSize: MAX_GAME_SIZE, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new HttpError(400, 'پسوند فایل مجاز نیست.'));
    }
    return cb(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('game')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'حجم فایل بیشتر از 500 MB است.'));
      }
      return next(new HttpError(400, 'فرم آپلود معتبر نیست.'));
    }
    return next(err);
  });
}

/* ------------------------------------------------------------------ */
/* اپلیکیشن                                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

/* ---------- Health ---------- */

app.get('/api/health', async (req, res) => {
  let database = false;
  let tables = false;
  try {
    await pool.query('SELECT 1');
    database = true;
    const { rows } = await pool.query(
      `SELECT to_regclass('public.users') IS NOT NULL
          AND to_regclass('public.sessions') IS NOT NULL
          AND to_regclass('public.games') IS NOT NULL AS ok`,
    );
    tables = rows[0].ok === true;
  } catch (err) {
    console.error('بررسی دیتابیس ناموفق:', err.message);
  }
  const storageInfo = storage.storageStatus();
  const ok = database && tables && storageInfo.configured;
  res.status(ok ? 200 : 503).json({
    ok,
    database,
    tables,
    storage: storageInfo,
  });
});

/* ---------- Categories ---------- */

app.get('/api/categories', (req, res) => {
  res.json({ categories: ['All', ...CATEGORIES] });
});

/* ---------- Auth ---------- */

app.post('/api/register', async (req, res) => {
  const body = req.body || {};
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, passwordHash],
    );
    res.status(201).json({ ok: true, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'این نام کاربری قبلاً ثبت شده است.');
    throw err;
  }
});

app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  if (typeof body.username !== 'string' || typeof body.password !== 'string'
      || body.username.length > 32 || body.password.length > 72) {
    throw new HttpError(400, 'نام کاربری و رمز عبور را وارد کنید.');
  }
  const { rows } = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE LOWER(username) = LOWER($1)',
    [body.username.trim()],
  );
  const user = rows[0];
  // مقایسه همیشه انجام می‌شود تا زمان پاسخ، وجود نام کاربری را لو ندهد.
  const valid = await bcrypt.compare(body.password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است.');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, hashToken(token), expiresAt],
  );
  res.json({
    ok: true,
    token,
    user: { id: user.id, username: user.username },
  });
});

app.post('/api/logout', async (req, res) => {
  const token = getBearerToken(req);
  if (token) {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username } });
});

/* ---------- Games ---------- */

app.get('/api/games', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const category = typeof req.query.category === 'string' ? req.query.category : 'All';
  if (category !== 'All' && !CATEGORIES.includes(category)) {
    throw new HttpError(400, 'دسته‌بندی نامعتبر است.');
  }
  const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : '';
  const categoryFilter = category === 'All' ? '' : category;
  const { rows } = await pool.query(
    `${GAME_SELECT}
      WHERE ($1 = '' OR g.title ILIKE $1 OR g.description ILIKE $1 OR g.developer ILIKE $1)
        AND ($2 = '' OR g.category = $2)
      ORDER BY g.created_at DESC
      LIMIT 200`,
    [pattern, categoryFilter],
  );
  res.json({ games: rows.map(toGame) });
});

app.get('/api/games/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const game = await fetchGame(id);
  if (!game) throw new HttpError(404, 'بازی پیدا نشد.');
  res.json({ game });
});

app.post('/api/games', requireAuth, handleUpload, async (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new HttpError(400, 'فایل بازی ارسال نشده است.');
    if (file.size > MAX_GAME_SIZE) throw new HttpError(413, 'حجم فایل بیشتر از 500 MB است.');
    if (file.size === 0) throw new HttpError(400, 'فایل بازی خالی است.');

    const fields = validateGameFields(req.body);
    const originalName = sanitizeFilename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) throw new HttpError(400, 'پسوند فایل مجاز نیست.');

    const storedFilename = `${crypto.randomUUID()}${ext}`;
    const storagePath = `games/${storedFilename}`;

    // ترتیب امن: اول Storage دائمی، سپس Database.
    await storage.uploadGameFile({ localPath: file.path, storagePath, size: file.size });

    let gameId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO games
           (title, description, version, category, developer, filename,
            stored_filename, storage_path, file_size, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          fields.title, fields.description, fields.version, fields.category, fields.developer,
          originalName, storedFilename, storagePath, file.size, req.user.id,
        ],
      );
      gameId = rows[0].id;
    } catch (err) {
      // رکورد ثبت نشد؛ فایل بلااستفاده در Storage نماند.
      await storage.deleteGameFile(storagePath).catch((cleanupErr) =>
        console.error('پاکسازی فایل پس از خطای دیتابیس ناموفق:', cleanupErr.message));
      throw err;
    }

    const game = await fetchGame(gameId);
    res.status(201).json({ ok: true, message: 'بازی با موفقیت منتشر شد.', game });
  } finally {
    // فایل موقت در هر حالت حذف می‌شود.
    if (file) await fs.promises.rm(file.path, { force: true }).catch(() => {});
  }
});

app.get('/api/games/:id/download', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(
    'SELECT id, filename, file_size, storage_path FROM games WHERE id = $1',
    [id],
  );
  const game = rows[0];
  if (!game) throw new HttpError(404, 'بازی پیدا نشد.');

  // اگر فایل در Storage نباشد، خطا قبل از افزایش شمارنده برمی‌گردد.
  const upstream = await storage.getGameFile(game.storage_path);

  await pool.query('UPDATE games SET downloads = downloads + 1 WHERE id = $1', [id]);

  res.status(200);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', upstream.headers.get('content-length') || String(game.file_size));
  res.setHeader('Content-Disposition', contentDisposition(game.filename));
  res.setHeader('Cache-Control', 'private, no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  pipeline(Readable.fromWeb(upstream.body), res, (err) => {
    if (err) {
      console.error('خطا در ارسال فایل دانلود:', err.message);
      res.destroy();
    }
  });
});

app.delete('/api/games/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query(
    'SELECT id, user_id, storage_path FROM games WHERE id = $1',
    [id],
  );
  const game = rows[0];
  if (!game) throw new HttpError(404, 'بازی پیدا نشد.');
  if (game.user_id !== req.user.id) {
    throw new HttpError(403, 'فقط سازنده این بازی می‌تواند آن را حذف کند.');
  }

  // ترتیب: اول فایل، سپس رکورد. اگر فایل حذف نشود، رکورد باقی می‌ماند تا دوباره بشود تلاش کرد.
  await storage.deleteGameFile(game.storage_path);

  try {
    await pool.query('DELETE FROM games WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  } catch (err) {
    console.error('حذف رکورد بازی ناموفق:', err.message);
    throw new HttpError(500, 'فایل حذف شد اما رکورد بازی حذف نشد. دوباره تلاش کنید.');
  }
  res.json({ ok: true, message: 'بازی حذف شد.' });
});

/* ---------- Not found & errors ---------- */

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'مسیر مورد نظر پیدا نشد.' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof storage.StorageError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'بدنه درخواست معتبر نیست.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'درخواست بیش از حد بزرگ است.' });
  }
  if (isDbUnavailable(err)) {
    console.error('دیتابیس در دسترس نیست:', err.message);
    return res.status(503).json({ error: 'دیتابیس در دسترس نیست. کمی بعد دوباره تلاش کنید.' });
  }
  console.error('خطای داخلی:', err);
  // کد SQLSTATE حساس نیست و برای عیب‌یابی نشان داده می‌شود.
  return res.status(500).json({ error: 'خطای داخلی سرور.', code: err.code || null });
});

/* ------------------------------------------------------------------ */
/* اجرا                                                                */
/* ------------------------------------------------------------------ */

const server = app.listen(PORT, HOST, () => {
  console.log(`Karen Store V4 روی http://${HOST}:${PORT} در حال اجراست.`);
});

initDatabase();

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
