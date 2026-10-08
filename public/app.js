(function () {
  'use strict';

  var MAX_SIZE = 500 * 1024 * 1024;
  var ALLOWED_EXT = ['.apk', '.aab', '.zip', '.rar', '.7z', '.exe', '.msi', '.jar',
    '.iso', '.ka', '.game', '.html', '.tar', '.gz'];
  var TOKEN_KEY = 'karenStore.token';
  var DEFAULT_CATEGORIES = ['All', 'Action', 'Adventure', 'Strategy', 'Simulation', 'Horror', 'RPG', 'Other'];
  var CATEGORY_LABELS = {
    All: 'همه',
    Action: 'اکشن',
    Adventure: 'ماجراجویی',
    Strategy: 'استراتژی',
    Simulation: 'شبیه‌سازی',
    Horror: 'ترسناک',
    RPG: 'نقش‌آفرینی',
    Other: 'سایر'
  };

  var state = {
    token: localStorage.getItem(TOKEN_KEY),
    user: null,
    q: '',
    category: 'All',
    categories: DEFAULT_CATEGORIES,
    requestId: 0
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function categoryLabel(cat) { return CATEGORY_LABELS[cat] || cat; }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function formatNumber(n) { return Number(n || 0).toLocaleString('fa-IR'); }

  function formatDate(value) {
    var d = new Date(value);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('fa-IR');
  }

  function showToast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function setMsg(node, message, isError) {
    node.textContent = message || '';
    node.className = 'form-msg' + (isError ? ' error' : '');
    node.hidden = !message;
  }

  function openDialog(id) {
    var d = $(id);
    if (!d.open) d.showModal();
  }

  function isOwner(game) {
    return !!state.user && game.owner_id === state.user.id;
  }

  /* ---------- API ---------- */

  async function api(url, options) {
    options = options || {};
    var headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', 'Bearer ' + state.token);
    var body = options.body;
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.json);
    }
    var res = await fetch(url, { method: options.method || 'GET', headers: headers, body: body });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      if (res.status === 401 && state.token) clearSession();
      throw new Error((data && data.error) || ('خطا در ارتباط با سرور (' + res.status + ')'));
    }
    return data;
  }

  function uploadWithProgress(formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/games');
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          if (xhr.status === 401) clearSession();
          reject(new Error((data && data.error) || 'خطا در انتشار بازی'));
        }
      };
      xhr.onerror = function () { reject(new Error('ارتباط با سرور برقرار نشد.')); };
      xhr.onabort = function () { reject(new Error('آپلود لغو شد.')); };
      xhr.send(formData);
    });
  }

  /* ---------- Session ---------- */

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    renderAuth();
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    localStorage.removeItem(TOKEN_KEY);
    renderAuth();
  }

  function renderAuth() {
    var loggedIn = !!state.user;
    $('guestArea').hidden = loggedIn;
    $('userArea').hidden = !loggedIn;
    $('greetingName').textContent = loggedIn ? state.user.username : '';
  }

  /* ---------- Categories & games ---------- */

  function renderCategories() {
    var nav = $('categoryNav');
    nav.textContent = '';
    state.categories.forEach(function (cat) {
      var btn = el('button', 'chip' + (cat === state.category ? ' active' : ''), categoryLabel(cat));
      btn.type = 'button';
      btn.addEventListener('click', function () {
        state.category = cat;
        renderCategories();
        loadGames();
      });
      nav.appendChild(btn);
    });
  }

  function fillCategorySelect() {
    var select = $('gameCategory');
    select.textContent = '';
    var placeholder = el('option', '', 'انتخاب دسته‌بندی');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    state.categories.filter(function (c) { return c !== 'All'; }).forEach(function (cat) {
      var opt = el('option', '', categoryLabel(cat));
      opt.value = cat;
      select.appendChild(opt);
    });
  }

  async function loadCategories() {
    try {
      var data = await api('/api/categories');
      if (data && Array.isArray(data.categories)) state.categories = data.categories;
    } catch (e) {
      // از لیست پیش‌فرض استفاده می‌شود.
    }
    renderCategories();
    fillCategorySelect();
  }

  async function loadGames() {
    var requestId = ++state.requestId;
    $('statusText').textContent = 'در حال بارگذاری...';
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'All') params.set('category', state.category);
    try {
      var data = await api('/api/games?' + params.toString());
      if (requestId !== state.requestId) return;
      renderGames(data.games || []);
    } catch (err) {
      if (requestId !== state.requestId) return;
      $('gamesGrid').textContent = '';
      $('statusText').textContent = err.message;
    }
  }

  function renderGames(games) {
    var grid = $('gamesGrid');
    grid.textContent = '';
    $('statusText').textContent = games.length
      ? games.length.toLocaleString('fa-IR') + ' بازی'
      : '';
    if (!games.length) {
      grid.appendChild(el('div', 'empty', 'هنوز بازی‌ای با این مشخصات پیدا نشد.'));
      return;
    }
    games.forEach(function (game) { grid.appendChild(createCard(game)); });
  }

  function metaRow(label, value) {
    var row = el('div', 'meta-row');
    row.appendChild(el('dt', '', label));
    row.appendChild(el('dd', '', value));
    return row;
  }

  function createCard(game) {
    var card = el('article', 'card');

    var cover = el('div', 'card-cover');
    cover.appendChild(el('span', 'cover-letter', (game.title || '?').charAt(0).toUpperCase()));

    var body = el('div', 'card-body');
    body.appendChild(el('span', 'tag', categoryLabel(game.category)));
    body.appendChild(el('h3', 'card-title', game.title));
    body.appendChild(el('p', 'card-desc', game.description || 'بدون توضیحات'));

    var meta = el('dl', 'meta');
    meta.appendChild(metaRow('نسخه', game.version));
    meta.appendChild(metaRow('سازنده', game.developer));
    meta.appendChild(metaRow('دانلود', formatNumber(game.downloads)));
    meta.appendChild(metaRow('حجم', formatSize(game.file_size)));
    body.appendChild(meta);

    var actions = el('div', 'card-actions');

    var detailBtn = el('button', 'btn btn-ghost', 'جزئیات');
    detailBtn.type = 'button';
    detailBtn.addEventListener('click', function () { openDetail(game.id); });

    var dl = el('a', 'btn btn-primary', 'دانلود');
    dl.href = '/api/games/' + game.id + '/download';
    dl.setAttribute('download', '');
    dl.addEventListener('click', function () { setTimeout(loadGames, 2500); });

    actions.appendChild(detailBtn);
    actions.appendChild(dl);

    if (isOwner(game)) {
      var del = el('button', 'btn btn-danger', 'حذف');
      del.type = 'button';
      del.addEventListener('click', function () { deleteGame(game); });
      actions.appendChild(del);
    }

    body.appendChild(actions);
    card.appendChild(cover);
    card.appendChild(body);
    return card;
  }

  /* ---------- Detail ---------- */

  async function openDetail(id) {
    var body = $('detailBody');
    body.textContent = 'در حال بارگذاری...';
    openDialog('detailDialog');
    try {
      var data = await api('/api/games/' + encodeURIComponent(id));
      renderDetail(data.game);
    } catch (err) {
      body.textContent = err.message;
    }
  }

  function renderDetail(game) {
    var body = $('detailBody');
    body.textContent = '';
    body.appendChild(el('span', 'tag', categoryLabel(game.category)));
    body.appendChild(el('h2', 'detail-title', game.title));
    body.appendChild(el('p', 'detail-desc', game.description || 'بدون توضیحات'));

    var info = el('dl', 'meta detail-meta');
    info.appendChild(metaRow('نسخه', game.version));
    info.appendChild(metaRow('سازنده', game.developer));
    info.appendChild(metaRow('دسته‌بندی', categoryLabel(game.category)));
    info.appendChild(metaRow('حجم', formatSize(game.file_size)));
    info.appendChild(metaRow('تعداد دانلود', formatNumber(game.downloads)));
    info.appendChild(metaRow('منتشرکننده', game.owner));
    info.appendChild(metaRow('تاریخ انتشار', formatDate(game.created_at)));
    info.appendChild(metaRow('نام فایل', game.filename));
    body.appendChild(info);

    var actions = el('div', 'card-actions');
    var dl = el('a', 'btn btn-primary btn-lg', 'دانلود بازی');
    dl.href = '/api/games/' + game.id + '/download';
    dl.setAttribute('download', '');
    dl.addEventListener('click', function () { setTimeout(loadGames, 2500); });
    actions.appendChild(dl);

    if (isOwner(game)) {
      var del = el('button', 'btn btn-danger btn-lg', 'حذف بازی');
      del.type = 'button';
      del.addEventListener('click', function () { deleteGame(game); });
      actions.appendChild(del);
    }
    body.appendChild(actions);
  }

  async function deleteGame(game) {
    if (!window.confirm('بازی «' + game.title + '» و فایل آن برای همیشه حذف شود؟')) return;
    try {
      await api('/api/games/' + game.id, { method: 'DELETE' });
      if ($('detailDialog').open) $('detailDialog').close();
      showToast('بازی حذف شد.');
      loadGames();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  /* ---------- Auth forms ---------- */

  $('loginOpenBtn').addEventListener('click', function () { openDialog('loginDialog'); });
  $('registerOpenBtn').addEventListener('click', function () { openDialog('registerDialog'); });
  $('switchToRegister').addEventListener('click', function () {
    $('loginDialog').close();
    openDialog('registerDialog');
  });
  $('switchToLogin').addEventListener('click', function () {
    $('registerDialog').close();
    openDialog('loginDialog');
  });

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var username = form.elements.username.value.trim();
    var password = form.elements.password.value;
    if (!username || !password) {
      setMsg($('loginMsg'), 'نام کاربری و رمز عبور را وارد کنید.', true);
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      var data = await api('/api/login', { method: 'POST', json: { username: username, password: password } });
      setSession(data.token, data.user);
      form.reset();
      setMsg($('loginMsg'), '', false);
      $('loginDialog').close();
      showToast('خوش آمدید، ' + data.user.username);
    } catch (err) {
      setMsg($('loginMsg'), err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('registerForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var username = form.elements.username.value.trim();
    var password = form.elements.password.value;
    var confirm = form.elements.confirm.value;
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setMsg($('registerMsg'), 'نام کاربری باید ۳ تا ۳۲ کاراکتر و فقط حروف انگلیسی، عدد و _ باشد.', true);
      return;
    }
    if (password.length < 6) {
      setMsg($('registerMsg'), 'رمز عبور باید حداقل ۶ کاراکتر باشد.', true);
      return;
    }
    if (password !== confirm) {
      setMsg($('registerMsg'), 'رمز عبور و تکرار آن یکسان نیستند.', true);
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/register', { method: 'POST', json: { username: username, password: password } });
      var data = await api('/api/login', { method: 'POST', json: { username: username, password: password } });
      setSession(data.token, data.user);
      form.reset();
      setMsg($('registerMsg'), '', false);
      $('registerDialog').close();
      showToast('حساب شما ساخته شد و وارد شدید.');
    } catch (err) {
      setMsg($('registerMsg'), err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async function () {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* نشست محلی پاک می‌شود */ }
    clearSession();
    showToast('از حساب خارج شدید.');
  });

  /* ---------- Upload ---------- */

  $('uploadOpenBtn').addEventListener('click', function () {
    if (!state.user) {
      showToast('برای انتشار بازی ابتدا وارد شوید.', true);
      openDialog('loginDialog');
      return;
    }
    setMsg($('uploadMsg'), '', false);
    openDialog('uploadDialog');
  });

  $('uploadForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var msg = $('uploadMsg');
    var progress = $('uploadProgress');
    var submit = $('uploadSubmit');

    if (!state.user || !state.token) {
      setMsg(msg, 'برای انتشار بازی باید وارد شوید.', true);
      return;
    }
    var file = form.elements.game.files[0];
    if (!file) {
      setMsg(msg, 'فایل بازی را انتخاب کنید.', true);
      return;
    }
    var dot = file.name.lastIndexOf('.');
    var ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (ALLOWED_EXT.indexOf(ext) === -1) {
      setMsg(msg, 'پسوند فایل مجاز نیست.', true);
      return;
    }
    if (file.size === 0) {
      setMsg(msg, 'فایل بازی خالی است.', true);
      return;
    }
    if (file.size > MAX_SIZE) {
      setMsg(msg, 'حجم فایل بیشتر از ۵۰۰ مگابایت است.', true);
      return;
    }
    if (!form.elements.category.value) {
      setMsg(msg, 'دسته‌بندی را انتخاب کنید.', true);
      return;
    }

    var fd = new FormData(form);
    submit.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    setMsg(msg, 'در حال آپلود فایل...', false);
    try {
      var data = await uploadWithProgress(fd, function (p) { progress.value = p; });
      form.reset();
      setMsg(msg, '', false);
      $('uploadDialog').close();
      showToast((data && data.message) || 'بازی با موفقیت منتشر شد.');
      loadGames();
    } catch (err) {
      setMsg(msg, err.message, true);
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  });

  /* ---------- Shared UI ---------- */

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { btn.closest('dialog').close(); });
  });

  var searchTimer = null;
  $('searchInput').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.q = e.target.value.trim();
      loadGames();
    }, 300);
  });

  /* ---------- Init ---------- */

  async function init() {
    renderAuth();
    if (state.token) {
      try {
        var data = await api('/api/me');
        state.user = data.user;
      } catch (err) {
        clearSession();
      }
      renderAuth();
    }
    renderCategories();
    fillCategorySelect();
    await loadCategories();
    loadGames();
  }

  init();
})();
