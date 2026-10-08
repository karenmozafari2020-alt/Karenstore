# Karen Store V4

فروشگاه مستقل بازی شبیه یک نسخه ساده از Steam. کاربران بدون شماره تلفن ثبت‌نام می‌کنند، بازی منتشر می‌کنند، بازی‌های دیگران را جستجو و دانلود می‌کنند.

## معماری

```
Frontend (HTML/CSS/JS)
   ↓
Express Server (server.js)
   ↓                       ↓
PostgreSQL / Supabase    Permanent Object Storage (storage.js)
(کاربران، نشست‌ها،        (خود فایل بازی)
 اطلاعات بازی‌ها)
```

- **Database** فقط اطلاعات را نگه می‌دارد: کاربران، نشست‌ها (Token)، مشخصات بازی‌ها و مسیر فایل در Storage.
- **فایل بازی** در Object Storage دائمی ذخیره می‌شود، نه در Local Disk سرور Render.
- پوشه `uploads/` فقط **فایل موقت** است. بعد از انتقال موفق به Storage، فایل موقت حذف می‌شود.
- کد Storage در `storage.js` جدا شده است. تابع‌های `uploadGameFile`، `getGameFile`، `deleteGameFile` و `storageStatus` را دارد. برای عوض کردن ارائه‌دهنده فقط همین فایل تغییر می‌کند.

## ساختار پروژه

```
Karen-Store-V4/
├── package.json
├── server.js        # Express 5، API، احراز هویت، Multer، PostgreSQL
├── storage.js       # لایه Storage دائمی (Supabase یا S3-compatible)
├── README.md
├── .gitignore
├── public/
│   ├── index.html   # صفحه اصلی (RTL، فارسی)
│   ├── style.css    # تم تاریک
│   └── app.js       # منطق Frontend
└── uploads/
    └── .gitkeep     # فقط پوشه فایل موقت
```

## ⚠️ محدودیت مهم Supabase Storage در پلن Free

طبق مستندات Supabase، در پروژه‌های **Free** سقف سراسری حجم فایل Storage **50 MB** است و این سقف قابل افزایش نیست. یعنی:

- با `STORAGE_PROVIDER=supabase` و پلن Free، فایل‌های بزرگ‌تر از ۵۰ MB آپلود نمی‌شوند. سرور در این حالت خطای `413` برمی‌گرداند.
- برای فایل‌های ۳۰۰ MB تا ۵۰۰ MB باید از **ارائه‌دهنده S3-compatible** استفاده کنید. گزینه رایگان پیشنهادی: **Backblaze B2** (شروع بدون کارت اعتباری، با لایه رایگان؛ محدودیت‌ها را در صفحه قیمت‌گذاری همان سرویس بررسی کنید).

پس دو حالت داریم:

| حالت | `STORAGE_PROVIDER` | حداکثر حجم عملی در Free |
|---|---|---|
| Supabase Storage | `supabase` (پیش‌فرض) | ۵۰ MB |
| Backblaze B2 یا هر S3-compatible | `s3` | تا ۵۰۰ MB (طبق کد) |

**برای هدف شما (بازی ۳۰۰ MB) پیشنهاد می‌شود `STORAGE_PROVIDER=s3` با Backblaze B2 را استفاده کنید.**

## Environment Variables

هیچ کلید یا رمزی داخل کد یا GitHub قرار نمی‌گیرد.

### همیشه لازم است

| نام | توضیح |
|---|---|
| `DATABASE_URL` | آدرس اتصال PostgreSQL (Supabase یا هر PostgreSQL دیگر) |
| `STORAGE_PROVIDER` | `supabase` یا `s3`. اگر خالی باشد، `supabase` است |

### اگر `STORAGE_PROVIDER=supabase`

