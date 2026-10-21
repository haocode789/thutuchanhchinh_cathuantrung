const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client/web');

let compression = null;
try { compression = require('compression'); } catch (_) { /* tùy chọn: chạy npm install để bật nén gzip */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
if (compression) app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('❌ LỖI: Chưa cấu hình TURSO_DATABASE_URL hoặc TURSO_AUTH_TOKEN!');
}

const db = createClient({
  url: (process.env.TURSO_DATABASE_URL || '').trim(),
  authToken: (process.env.TURSO_AUTH_TOKEN || '').trim()
});



/* ====== XÁC THỰC QUẢN TRỊ ======
   - Mật khẩu lưu dạng bcrypt (mật khẩu cũ dạng chữ thường sẽ tự được mã hóa ở lần đăng nhập đầu tiên)
   - Đăng nhập thành công trả về token ký HMAC (hết hạn sau 12 giờ). Mọi API /api/admin/* đều phải gửi token này.
   - Token không cần lưu ở máy chủ nên chạy tốt trên Vercel (serverless). Nên đặt biến môi trường AUTH_SECRET (chuỗi dài, ngẫu nhiên). */
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update('tthc|' + (process.env.TURSO_AUTH_TOKEN || 'dev')).digest('hex');
const TOKEN_TTL = 12 * 60 * 60 * 1000;
function signToken(username) {
  const body = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && p.exp > Date.now() ? p : null;
  } catch (_) { return null; }
}
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return res.status(401).json({ success: false, message: 'Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại!' });
  req.admin = p;
  next();
}
const isHashed = v => /^\$2[aby]\$/.test(String(v || ''));
// Kiểm tra mật khẩu (hỗ trợ cả mật khẩu cũ chưa mã hóa)
async function checkPassword(plain, stored) {
  plain = String(plain || ''); stored = String(stored || '');
  if (!plain || !stored) return false;
  return isHashed(stored) ? bcrypt.compare(plain, stored) : plain === stored;
}
// Chặn dò mật khẩu: tối đa 8 lần sai / 10 phút cho mỗi tài khoản + địa chỉ IP (tính theo từng container)
const loginFails = new Map();
function loginKey(req, username) { return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() + '|' + String(username || '').toLowerCase(); }
function isLocked(key) { const f = loginFails.get(key); return !!f && f.n >= 8 && Date.now() - f.at < 10 * 60 * 1000; }
function noteFail(key) { const f = loginFails.get(key); loginFails.set(key, { n: f && Date.now() - f.at < 10 * 60 * 1000 ? f.n + 1 : 1, at: Date.now() }); if (loginFails.size > 500) loginFails.delete(loginFails.keys().next().value); }

/* ====== BỘ NHỚ ĐỆM + DỮ LIỆU NHẸ CHO TRANG CHỦ ======
   - Ảnh/logo dạng data:URL (base64) KHÔNG còn nằm trong JSON; được trả qua /api/media/... (có cache trình duyệt)
   - Danh sách thủ tục không kèm file Word/PDF/ảnh (chỉ lấy khi mở chi tiết)
   - Một API /api/home trả về cả cấu hình + lĩnh vực + thủ tục, có cache bộ nhớ phía server */
const APP_VERSION = (() => { try { return require('./package.json').version || ''; } catch (_) { return ''; } })();
const HOME_TTL = 10000; // 10 giây: trên Vercel mỗi container có bộ nhớ riêng nên để ngắn để các container cập nhật nhanh sau khi sửa dữ liệu
const MEDIA_SETTINGS = ['bg_image', 'site_logo'];
let homeCache = null;
const fullCache = new Map();
function bust() { homeCache = null; fullCache.clear(); }

const SETTINGS_SQL = `SELECT key,
  CASE WHEN value LIKE 'data:%' THEN '/api/media/setting/' || key || '?v=' || length(value) ELSE value END AS value
  FROM settings`;
const CATEGORIES_SQL = `SELECT id, sort_order, COALESCE(parent_id, 0) AS parent_id, name, background_color, description, agency, address, map_url, phone, COALESCE(active, 1) AS active,
  CASE WHEN background_image LIKE 'data:%' THEN '/api/media/category/' || id || '?v=' || length(background_image) ELSE background_image END AS background_image
  FROM categories ORDER BY sort_order ASC, id ASC`;
const PROCEDURES_SQL = `SELECT id, sort_order, title, category, video_url, description, agency, address, map_url, phone, createdAt,
  document_name, common_errors, common_errors_doc_name, steps, contact_info, service_url, COALESCE(tag, '') AS tag,
  CASE WHEN COALESCE(document_url, '') <> '' THEN 1 ELSE 0 END AS has_doc,
  CASE WHEN COALESCE(common_errors_doc_url, '') <> '' THEN 1 ELSE 0 END AS has_err_doc
  FROM procedures ORDER BY sort_order ASC, id ASC`;

async function loadHome() {
  const [s, c, p] = await db.batch([SETTINGS_SQL, CATEGORIES_SQL, PROCEDURES_SQL], 'read');
  const settings = {};
  s.rows.forEach(r => settings[r.key] = r.value);
  return { settings, categories: c.rows, procedures: p.rows, version: APP_VERSION };
}
function getHome() {
  if (!homeCache || Date.now() - homeCache.at > HOME_TTL) {
    const promise = loadHome().catch(err => {
      if (homeCache && homeCache.promise === promise) homeCache = null;
      throw err;
    });
    homeCache = { at: Date.now(), promise };
  }
  return homeCache.promise;
}

