const express = require('express');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('❌ LỖI NGHIÊM TRỌNG: Chưa cấu hình TURSO_DATABASE_URL hoặc TURSO_AUTH_TOKEN!');
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

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
      ['agency', 'TEXT'], ['address', 'TEXT'], ['map_url', 'TEXT'], ['phone', 'TEXT']
    ];
    for (const [name, type] of procedureColumns) await ensureColumn('procedures', name, type);

    const categoryColumns = [['agency','TEXT DEFAULT \'\''], ['map_url','TEXT DEFAULT \'\''], ['phone','TEXT DEFAULT \'\'']];
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
    for (const [sort_order, name, background_color] of defaultCategories) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO categories (sort_order, name, background_image, background_color, description) VALUES (?, ?, '', ?, '')`,
        args: [sort_order, name, background_color]
      });
    }

    const adminCheck = await db.execute(`SELECT username FROM users WHERE username = 'admin'`);
    if (adminCheck.rows.length === 0) {
      await db.execute(`INSERT INTO users VALUES ('admin', '123456', 'admin', 'Quản trị viên')`);
    }
    console.log('🚀 Khởi tạo CSDL thành công!');
  } catch (err) {
    console.error('❌ Lỗi kết nối CSDL:', err.message);
  }
}
initDB();

app.get('/api/settings', async (_req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM settings`);
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json({ success: true, data: settings });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    for (const [key, rawValue] of Object.entries(req.body || {})) {
      const value = rawValue == null ? '' : String(rawValue);
      await db.execute({
        sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [key, value]
      });
    }
    res.json({ success: true, message: 'Lưu cấu hình giao diện thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const result = await db.execute({ sql: `SELECT * FROM users WHERE username = ? AND password = ?`, args: [username, password] });
    if (result.rows.length) {
      const u = result.rows[0];
      return res.json({ success: true, user: { username: u.username, name: u.name, role: u.role } });
    }
    res.json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body || {};
  try {
    const check = await db.execute({ sql: `SELECT username FROM users WHERE username = ? AND password = ?`, args: [username, oldPassword] });
    if (!check.rows.length) return res.json({ success: false, message: 'Mật khẩu cũ không đúng!' });
    await db.execute({ sql: `UPDATE users SET password = ? WHERE username = ?`, args: [newPassword, username] });
    res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/categories', async (_req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM categories ORDER BY sort_order ASC, id ASC`);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/categories', async (req, res) => {
  const { id, sort_order, name, background_image, background_color, description, agency, map_url, phone } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.json({ success: false, message: 'Vui lòng nhập tên lĩnh vực!' });
  const orderNum = Math.max(1, parseInt(sort_order, 10) || 1);
  try {
    if (id) {
      const oldResult = await db.execute({ sql: `SELECT name FROM categories WHERE id = ?`, args: [Number(id)] });
      if (!oldResult.rows.length) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
      const previousName = oldResult.rows[0].name;
      await db.execute({
        sql: `UPDATE categories SET sort_order = ?, name = ?, background_image = ?, background_color = ?, description = ?, agency = ?, map_url = ?, phone = ? WHERE id = ?`,
        args: [orderNum, cleanName, background_image || '', background_color || '#ffffff', description || '', agency || '', map_url || '', phone || '', Number(id)]
      });
      if (previousName !== cleanName) {
        await db.execute({ sql: `UPDATE procedures SET category = ? WHERE category = ?`, args: [cleanName, previousName] });
      }
      await db.execute({
        sql: `UPDATE procedures SET agency = ?, map_url = ?, phone = ?, address = '' WHERE category = ?`,
        args: [agency || '', map_url || '', phone || '', cleanName]
      });
      return res.json({ success: true, message: 'Cập nhật lĩnh vực thành công!' });
    }
    await db.execute({
      sql: `INSERT INTO categories (sort_order, name, background_image, background_color, description, agency, map_url, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderNum, cleanName, background_image || '', background_color || '#ffffff', description || '', agency || '', map_url || '', phone || '']
    });
    res.json({ success: true, message: 'Thêm lĩnh vực mới thành công!' });
  } catch (err) {
    const msg = /unique/i.test(String(err.message)) ? 'Tên lĩnh vực đã tồn tại!' : 'Lỗi lưu lĩnh vực: ' + err.message;
    res.status(500).json({ success: false, message: msg });
  }
});

app.delete('/api/admin/categories/:id', async (req, res) => {
  try {
    const found = await db.execute({ sql: `SELECT name FROM categories WHERE id = ?`, args: [Number(req.params.id)] });
    if (!found.rows.length) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
    const name = found.rows[0].name;
    const used = await db.execute({ sql: `SELECT COUNT(*) AS total FROM procedures WHERE category = ?`, args: [name] });
    if (Number(used.rows[0].total) > 0) return res.json({ success: false, message: 'Lĩnh vực đang có thủ tục. Hãy chuyển hoặc xóa các thủ tục trước.' });
    await db.execute({ sql: `DELETE FROM categories WHERE id = ?`, args: [Number(req.params.id)] });
    res.json({ success: true, message: 'Đã xóa lĩnh vực!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi khi xóa lĩnh vực: ' + err.message }); }
});

app.get('/api/procedures', async (_req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM procedures ORDER BY sort_order ASC, id ASC`);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/procedures', async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return res.json({ success: false, message: 'Vui lòng nhập tên thủ tục!' });
  if (!String(b.video_url || '').trim()) return res.json({ success: false, message: 'Vui lòng nhập Link Video!' });

  const values = {
    sort_order: Math.max(1, parseInt(b.sort_order, 10) || 1),
    title: String(b.title).trim(),
    category: String(b.category || '').trim() || '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ',
    video_url: formatVideoEmbedUrl(b.video_url),
    image_url: b.image_url || '',
    description: b.description || '',
    document_url: b.document_url || '',
    document_name: b.document_name || '',
    common_errors: b.common_errors || '',
    common_errors_doc_url: b.common_errors_doc_url || '',
    common_errors_doc_name: b.common_errors_doc_name || '',
    agency: '', address: '', map_url: '', phone: ''
  };

  try {
    const catInfo = await db.execute({ sql: `SELECT agency, map_url, phone FROM categories WHERE name = ? LIMIT 1`, args: [values.category] });
    if (catInfo.rows.length) {
      values.agency = catInfo.rows[0].agency || '';
      values.map_url = catInfo.rows[0].map_url || '';
      values.phone = catInfo.rows[0].phone || '';
    }
    if (b.id) {
      await db.execute({
        sql: `UPDATE procedures SET sort_order=?, title=?, category=?, video_url=?, image_url=?, description=?, document_url=?, document_name=?, common_errors=?, common_errors_doc_url=?, common_errors_doc_name=?, agency=?, address=?, map_url=?, phone=? WHERE id=?`,
        args: [values.sort_order, values.title, values.category, values.video_url, values.image_url, values.description, values.document_url, values.document_name, values.common_errors, values.common_errors_doc_url, values.common_errors_doc_name, values.agency, values.address, values.map_url, values.phone, Number(b.id)]
      });
      return res.json({ success: true, message: 'Cập nhật thủ tục thành công!' });
    }
    await db.execute({
      sql: `INSERT INTO procedures (sort_order,title,category,video_url,image_url,description,document_url,document_name,common_errors,common_errors_doc_url,common_errors_doc_name,agency,address,map_url,phone,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [values.sort_order, values.title, values.category, values.video_url, values.image_url, values.description, values.document_url, values.document_name, values.common_errors, values.common_errors_doc_url, values.common_errors_doc_name, values.agency, values.address, values.map_url, values.phone, new Date().toISOString()]
    });
    res.json({ success: true, message: 'Thêm thủ tục mới thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi lưu dữ liệu: ' + err.message }); }
});

app.delete('/api/admin/procedures/:id', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM procedures WHERE id = ?`, args: [Number(req.params.id)] });
    res.json({ success: true, message: 'Đã xóa thủ tục thành công!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi khi xóa thủ tục!' }); }
});

app.post('/api/admin/procedures/bulk-delete', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.json({ success: false, message: 'Chưa chọn thủ tục để xóa.' });
  try {
    for (const id of ids) await db.execute({ sql: `DELETE FROM procedures WHERE id = ?`, args: [id] });
    res.json({ success: true, message: `Đã xóa ${ids.length} thủ tục.` });
  } catch (err) { res.status(500).json({ success: false, message: 'Lỗi xóa nhanh: ' + err.message }); }
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