| نام | توضیح |
|---|---|
| `SUPABASE_URL` | آدرس پروژه، مثل `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key (فقط سمت سرور؛ هرگز در Frontend قرار نگیرد) |
| `SUPABASE_STORAGE_BUCKET` | نام Bucket، پیش‌فرض `karen-games` |

### اگر `STORAGE_PROVIDER=s3` (مثلاً Backblaze B2)

| نام | توضیح |
|---|---|
| `S3_ENDPOINT` | مثلاً `https://s3.us-west-004.backblazeb2.com` (از صفحه Bucket در B2 بخوانید) |
| `S3_REGION` | مثلاً `us-west-004` (همان بخش وسط Endpoint) |
| `S3_BUCKET` | نام Bucket خصوصی |
| `S3_ACCESS_KEY_ID` | Application Key ID |
| `S3_SECRET_ACCESS_KEY` | Application Key |

### اختیاری

| نام | توضیح |
|---|---|
| `DATABASE_SSL` | اگر PostgreSQL شما SSL ندارد (مثلاً محلی)، مقدار `false` بگذارید |
| `PORT` | Render خودش مقدار می‌دهد؛ نیازی به تنظیم نیست |

## اجرای محلی (Termux / Linux / Windows)

1. Node.js نسخه 20 یا بالاتر نصب باشد.
2. در پوشه پروژه:

```bash
npm install
npm start
```

3. مرورگر را باز کنید: `http://localhost:3000`

برای تست محلی بدون Supabase، می‌توانید یک PostgreSQL محلی داشته باشید و این متغیرها را قبل از `npm start` تنظیم کنید:

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/karen"
export DATABASE_SSL="false"
export STORAGE_PROVIDER="s3"
export S3_ENDPOINT="https://s3.us-west-004.backblazeb2.com"
export S3_REGION="us-west-004"
export S3_BUCKET="karen-games"
export S3_ACCESS_KEY_ID="..."
export S3_SECRET_ACCESS_KEY="..."
npm start
```

## راه‌اندازی Database (Supabase)

1. یک پروژه در Supabase بسازید.
2. از منوی **Connect** یا **Project Settings → Database** رشته اتصال PostgreSQL را کپی کنید.
3. برای Render، از **Session pooler** (پورت 5432) استفاده کنید. اتصال مستقیم Supabase روی بعضی شبکه‌ها فقط IPv6 دارد و Render از آن پشتیبانی کامل ندارد.
4. رمز عبور دیتابیس را داخل رشته اتصال جایگزین `[YOUR-PASSWORD]` کنید.
5. نیازی به ساخت جدول دستی نیست. سرور هنگام اجرا جدول‌های `users`، `sessions` و `games` را خودش می‌سازد.

جدول‌ها:
- `users`: id، username، password_hash، created_at
- `sessions`: نشست‌های ورود (فقط hash توکن ذخیره می‌شود)
- `games`: id، title، description، version، category، developer، filename، stored_filename، storage_path، file_size، downloads، user_id، created_at
- `games.user_id` با `ON DELETE CASCADE` به `users.id` وصل است.

## راه‌اندازی Storage

### گزینه A: Supabase Storage (فقط برای فایل‌های تا ۵۰ MB در Free)

1. در Supabase به **Storage → New bucket** بروید.
2. نام Bucket را `karen-games` بگذارید.
3. گزینه **Public** را **خاموش** کنید (Bucket خصوصی).
4. مقادیر `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` را از **Project Settings → API** بردارید.
5. در Render این متغیرها را با `STORAGE_PROVIDER=supabase` تنظیم کنید.

سرور هنگام آپلود، فایل را در مسیر `games/<uuid>.<ext>` ذخیره می‌کند. نام اصلی فایل فقط در Database است.

### گزینه B: Backblaze B2 با S3 API (پیشنهادی برای فایل‌های بزرگ)

1. در Backblaze یک حساب بسازید و به **Buckets** بروید.
2. یک Bucket با نوع **Private** بسازید، مثلاً `karen-games`.
3. به **Application Keys** بروید و یک کلید بسازید که به همین Bucket دسترسی داشته باشد. مقادیر `keyID` و `applicationKey` را ذخیره کنید؛ `applicationKey` بعد از ساخت فقط یک بار نمایش داده می‌شود.
4. Endpoint و Region را از صفحه Bucket بردارید؛ مثلاً `s3.us-west-004.backblazeb2.com` و `us-west-004`.
5. متغیرهای `S3_*` را در Render تنظیم کنید و `STORAGE_PROVIDER=s3` بگذارید.

> نکته: کد Storage درخواست‌ها را با SigV4 و بدون SDK امضا می‌کند. اگر Endpoint یا Region اشتباه باشد، خطای «آپلود فایل در Storage انجام نشد» را می‌بینید. سرور جزئیات را در لاگ Render نشان می‌دهد.

## Deploy روی GitHub و Render

### 1. GitHub

1. روی GitHub یک Repository جدید بسازید، مثلاً `Karen-Store-V4`.
2. پوشه پروژه را به Repository push کنید.
3. مطمئن شوید فایل `.env` یا هیچ Secret در Repository نیست. فایل `.gitignore` این موارد را نادیده می‌گیرد.

اگر از Termux استفاده می‌کنید:

```bash
pkg install git
cd Karen-Store-V4
git init
git add .
git commit -m "Karen Store V4"
git branch -M main
git remote add origin https://github.com/USERNAME/Karen-Store-V4.git
git push -u origin main
```

### 2. Render

1. در Render روی **New → Web Service** بزنید و Repository را انتخاب کنید.
2. تنظیمات:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
3. وارد بخش **Environment** شوید.
4. روی **Add Environment Variable** بزنید و این متغیرها را اضافه کنید:

| Key | Value |
|---|---|
| `DATABASE_URL` | رشته اتصال PostgreSQL از Supabase (Session pooler) |
| `STORAGE_PROVIDER` | `s3` یا `supabase` |
| و متغیرهای مربوط به ارائه‌دهنده انتخابی | طبق جدول بالا |

**دقیقاً `DATABASE_URL` را در بخش Environment Variables سرویس Render قرار دهید** (Dashboard → Web Service → Environment → Add Environment Variable). آن را داخل کد یا README قرار ندهید.

5. روی **Create Web Service** یا **Deploy** بزنید.
6. بعد از Deploy، آدرس `https://your-service.onrender.com/api/health` را باز کنید.