app.get('/api/media/:kind/:key', async (req, res) => {
  try {
    let value = '';
    if (req.params.kind === 'category') {
      const r = await db.execute({ sql: `SELECT background_image AS v FROM categories WHERE id = ?`, args: [Number(req.params.key)] });
      value = r.rows[0]?.v || '';
    } else if (req.params.kind === 'setting' && MEDIA_SETTINGS.includes(req.params.key)) {
      const r = await db.execute({ sql: `SELECT value AS v FROM settings WHERE key = ?`, args: [req.params.key] });
      value = r.rows[0]?.v || '';
    } else return res.status(404).end();
    value = String(value);
    const m = value.match(/^data:([^;,]*)((?:;[^,]*)?),([\s\S]*)$/);
    if (!m) {
      if (/^https?:\/\//i.test(value)) return res.redirect(value);
      return res.status(404).end();
    }
    const mime = m[1] || 'application/octet-stream';
    if (!/^image\//i.test(mime)) return res.status(404).end();
    const buf = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    res.set({
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
    });
    res.send(buf);
  } catch (err) { res.status(500).end(); }
});

// Chuẩn hóa link làm thủ tục: tự thêm https:// nếu thiếu, chỉ chấp nhận http/https
function normalizeServiceUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (_) { return ''; }
}

function formatVideoEmbedUrl(url) {
  if (!url) return '';
  let cleanUrl = String(url).trim();
  const iframeMatch = cleanUrl.match(/src=["']([^"']+)["']/);
  if (iframeMatch) cleanUrl = iframeMatch[1];

  if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
    if (cleanUrl.includes('facebook.com/plugins/video.php')) return cleanUrl;
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(cleanUrl)}&show_text=false&autoplay=false`;
  }
  if (cleanUrl.includes('drive.google.com')) {
    const fileIdMatch = cleanUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (fileIdMatch?.[1]) return `https://drive.google.com/file/d/${fileIdMatch[1]}/preview`;
  }
  if (cleanUrl.includes('youtu.be/')) {
    const videoId = cleanUrl.split('youtu.be/')[1]?.split('?')[0];
    if (videoId) return `https://www.youtube.com/embed/${videoId}`;
  }
  if (cleanUrl.includes('youtube.com/watch')) {
    try {
      const urlObj = new URL(cleanUrl);
      const videoId = urlObj.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
    } catch (_) {
      const match = cleanUrl.match(/v=([a-zA-Z0-9_-]+)/);
      if (match?.[1]) return `https://www.youtube.com/embed/${match[1]}`;
    }
  }
  return cleanUrl;
}

