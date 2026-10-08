'use strict';

/*
 * لایه ذخیره‌سازی دائمی فایل بازی‌ها.
 * server.js فقط از این توابع استفاده می‌کند:
 *   uploadGameFile({ localPath, storagePath, size })
 *   getGameFile(storagePath)      -> fetch Response (body قابل stream)
 *   deleteGameFile(storagePath)
 *   storageStatus()
 *
 * ارائه‌دهنده با متغیر STORAGE_PROVIDER انتخاب می‌شود:
 *   supabase (پیش‌فرض) -> Supabase Storage REST API
 *   s3                 -> هر Object Storage سازگار با S3 (مثل Backblaze B2)
 *
 * هیچ کلیدی داخل کد نیست؛ همه از Environment Variables خوانده می‌شود.
 */

const fs = require('fs');
const crypto = require('crypto');

const SUPPORTED_PROVIDERS = ['supabase', 's3'];
const PROVIDER = (process.env.STORAGE_PROVIDER || 'supabase').trim().toLowerCase();

class StorageError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

function misconfigured(detail) {
  console.error(`Storage configuration error: ${detail}`);
  return new StorageError('سرویس ذخیره‌سازی فایل تنظیم نشده است.', 503);
}

function activeProvider() {
  if (!SUPPORTED_PROVIDERS.includes(PROVIDER)) {
    throw misconfigured(`STORAGE_PROVIDER "${PROVIDER}" is not supported`);
  }
  return PROVIDER;
}

function encodePath(storagePath) {
  return storagePath.split('/').map(encodeURIComponent).join('/');
}

async function ensureOk(res, message) {
  if (res.ok) return;
  const detail = await res.text().catch(() => '');
  console.error(`Storage request failed (${res.status}): ${detail.slice(0, 300)}`);
  if (res.status === 413) {
    throw new StorageError('حجم فایل از سقف Storage پروژه بیشتر است.', 413);
  }
  throw new StorageError(message, 502);
}

/* ------------------------------------------------------------------ */
/* Supabase Storage                                                    */
/* ------------------------------------------------------------------ */

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET || 'karen-games').trim();
  if (!url || !key) throw misconfigured('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing');
  return { url, key, bucket };
}

async function supabaseUpload(localPath, storagePath, size) {
  const { url, key, bucket } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'x-upsert': 'false',
    },
    body: fs.createReadStream(localPath),
    duplex: 'half',
  });
  await ensureOk(res, 'آپلود فایل در Storage انجام نشد.');
}

async function supabaseSignedUrl(storagePath) {
  const { url, key, bucket } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodePath(storagePath)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  if (res.status === 400 || res.status === 404) {
    await res.text().catch(() => '');
    throw new StorageError('فایل این بازی در Storage پیدا نشد.', 404);
  }
  await ensureOk(res, 'ساخت لینک دانلود انجام نشد.');
  const data = await res.json().catch(() => null);
  if (!data || !data.signedURL) throw new StorageError('ساخت لینک دانلود انجام نشد.', 502);
  return `${url}/storage/v1${data.signedURL}`;
}

async function supabaseDelete(storagePath) {
  const { url, key, bucket } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
  await ensureOk(res, 'حذف فایل از Storage انجام نشد.');
}

/* ------------------------------------------------------------------ */
/* S3-compatible Object Storage (Backblaze B2, ...) با SigV4 بدون SDK   */
/* ------------------------------------------------------------------ */

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function s3Config() {
  const endpoint = (process.env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  const region = (process.env.S3_REGION || 'us-east-1').trim();
  const bucket = (process.env.S3_BUCKET || '').trim();
  const accessKeyId = (process.env.S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.S3_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw misconfigured('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing');
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function sha256File(localPath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(localPath)) hash.update(chunk);
  return hash.digest('hex');
}

async function s3Request(method, storagePath, options = {}) {
  const { body, contentLength, contentType, payloadHash = EMPTY_SHA256 } = options;
  const cfg = s3Config();

  const url = new URL(cfg.endpoint);
  url.pathname = `/${rfc3986(cfg.bucket)}/${storagePath.split('/').map(rfc3986).join('/')}`;

  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const signHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentLength !== undefined) signHeaders['content-length'] = String(contentLength);
  if (contentType) signHeaders['content-type'] = contentType;

  const names = Object.keys(signHeaders).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(signHeaders[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  // Host توسط fetch به‌صورت خودکار اضافه می‌شود؛ فقط در امضا استفاده می‌شود.
  const sendHeaders = { ...signHeaders };
  delete sendHeaders.host;
  sendHeaders.Authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers: sendHeaders,
    body,
    duplex: body ? 'half' : undefined,
  });
}

async function s3Upload(localPath, storagePath, size) {
  const payloadHash = await sha256File(localPath);
  const res = await s3Request('PUT', storagePath, {
    body: fs.createReadStream(localPath),
    contentLength: size,
    contentType: 'application/octet-stream',
    payloadHash,
  });
  await ensureOk(res, 'آپلود فایل در Storage انجام نشد.');
}

async function s3Get(storagePath) {
  const res = await s3Request('GET', storagePath);
  if (res.status === 404) {
    await res.text().catch(() => '');
    throw new StorageError('فایل این بازی در Storage پیدا نشد.', 404);
  }
  await ensureOk(res, 'دریافت فایل از Storage انجام نشد.');
  return res;
}

async function s3Delete(storagePath) {
  const res = await s3Request('DELETE', storagePath);
  if (res.status === 404) {
    await res.text().catch(() => '');
    return;
  }
  await ensureOk(res, 'حذف فایل از Storage انجام نشد.');
}

/* ------------------------------------------------------------------ */
/* API عمومی ماژول (بدون وابستگی به ارائه‌دهنده)                         */
/* ------------------------------------------------------------------ */

/**
 * آپلود فایل از مسیر موقت محلی به Storage دائمی.
 * storagePath مثل: games/<uuid>.apk
 */
async function uploadGameFile({ localPath, storagePath, size }) {
  if (activeProvider() === 's3') return s3Upload(localPath, storagePath, size);
  return supabaseUpload(localPath, storagePath, size);
}

/**
 * دریافت فایل دائمی به‌صورت stream. خروجی یک fetch Response است.
 * caller باید res.ok را بررسی نکند؛ خطاها به‌صورت StorageError پرتاب می‌شوند.
 */
async function getGameFile(storagePath) {
  if (activeProvider() === 's3') return s3Get(storagePath);
  const signedUrl = await supabaseSignedUrl(storagePath);
  const res = await fetch(signedUrl);
  if (res.status === 404) {
    await res.text().catch(() => '');
    throw new StorageError('فایل این بازی در Storage پیدا نشد.', 404);
  }
  await ensureOk(res, 'دریافت فایل از Storage انجام نشد.');
  return res;
}

/**
 * حذف فایل از Storage. اگر فایل از قبل وجود نداشته باشد، موفق در نظر گرفته می‌شود.
 */
async function deleteGameFile(storagePath) {
  if (activeProvider() === 's3') return s3Delete(storagePath);
  return supabaseDelete(storagePath);
}

/**
 * وضعیت پیکربندی Storage (بدون ارسال درخواست شبکه).
 */
function storageStatus() {
  const required = PROVIDER === 's3'
    ? ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
    : ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const configured = SUPPORTED_PROVIDERS.includes(PROVIDER)
    && required.every((name) => (process.env[name] || '').trim() !== '');
  return { provider: PROVIDER, configured };
}

module.exports = {
  StorageError,
  uploadGameFile,
  getGameFile,
  deleteGameFile,
  storageStatus,
};