خروجی سالم:

```json
{ "ok": true, "database": true, "storage": { "provider": "s3", "configured": true } }
```

اگر `database` یا `configured` مقدار `false` بود، Environment Variables را دوباره بررسی کنید.

## اولین آپلود بازی

1. صفحه سرویس Render را باز کنید.
2. ثبت‌نام کنید؛ فقط نام کاربری و رمز عبور لازم است.
3. با همان حساب وارد شوید.
4. روی **آپلود بازی** بزنید، فرم را پر کنید و فایل را انتخاب کنید.
5. روی **انتشار** بزنید. بعد از موفقیت، بازی در لیست ظاهر می‌شود.

## چگونه مطمئن شوم فایل بعد از Restart باقی می‌ماند؟

1. یک بازی آپلود کنید و در صفحه جزئیات، یکبار دانلود کنید.
2. در Render دکمه **Manual Deploy → Deploy latest commit** یا **Restart** را بزنید.
3. بعد از بالا آمدن سرویس، همان بازی را دوباره دانلود کنید. اگر فایل دانلود شد و حجم آن درست بود، فایل دائمی است.
4. برای اطمینان بیشتر، در Supabase (گزینه A) یا B2 (گزینه B) داخل Bucket همان فایل را ببینید؛ مسیر آن `games/<uuid>.<ext>` است.

## محدودیت‌های Render Free و فایل‌ها

- **فایل بازی** در Object Storage ذخیره می‌شود و با Restart یا Redeploy از بین نمی‌رود.
- **پوشه `uploads/`** فقط فایل موقت آپلود است. Render ممکن است آن را بعد از Restart پاک کند و این مشکلی ایجاد نمی‌کند، چون فایل نهایی آنجا نیست.
- **Render Free** بعد از مدتی بی‌فعالیتی سرویس را می‌خوابد. اولین درخواست بعد از آن کندتر است.
- **RAM** پلن Free حدود ۵۱۲ MB است. آپلود و دانلود با Stream انجام می‌شود تا کل فایل داخل RAM نرود، ولی آپلودهای خیلی بزرگ ممکن است زمان‌بر باشند.
- **حذف کاربر**: API حذف کاربر ندارد. اگر کاربری را مستقیماً از Database حذف کنید، رکوردهای بازی‌هایش حذف می‌شوند، اما فایل‌هایشان در Storage می‌مانند و باید دستی پاک شوند.