async function ensureColumn(table, name, type) {
  try {
    await db.execute(`SELECT ${name} FROM ${table} LIMIT 1`);
  } catch (_) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

async function initDB() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT,
      role TEXT,
      name TEXT
    )`);
    for (const [name, type] of [
      ['email', "TEXT DEFAULT ''"], ['phone', "TEXT DEFAULT ''"],
      ['status', "TEXT DEFAULT 'active'"], ['created_by', "TEXT DEFAULT ''"],
      ['created_at', "TEXT DEFAULT ''"], ['must_change_password', 'INTEGER DEFAULT 1'],
      ['is_superadmin', 'INTEGER DEFAULT 0']
    ]) await ensureColumn('users', name, type);
    await db.execute(`CREATE TABLE IF NOT EXISTS user_permissions (
      username TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      can_view INTEGER DEFAULT 0,
      can_add INTEGER DEFAULT 0,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      can_approve INTEGER DEFAULT 0,
      PRIMARY KEY (username, category_id)
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT DEFAULT '',
      action TEXT DEFAULT '',
      method TEXT DEFAULT '',
      path TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      category TEXT DEFAULT '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ',
      video_url TEXT NOT NULL,
      image_url TEXT,
      description TEXT,
      document_url TEXT,
      document_name TEXT,
      common_errors TEXT,
      common_errors_doc_url TEXT,
      common_errors_doc_name TEXT,
      agency TEXT,
      address TEXT,
      map_url TEXT,
      phone TEXT,
      createdAt TEXT
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER DEFAULT 1,
      name TEXT NOT NULL UNIQUE,
      background_image TEXT,
      background_color TEXT DEFAULT '#ffffff',
      description TEXT DEFAULT '',
      agency TEXT DEFAULT '',
      map_url TEXT DEFAULT '',
      phone TEXT DEFAULT ''
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS visitors (
      visitor_id TEXT PRIMARY KEY,
      first_seen TEXT,
      last_seen TEXT,
      visits INTEGER DEFAULT 1
    )`);

    const procedureColumns = [
      ['image_url', 'TEXT'], ['description', 'TEXT'],
      ['category', 'TEXT DEFAULT "1. LĨNH VỰC QUẢN LÝ CƯ TRÚ"'],
      ['sort_order', 'INTEGER DEFAULT 1'], ['document_url', 'TEXT'],
      ['document_name', 'TEXT'], ['common_errors', 'TEXT'],
      ['common_errors_doc_url', 'TEXT'], ['common_errors_doc_name', 'TEXT'],
      ['agency', 'TEXT'], ['address', 'TEXT'], ['map_url', 'TEXT'], ['phone', 'TEXT'],
      ['steps', 'TEXT'], ['contact_info', 'TEXT'], ['service_url', 'TEXT'], ["tag", "TEXT DEFAULT ''"]
    ];
    for (const [name, type] of procedureColumns) await ensureColumn('procedures', name, type);

    const categoryColumns = [['agency','TEXT DEFAULT \'\''], ['map_url','TEXT DEFAULT \'\''], ['phone','TEXT DEFAULT \'\''], ['parent_id','INTEGER DEFAULT 0'], ['address','TEXT DEFAULT \'\''], ['active','INTEGER DEFAULT 1']];
    for (const [name, type] of categoryColumns) await ensureColumn('categories', name, type);

    const defaultSettings = [
      ['bg_color', '#f0f4f8'],
      ['bg_image', 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1920&q=80'],
      ['site_logo', 'logo.jpg'],
      ['title_main', 'CÔNG AN XÃ THUẦN TRUNG'],
      ['title_sub', 'Hỗ trợ thủ tục hành chính'],
      ['footer_text', 'Phần mềm này được phát triển bởi Công an xã Thuần Trung'],
      ['guide_content', '1. Chọn lĩnh vực thủ tục hành chính cần thực hiện.\n2. Chọn thủ tục để xem video hướng dẫn.\n3. Đọc mục lỗi thường gặp và tài liệu minh họa trước khi thực hiện.\n4. Xem thông tin cơ quan xử lý, địa chỉ, bản đồ và số điện thoại nếu cần hỗ trợ.\n5. Có thể dùng ô tìm kiếm hoặc nút “Tất cả thủ tục hành chính” để tìm nhanh thủ tục.']
    ];
    for (const [key, value] of defaultSettings) {
      await db.execute({ sql: `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, args: [key, value] });
    }

    const defaultCategories = [
      [1, '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', '#c8e6c9'],
      [2, '2. LĨNH VỰC ĐĂNG KÝ XE', '#ffccbc'],
      [3, '3. LĨNH VỰC CẤP HỘ CHIẾU', '#bbdefb']
    ];
    const catCount = await db.execute(`SELECT COUNT(*) AS total FROM categories`);
    if (Number(catCount.rows[0].total) === 0) { // chỉ tạo lĩnh vực mẫu lần đầu, không tạo lại những lĩnh vực bạn đã xóa/đổi tên
      for (const [sort_order, name, background_color] of defaultCategories) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO categories (sort_order, name, background_image, background_color, description) VALUES (?, ?, '', ?, '')`,
          args: [sort_order, name, background_color]
        });
      }
    }

    const adminCheck = await db.execute(`SELECT username FROM users WHERE username = 'admin'`);
    if (adminCheck.rows.length === 0) {
      await db.execute({ sql: `INSERT INTO users (username,password,role,name,status,created_at,must_change_password,is_superadmin) VALUES ('admin', ?, 'admin', 'Quản trị viên', 'active', ?, 1, 1)`, args: [await bcrypt.hash('123456', 10), new Date().toISOString()] });
    } else {
      await db.execute(`UPDATE users SET role='admin', is_superadmin=1, status='active' WHERE username='admin'`);
    }
    console.log('🚀 Khởi tạo CSDL thành công!');
    getHome().catch(() => {});
  } catch (err) {
    console.error('❌ Lỗi kết nối CSDL:', err.message);
    throw err;
  }
}

// Vercel (serverless): khởi tạo CSDL 1 lần, các request /api chờ xong rồi mới chạy
let dbReady = null;
app.use('/api/admin', requireAdmin);

app.use('/api', async (_req, res, next) => {
  try {
    if (!dbReady) dbReady = initDB();
    await dbReady;
    next();
  } catch (err) {
    dbReady = null; // lần sau thử lại
    res.status(500).json({ success: false, message: 'Lỗi kết nối CSDL: ' + err.message });
  }
});

// Nạp tài khoản hiện hành cho các API quản trị và kiểm tra trạng thái tài khoản.
app.use('/api/admin', async (req, res, next) => {
  try {
    const r = await db.execute({ sql: `SELECT username, role, name, email, phone, status, COALESCE(is_superadmin,0) AS is_superadmin FROM users WHERE username = ?`, args: [req.admin.u] });
    const u = r.rows[0];
    if (!u || String(u.status || 'active') !== 'active') return res.status(403).json({ success: false, message: 'Tài khoản đã bị khóa hoặc không còn tồn tại.' });
    req.adminUser = u;
    next();
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

function auditAction(req) {
  const p = String(req.path || '');
  if (p.includes('/categories')) return req.method === 'DELETE' ? 'Xóa lĩnh vực' : 'Cập nhật lĩnh vực';
  if (p.includes('/procedures')) return req.method === 'DELETE' ? 'Xóa thủ tục' : 'Cập nhật thủ tục';
  if (p.includes('/users') && p.includes('/permissions')) return 'Cập nhật phân quyền';
  if (p.includes('/users')) return req.method === 'DELETE' ? 'Xóa tài khoản' : 'Cập nhật tài khoản';
  if (p.includes('/settings')) return 'Cập nhật giao diện/cấu hình';
  if (p.includes('/notices')) return req.method === 'DELETE' ? 'Xóa thông báo' : 'Cập nhật thông báo';
  if (p.includes('/change-password')) return 'Đổi mật khẩu';
  return 'Thay đổi dữ liệu quản trị';
}
// Ghi lịch sử tự động cho mọi thao tác làm thay đổi dữ liệu quản trị.
app.use('/api/admin', (req, res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    db.execute({sql:`INSERT INTO audit_logs (username,action,method,path,created_at) VALUES (?,?,?,?,?)`,args:[String(req.adminUser?.username||req.admin?.u||''),auditAction(req),req.method,String(req.originalUrl||req.path||''),new Date().toISOString()] }).catch(()=>{});
  });
  next();
});

app.get('/api/admin/history', async (req, res) => {
  if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được xem lịch sử thay đổi.');
  try {
    const r = await db.execute(`SELECT id,username,action,method,path,created_at FROM audit_logs ORDER BY id DESC LIMIT 120`);
    res.json({success:true,data:r.rows});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
});

function isSuperAdmin(req) {
  return !!(req.adminUser && (String(req.adminUser.role) === 'admin' || Number(req.adminUser.is_superadmin) === 1));
}
function deny(res, message='Bạn không có quyền thực hiện thao tác này.') { return res.status(403).json({ success:false, message }); }
async function permissionFor(req, categoryId, action='view') {
  if (isSuperAdmin(req)) return true;
  categoryId = Number(categoryId);
  if (!categoryId) return false;
  const cat = await db.execute({ sql:`SELECT id, COALESCE(parent_id,0) AS parent_id FROM categories WHERE id=?`, args:[categoryId] });
  if (!cat.rows.length) return false;
  const ids = [categoryId];
  const parentId = Number(cat.rows[0].parent_id || 0);
  if (parentId) ids.push(parentId);
  const col = ({view:'can_view',add:'can_add',edit:'can_edit',delete:'can_delete',approve:'can_approve'})[action] || 'can_view';
  const q = await db.execute({ sql:`SELECT ${col} AS allowed FROM user_permissions WHERE username=? AND category_id IN (${ids.map(()=>'?').join(',')})`, args:[req.adminUser.username, ...ids] });
  return q.rows.some(x => Number(x.allowed) === 1);
}
async function categoryIdByName(name) {
  const r = await db.execute({ sql:`SELECT id FROM categories WHERE name=? LIMIT 1`, args:[String(name||'').trim()] });
  return r.rows.length ? Number(r.rows[0].id) : 0;
}

app.get('/api/home', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-cache');
    res.json({ success: true, data: await getHome() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/settings', async (_req, res) => {
  try { res.json({ success: true, data: (await getHome()).settings }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/settings', async (req, res) => {
  if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được sửa giao diện.');
  try {
    for (const [key, rawValue] of Object.entries(req.body || {})) {
      if (typeof rawValue === 'string' && rawValue.startsWith('/api/media/setting/')) continue; // ảnh không đổi
      const value = rawValue == null ? '' : String(rawValue);
      await db.execute({
        sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [key, value]
      });
    }
    bust();
    res.json({ success: true, message: 'Lưu cấu hình giao diện thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = loginKey(req, username);
  if (isLocked(key)) return res.status(429).json({ success: false, message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 10 phút!' });
  try {
    const result = await db.execute({ sql: `SELECT * FROM users WHERE username = ?`, args: [String(username || '')] });
    const u = result.rows[0];
    if (u && String(u.status || 'active') !== 'active') return res.status(403).json({ success:false, message:'Tài khoản đang bị khóa.' });
    if (u && await checkPassword(password, u.password)) {
      if (!isHashed(u.password)) { // nâng cấp mật khẩu cũ lên dạng mã hóa
        await db.execute({ sql: `UPDATE users SET password = ? WHERE username = ?`, args: [await bcrypt.hash(String(password), 10), u.username] });
      }
      loginFails.delete(key);
      return res.json({ success: true, token: signToken(u.username), user: { username: u.username, name: u.name, role: u.role, email:u.email||'', phone:u.phone||'', is_superadmin:Number(u.is_superadmin||0), must_change_password:Number(u.must_change_password||0) } });
    }
    noteFail(key);
    res.json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/change-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const username = req.admin.u; // lấy từ token, không tin tên gửi lên
  try {
    if (!oldPassword || !newPassword) return res.json({ success: false, message: 'Vui lòng nhập đủ thông tin!' });
    if (String(newPassword).length < 6) return res.json({ success: false, message: 'Mật khẩu mới phải từ 6 ký tự trở lên!' });
    const check = await db.execute({ sql: `SELECT password FROM users WHERE username = ?`, args: [username] });
    if (!check.rows.length || !(await checkPassword(oldPassword, check.rows[0].password))) return res.json({ success: false, message: 'Mật khẩu cũ không đúng!' });
    await db.execute({ sql: `UPDATE users SET password = ? WHERE username = ?`, args: [await bcrypt.hash(String(newPassword), 10), username] });
    res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ====== TÀI KHOẢN CON & PHÂN QUYỀN ======
app.get('/api/admin/users', async (req, res) => {
  if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được quản lý tài khoản.');
  try {
    const r = await db.execute(`SELECT username,name,role,email,phone,status,created_by,created_at,COALESCE(must_change_password,0) AS must_change_password,COALESCE(is_superadmin,0) AS is_superadmin FROM users ORDER BY is_superadmin DESC, username ASC`);
    res.json({success:true,data:r.rows});
  } catch(err){ res.status(500).json({success:false,message:err.message}); }
});

app.post('/api/admin/users', async (req, res) => {
  if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được quản lý tài khoản.');
  const b=req.body||{}; const username=String(b.username||'').trim().toLowerCase(); const name=String(b.name||'').trim();
  if(!/^[a-z0-9._-]{3,40}$/.test(username)) return res.json({success:false,message:'Tên đăng nhập từ 3-40 ký tự, chỉ dùng chữ thường, số, dấu chấm, gạch dưới hoặc gạch ngang.'});
  if(!name) return res.json({success:false,message:'Vui lòng nhập họ tên.'});
  const status=String(b.status||'active')==='locked'?'locked':'active';
  try {
    const exists=await db.execute({sql:`SELECT username,is_superadmin FROM users WHERE username=?`,args:[username]});
    if(exists.rows.length){
      if(Number(exists.rows[0].is_superadmin)===1 && username!==req.adminUser.username) return deny(res,'Không thể sửa quản trị viên hệ thống khác.');
      await db.execute({sql:`UPDATE users SET name=?, email=?, phone=?, status=? WHERE username=?`,args:[name,String(b.email||'').trim(),String(b.phone||'').trim(),status,username]});
      if(String(b.password||'').length){ if(String(b.password).length<6)return res.json({success:false,message:'Mật khẩu phải từ 6 ký tự.'}); await db.execute({sql:`UPDATE users SET password=?, must_change_password=1 WHERE username=?`,args:[await bcrypt.hash(String(b.password),10),username]}); }
      return res.json({success:true,message:'Đã cập nhật tài khoản.'});
    }
    if(String(b.password||'').length<6) return res.json({success:false,message:'Mật khẩu ban đầu phải từ 6 ký tự.'});
    await db.execute({sql:`INSERT INTO users (username,password,role,name,email,phone,status,created_by,created_at,must_change_password,is_superadmin) VALUES (?,?,?,?,?,?,?,?,?,1,0)`,args:[username,await bcrypt.hash(String(b.password),10),'staff',name,String(b.email||'').trim(),String(b.phone||'').trim(),status,req.adminUser.username,new Date().toISOString()]});
    res.json({success:true,message:'Đã tạo tài khoản con.'});
  } catch(err){ const msg=/unique/i.test(String(err.message))?'Tên đăng nhập đã tồn tại.':err.message; res.status(500).json({success:false,message:msg}); }
});

app.delete('/api/admin/users/:username', async (req,res)=>{
  if(!isSuperAdmin(req)) return deny(res,'Chỉ quản trị viên hệ thống mới được quản lý tài khoản.');
  const username=String(req.params.username||'').trim();
  if(username===req.adminUser.username) return res.json({success:false,message:'Không thể xóa tài khoản đang đăng nhập.'});
  try{
    const r=await db.execute({sql:`SELECT COALESCE(is_superadmin,0) AS is_superadmin FROM users WHERE username=?`,args:[username]});
    if(!r.rows.length)return res.json({success:false,message:'Không tìm thấy tài khoản.'});
    if(Number(r.rows[0].is_superadmin)===1)return deny(res,'Không thể xóa quản trị viên hệ thống.');
    await db.batch([{sql:`DELETE FROM user_permissions WHERE username=?`,args:[username]},{sql:`DELETE FROM users WHERE username=?`,args:[username]}],'write');
    res.json({success:true,message:'Đã xóa tài khoản.'});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

app.get('/api/admin/users/:username/permissions', async (req,res)=>{
  if(!isSuperAdmin(req) && String(req.params.username)!==String(req.adminUser.username)) return deny(res);
  try{const r=await db.execute({sql:`SELECT category_id,can_view,can_add,can_edit,can_delete,can_approve FROM user_permissions WHERE username=?`,args:[String(req.params.username)]});res.json({success:true,data:r.rows});}
  catch(err){res.status(500).json({success:false,message:err.message});}
});

app.post('/api/admin/users/:username/permissions', async (req,res)=>{
  if(!isSuperAdmin(req)) return deny(res,'Chỉ quản trị viên hệ thống mới được phân quyền.');
  const username=String(req.params.username||'').trim(); const rows=Array.isArray(req.body?.permissions)?req.body.permissions:[];
  try{
    const u=await db.execute({sql:`SELECT COALESCE(is_superadmin,0) AS is_superadmin FROM users WHERE username=?`,args:[username]});
    if(!u.rows.length)return res.json({success:false,message:'Không tìm thấy tài khoản.'});
    if(Number(u.rows[0].is_superadmin)===1)return res.json({success:false,message:'Quản trị viên hệ thống luôn có toàn quyền, không cần phân quyền.'});
    const stmts=[{sql:`DELETE FROM user_permissions WHERE username=?`,args:[username]}];
    for(const x of rows){const cid=Number(x.category_id);if(!cid)continue;stmts.push({sql:`INSERT INTO user_permissions (username,category_id,can_view,can_add,can_edit,can_delete,can_approve) VALUES (?,?,?,?,?,?,?)`,args:[username,cid,x.can_view?1:0,x.can_add?1:0,x.can_edit?1:0,x.can_delete?1:0,x.can_approve?1:0]});}
    await db.batch(stmts,'write'); res.json({success:true,message:'Đã lưu phân quyền.'});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

// Gán danh sách thủ tục vào 1 lĩnh vực (category = tên lĩnh vực, '' = chưa phân lĩnh vực).
// replace = true: thủ tục đang thuộc lĩnh vực này nhưng không nằm trong ids sẽ chuyển về "chưa phân lĩnh vực".
async function assignProcedures(category, ids, replace) {
  category = String(category == null ? '' : category).trim();
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))];
  let info = {};
  if (category) {
    const r = await db.execute({ sql: `SELECT agency, map_url, phone FROM categories WHERE name = ?`, args: [category] });
    if (!r.rows.length) throw new Error('Không tìm thấy lĩnh vực!');
    info = r.rows[0];
  }
  const stmts = [];
  if (replace && category) {
    stmts.push({
      sql: `UPDATE procedures SET category = '', agency = '', map_url = '', phone = '', address = '' WHERE category = ?${ids.length ? ` AND id NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
      args: [category, ...ids]
    });
  }
  if (ids.length) {
    const cur = await db.execute({ sql: `SELECT id, category FROM procedures WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
    const was = new Map(cur.rows.map(r => [Number(r.id), String(r.category || '')]));
    const mx = await db.execute({ sql: `SELECT COALESCE(MAX(sort_order), 0) AS m FROM procedures WHERE category = ?`, args: [category] });
    let next = Number(mx.rows[0].m) || 0;
    ids.forEach(id => {
      if (!was.has(id)) return;
      const moved = was.get(id) !== category; // thủ tục mới chuyển đến thì xếp xuống cuối lĩnh vực
      stmts.push({
        sql: `UPDATE procedures SET category = ?, agency = ?, map_url = ?, phone = ?, address = ''${moved ? ', sort_order = ?' : ''} WHERE id = ?`,
        args: [category, info.agency || '', info.map_url || '', info.phone || '', ...(moved ? [++next] : []), id]
      });
    });
  }
  if (stmts.length) await db.batch(stmts, 'write');
  bust();
  return ids.length;
}