## API

| متد | مسیر | احراز هویت | توضیح |
|---|---|---|---|
| POST | `/api/register` | – | ثبت‌نام با `username` و `password` |
| POST | `/api/login` | – | ورود و دریافت `token` |
| POST | `/api/logout` | اختیاری | خروج و باطل شدن توکن |
| GET | `/api/me` | ✔ | اطلاعات کاربر فعلی |
| GET | `/api/health` | – | وضعیت دیتابیس و Storage |
| GET | `/api/categories` | – | لیست دسته‌بندی‌ها |
| GET | `/api/games?q=&category=` | – | لیست و جستجوی بازی‌ها |
| GET | `/api/games/:id` | – | اطلاعات یک بازی |
| POST | `/api/games` | ✔ | انتشار بازی (`multipart/form-data`) |
| GET | `/api/games/:id/download` | – | دانلود فایل و افزایش شمارنده |
| DELETE | `/api/games/:id` | ✔ (فقط صاحب) | حذف بازی و فایل آن |

توکن را در هدر ارسال کنید:

```
Authorization: Bearer TOKEN
```

فیلدهای فرم انتشار: `title`، `description`، `version`، `category`، `developer` و فایل با نام `game`.

مثال با curl:

```bash
curl -X POST https://your-service.onrender.com/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"karen","password":"12345678"}'
```

## قوانین و امنیت

- نام کاربری: ۳ تا ۳۲ کاراکتر، فقط حروف انگلیسی، عدد و `_`.
- رمز عبور: حداقل ۶ کاراکتر؛ با bcryptjs هش می‌شود و هرگز به‌صورت خام ذخیره نمی‌شود.
- توکن: ۶۴ کاراکتر تصادفی؛ در Database فقط hash آن (SHA-256) ذخیره می‌شود. اعتبار ۳۰ روز است.
- حداکثر حجم فایل: ۵۰۰ MB، هم در Frontend و هم در Backend بررسی می‌شود.
- پسوندهای مجاز: `.apk .aab .zip .rar .7z .exe .msi .jar .iso .ka .game .html .tar .gz`
- نام فایل روی Storage تصادفی (UUID) است. نام اصلی فقط در Database است و هنگام دانلود با `Content-Disposition` برمی‌گردد.
- همه Queryها Parameterized هستند؛ SQL Injection انجام نمی‌شود.
- در Frontend از `textContent` استفاده شده و داده‌های کاربر به‌صورت HTML اجرا نمی‌شوند (جلوگیری از XSS).
- خطاهای داخلی دیتابیس یا Storage به کاربر نشان داده نمی‌شوند؛ فقط در لاگ سرور ثبت می‌شوند.
- Service Role Key فقط در سرور استفاده می‌شود و هرگز به Frontend ارسال نمی‌شود.
- کاربر فقط می‌تواند بازی‌های خودش را حذف کند (در غیر این صورت `403`).

## کدهای خطا

| کد | معنی |
|---|---|
| 400 | ورودی نامعتبر |
| 401 | وارد نشده یا نشست منقضی |
| 403 | دسترسی ندارید |
| 404 | پیدا نشد |
| 409 | نام کاربری تکراری |
| 413 | حجم فایل بیشتر از حد مجاز یا بیشتر از سقف Storage |
| 500 | خطای داخلی سرور |
| 502 | خطا در Storage |
| 503 | دیتابیس یا Storage در دسترس نیست |

## اجرای کدها بدون Render (خلاصه)

```bash
npm install
npm start
```

## مهاجرت به Storage دیگر

فقط `storage.js` را تغییر دهید. تابع‌های زیر باید همان قرارداد را داشته باشند:

- `uploadGameFile({ localPath, storagePath, size })`
- `getGameFile(storagePath)` که یک `fetch Response` با `body` قابل stream برگرداند
- `deleteGameFile(storagePath)`
- `storageStatus()` که `{ provider, configured }` برگرداند