app.post('/api/admin/procedures/assign', async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
  const category = String(b.category == null ? '' : b.category).trim();
  if (!ids.length && !(b.replace && category)) return res.json({ success: false, message: 'Chưa chọn thủ tục nào.' });
  try {
    const targetId = category ? await categoryIdByName(category) : 0;
    if (!isSuperAdmin(req) && (!targetId || !(await permissionFor(req, targetId, 'add')))) return deny(res);
    const n = await assignProcedures(category, ids, !!b.replace);
    res.json({ success: true, message: category ? `Đã chuyển ${n} thủ tục vào “${category}”.` : `Đã chuyển ${n} thủ tục về mục “Chưa phân lĩnh vực”.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/categories', async (_req, res) => {
  try { res.json({ success: true, data: (await getHome()).categories }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Nhập các lĩnh vực mẫu (chỉ thêm những lĩnh vực chưa có tên trùng)
app.post('/api/admin/categories/import-defaults', async (req, res) => {
  if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được nhập danh mục mẫu.');
  const defaults = [['1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', '#c8e6c9'], ['2. LĨNH VỰC ĐĂNG KÝ XE', '#ffccbc'], ['3. LĨNH VỰC CẤP HỘ CHIẾU', '#bbdefb']];
  try {
    const have = new Set((await db.execute(`SELECT name FROM categories`)).rows.map(r => r.name));
    let next = Number((await db.execute(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE COALESCE(parent_id, 0) = 0`)).rows[0].m) || 0;
    const stmts = [];
    for (const [name, color] of defaults) {
      if (have.has(name)) continue;
      stmts.push({ sql: `INSERT INTO categories (sort_order, parent_id, name, background_image, background_color, description, agency, address, active, map_url, phone) VALUES (?, 0, ?, '', ?, '', '', '', 1, '', '')`, args: [++next, name, color] });
    }
    if (stmts.length) await db.batch(stmts, 'write');
    bust();
    res.json({ success: true, message: stmts.length ? `Đã nhập ${stmts.length} lĩnh vực mẫu.` : 'Các lĩnh vực mẫu đã có sẵn, không cần nhập thêm.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/categories', async (req, res) => {
  const { id, sort_order, name, background_image, background_color, description, agency, address, active, map_url, phone, parent_id, procedure_ids } = req.body || {};
  const activeVal = (active === 0 || active === '0' || active === false) ? 0 : 1;
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.json({ success: false, message: 'Vui lòng nhập tên lĩnh vực!' });
  const orderNum = Math.max(1, parseInt(sort_order, 10) || 1);
  const parentId = Math.max(0, parseInt(parent_id, 10) || 0);
  try {
    if (id) {
      if (!(await permissionFor(req, Number(id), 'edit'))) return deny(res);
    } else if (parentId) {
      if (!(await permissionFor(req, parentId, 'add'))) return deny(res);
    } else if (!isSuperAdmin(req)) return deny(res, 'Chỉ quản trị viên hệ thống mới được tạo lĩnh vực cấp cao nhất.');
    // Chỉ hỗ trợ 2 cấp: Lĩnh vực -> Lĩnh vực con
    if (parentId) {
      if (id && Number(id) === parentId) return res.json({ success: false, message: 'Lĩnh vực không thể là con của chính nó!' });
      const par = await db.execute({ sql: `SELECT parent_id FROM categories WHERE id = ?`, args: [parentId] });
      if (!par.rows.length) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực cha!' });
      if (Number(par.rows[0].parent_id || 0) !== 0) return res.json({ success: false, message: 'Chỉ hỗ trợ 2 cấp: lĩnh vực và lĩnh vực con.' });
      if (id) {
        const kids = await db.execute({ sql: `SELECT COUNT(*) AS total FROM categories WHERE parent_id = ?`, args: [Number(id)] });
        if (Number(kids.rows[0].total) > 0) return res.json({ success: false, message: 'Lĩnh vực này đang có lĩnh vực con nên không thể chuyển thành lĩnh vực con.' });
      }
    }
    if (id) {
      const oldResult = await db.execute({ sql: `SELECT name FROM categories WHERE id = ?`, args: [Number(id)] });
      if (!oldResult.rows.length) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
      const previousName = oldResult.rows[0].name;
      const keepBg = String(background_image || '').startsWith('/api/media/category/');
      await db.execute({
        sql: `UPDATE categories SET sort_order = ?, parent_id = ?, name = ?, ${keepBg ? '' : 'background_image = ?, '}background_color = ?, description = ?, agency = ?, address = ?, active = ?, map_url = ?, phone = ? WHERE id = ?`,
        args: [orderNum, parentId, cleanName, ...(keepBg ? [] : [background_image || '']), background_color || '#ffffff', description || '', agency || '', String(address || '').trim(), activeVal, map_url || '', phone || '', Number(id)]
      });
      if (previousName !== cleanName) {
        await db.execute({ sql: `UPDATE procedures SET category = ? WHERE category = ?`, args: [cleanName, previousName] });
      }
      await db.execute({
        sql: `UPDATE procedures SET agency = ?, map_url = ?, phone = ?, address = '' WHERE category = ?`,
        args: [agency || '', map_url || '', phone || '', cleanName]
      });
      let assigned = null;
      if (Array.isArray(procedure_ids)) assigned = await assignProcedures(cleanName, procedure_ids, true);
      bust();
      return res.json({ success: true, id: Number(id), message: 'Cập nhật lĩnh vực thành công!' + (assigned === null ? '' : ` Có ${assigned} thủ tục thuộc lĩnh vực này.`) });
    }
    const ins = await db.execute({
      sql: `INSERT INTO categories (sort_order, parent_id, name, background_image, background_color, description, agency, address, active, map_url, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderNum, parentId, cleanName, background_image || '', background_color || '#ffffff', description || '', agency || '', String(address || '').trim(), activeVal, map_url || '', phone || '']
    });
    let assigned = null;
    if (Array.isArray(procedure_ids) && procedure_ids.length) assigned = await assignProcedures(cleanName, procedure_ids, true);
    bust();
    res.json({ success: true, id: Number(ins.lastInsertRowid), message: (parentId ? 'Thêm lĩnh vực con thành công!' : 'Thêm lĩnh vực mới thành công!') + (assigned ? ` Đã đưa ${assigned} thủ tục vào lĩnh vực này.` : '') });
  } catch (err) {
    const msg = /unique/i.test(String(err.message)) ? 'Tên lĩnh vực đã tồn tại!' : 'Lỗi lưu lĩnh vực: ' + err.message;
    res.status(500).json({ success: false, message: msg });
  }
});

app.delete('/api/admin/categories/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const found = await db.execute({ sql: `SELECT id, name, COALESCE(parent_id,0) AS parent_id FROM categories WHERE id = ?`, args: [id] });
    if (!found.rows.length) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
    if (!(await permissionFor(req, id, 'delete'))) return deny(res);

    // Cho phép xóa cả mục lớn. Thủ tục được giữ lại an toàn và chuyển về “Chưa phân lĩnh vực”.
    const children = await db.execute({ sql:`SELECT id, name FROM categories WHERE parent_id=?`, args:[id] });
    const names = [String(found.rows[0].name), ...children.rows.map(x=>String(x.name))];
    if (names.length) {
      await db.execute({ sql:`UPDATE procedures SET category='', agency='', address='', map_url='', phone='' WHERE category IN (${names.map(()=>'?').join(',')})`, args:names });
    }
    if (children.rows.length) {
      await db.execute({ sql:`DELETE FROM user_permissions WHERE category_id IN (${children.rows.map(()=>'?').join(',')})`, args:children.rows.map(x=>Number(x.id)) });
      await db.execute({ sql:`DELETE FROM categories WHERE parent_id=?`, args:[id] });
    }
    await db.execute({ sql:`DELETE FROM user_permissions WHERE category_id=?`, args:[id] });
    await db.execute({ sql:`DELETE FROM categories WHERE id=?`, args:[id] });
    bust();
    res.json({ success: true, message: children.rows.length ? `Đã xóa mục lớn và ${children.rows.length} mục con. Các thủ tục liên quan đã chuyển về “Chưa phân lĩnh vực”.` : 'Đã xóa lĩnh vực. Các thủ tục liên quan đã chuyển về “Chưa phân lĩnh vực”.' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi khi xóa lĩnh vực: ' + err.message }); }
});

app.get('/api/procedures', async (_req, res) => {
  try { res.json({ success: true, data: (await getHome()).procedures }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Chi tiết 1 thủ tục (kèm ảnh + file Word/PDF) - chỉ tải khi cần
app.get('/api/procedures/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!fullCache.has(id)) {
      const r = await db.execute({ sql: `SELECT * FROM procedures WHERE id = ?`, args: [id] });
      if (!r.rows.length) return res.status(404).json({ success: false, message: 'Không tìm thấy thủ tục!' });
      fullCache.set(id, r.rows[0]);
      if (fullCache.size > 50) fullCache.delete(fullCache.keys().next().value);
    }
    res.json({ success: true, data: fullCache.get(id) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/procedures', async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return res.json({ success: false, message: 'Vui lòng nhập tên thủ tục!' });
  if (!String(b.video_url || '').trim()) return res.json({ success: false, message: 'Vui lòng nhập Link Video!' });

  const values = {
    sort_order: Math.max(1, parseInt(b.sort_order, 10) || 1),
    title: String(b.title).trim(),
    category: String(b.category == null ? '' : b.category).trim(), // rỗng = chưa phân lĩnh vực
    video_url: formatVideoEmbedUrl(b.video_url),
    image_url: b.image_url || '',
    description: b.description || '',
    document_url: b.document_url || '',
    document_name: b.document_name || '',
    common_errors: b.common_errors || '',
    common_errors_doc_url: b.common_errors_doc_url || '',
    common_errors_doc_name: b.common_errors_doc_name || '',
    steps: b.steps || '',
    contact_info: b.contact_info || '',
    service_url: normalizeServiceUrl(b.service_url),
    tag: ['popular', 'new'].includes(b.tag) ? b.tag : '',
    agency: '', address: '', map_url: '', phone: ''
  };

  try {
    const targetCatId = await categoryIdByName(values.category);
    if (!isSuperAdmin(req)) {
      if (!targetCatId) return deny(res);
      if (b.id) {
        const oldP = await db.execute({sql:`SELECT category FROM procedures WHERE id=?`,args:[Number(b.id)]});
        const oldCatId = oldP.rows.length ? await categoryIdByName(oldP.rows[0].category) : 0;
        if (!oldCatId || !(await permissionFor(req, oldCatId, 'edit'))) return deny(res);
      } else if (!(await permissionFor(req, targetCatId, 'add'))) return deny(res);
    }
    const catInfo = await db.execute({ sql: `SELECT agency, map_url, phone FROM categories WHERE name = ? LIMIT 1`, args: [values.category] });
    if (catInfo.rows.length) {
      values.agency = catInfo.rows[0].agency || '';
      values.map_url = catInfo.rows[0].map_url || '';
      values.phone = catInfo.rows[0].phone || '';
    }
    if (b.id) {
      await db.execute({
        sql: `UPDATE procedures SET sort_order=?, title=?, category=?, video_url=?, image_url=?, description=?, document_url=?, document_name=?, common_errors=?, common_errors_doc_url=?, common_errors_doc_name=?, steps=?, contact_info=?, service_url=?, tag=?, agency=?, address=?, map_url=?, phone=? WHERE id=?`,
        args: [values.sort_order, values.title, values.category, values.video_url, values.image_url, values.description, values.document_url, values.document_name, values.common_errors, values.common_errors_doc_url, values.common_errors_doc_name, values.steps, values.contact_info, values.service_url, values.tag, values.agency, values.address, values.map_url, values.phone, Number(b.id)]
      });
      bust();
      return res.json({ success: true, message: 'Cập nhật thủ tục thành công!' });
    }
    await db.execute({
      sql: `INSERT INTO procedures (sort_order,title,category,video_url,image_url,description,document_url,document_name,common_errors,common_errors_doc_url,common_errors_doc_name,steps,contact_info,service_url,tag,agency,address,map_url,phone,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [values.sort_order, values.title, values.category, values.video_url, values.image_url, values.description, values.document_url, values.document_name, values.common_errors, values.common_errors_doc_url, values.common_errors_doc_name, values.steps, values.contact_info, values.service_url, values.tag, values.agency, values.address, values.map_url, values.phone, new Date().toISOString()]
    });
    bust();
    res.json({ success: true, message: 'Thêm thủ tục mới thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi lưu dữ liệu: ' + err.message }); }
});

app.delete('/api/admin/procedures/:id', async (req, res) => {
  try {
    const id=Number(req.params.id);
    if(!isSuperAdmin(req)){const pr=await db.execute({sql:`SELECT category FROM procedures WHERE id=?`,args:[id]});const cid=pr.rows.length?await categoryIdByName(pr.rows[0].category):0;if(!cid||!(await permissionFor(req,cid,'delete')))return deny(res);}
    await db.execute({ sql: `DELETE FROM procedures WHERE id = ?`, args: [id] });
    bust();
    res.json({ success: true, message: 'Đã xóa thủ tục thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi khi xóa thủ tục!' }); }
});

app.post('/api/admin/procedures/bulk-delete', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.json({ success: false, message: 'Chưa chọn thủ tục để xóa.' });
  try {
    if(!isSuperAdmin(req)){for(const id of ids){const pr=await db.execute({sql:`SELECT category FROM procedures WHERE id=?`,args:[id]});const cid=pr.rows.length?await categoryIdByName(pr.rows[0].category):0;if(!cid||!(await permissionFor(req,cid,'delete')))return deny(res,'Bạn không có quyền xóa một hoặc nhiều thủ tục đã chọn.');}}
    for (const id of ids) await db.execute({ sql: `DELETE FROM procedures WHERE id = ?`, args: [id] });
    bust();
    res.json({ success: true, message: `Đã xóa ${ids.length} thủ tục.` });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi xóa nhanh: ' + err.message }); }
});

// Lưu thứ tự (STT) sau khi kéo-thả hoặc nhập số: ids = danh sách id theo thứ tự mới
app.post('/api/admin/reorder', async (req, res) => {
  const type = req.body?.type;
  const table = type === 'categories' ? 'categories' : type === 'procedures' ? 'procedures' : null;
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isFinite))] : [];
  if (!table || !ids.length) return res.json({ success: false, message: 'Dữ liệu sắp xếp không hợp lệ!' });
  try {
    if(!isSuperAdmin(req)){
      if(table==='categories') return deny(res,'Chỉ quản trị viên hệ thống mới được sắp xếp các mục lớn.');
      const pr=await db.execute({sql:`SELECT category FROM procedures WHERE id=?`,args:[ids[0]]});const cid=pr.rows.length?await categoryIdByName(pr.rows[0].category):0;if(!cid||!(await permissionFor(req,cid,'edit')))return deny(res);
    }
    await db.batch(ids.map((id, i) => ({ sql: `UPDATE ${table} SET sort_order = ? WHERE id = ?`, args: [i + 1, id] })), 'write');
    bust();
    res.json({ success: true, message: 'Đã lưu thứ tự mới!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi lưu thứ tự: ' + err.message }); }
});

app.post('/api/visit', async (req, res) => {
  const visitorId = String(req.body?.visitorId || '').trim().slice(0, 120);
  if (!visitorId) return res.json({ success: false });
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO visitors (visitor_id, first_seen, last_seen, visits) VALUES (?, ?, ?, 1)
            ON CONFLICT(visitor_id) DO UPDATE SET last_seen = excluded.last_seen, visits = visitors.visits + 1`,
      args: [visitorId, now, now]
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const visitor = await db.execute(`SELECT COUNT(*) AS unique_visitors, COALESCE(SUM(visits),0) AS total_visits FROM visitors`);
    const proc = await db.execute(`SELECT COUNT(*) AS total FROM procedures`);
    const cat = await db.execute(`SELECT COUNT(*) AS total FROM categories`);
    res.json({ success: true, data: {
      uniqueVisitors: Number(visitor.rows[0].unique_visitors || 0),
      totalVisits: Number(visitor.rows[0].total_visits || 0),
      procedures: Number(proc.rows[0].total || 0),
      categories: Number(cat.rows[0].total || 0)
    }});
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Vercel: export app. Render/máy tính: vẫn listen như bình thường.
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
