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
  let cleanUrl = url.trim();

  const iframeMatch = cleanUrl.match(/src=["']([^"']+)["']/);
  if (iframeMatch) cleanUrl = iframeMatch[1];

  if (cleanUrl.includes('facebook.com') || cleanUrl.includes('fb.watch')) {
    if (cleanUrl.includes('facebook.com/plugins/video.php')) return cleanUrl;
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(cleanUrl)}&show_text=false&autoplay=false`;
  }

  if (cleanUrl.includes('drive.google.com')) {
    const fileIdMatch = cleanUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (fileIdMatch && fileIdMatch[1]) {
      return `https://drive.google.com/file/d/${fileIdMatch[1]}/preview`;
    }
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
    } catch (e) {
      const match = cleanUrl.match(/v=([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return `https://www.youtube.com/embed/${match[1]}`;
    }
  }

  return cleanUrl;
}

async function initDB() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT,
                role TEXT,
                name TEXT
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS procedures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sort_order INTEGER DEFAULT 1,
                title TEXT NOT NULL,
                category TEXT DEFAULT '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ',
                video_url TEXT NOT NULL,
                image_url TEXT,
                description TEXT,
                document_url TEXT,
                common_errors TEXT,
                createdAt TEXT
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sort_order INTEGER DEFAULT 1,
                name TEXT NOT NULL UNIQUE,
                background_image TEXT,
                background_color TEXT DEFAULT '#ffffff',
                description TEXT DEFAULT ''
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Bổ sung cột cho CSDL cũ nếu thiếu
        const columnsToAdd = [
            { name: 'image_url', type: 'TEXT' },
            { name: 'description', type: 'TEXT' },
            { name: 'category', type: 'TEXT DEFAULT "1. LĨNH VỰC QUẢN LÝ CƯ TRÚ"' },
            { name: 'sort_order', type: 'INTEGER DEFAULT 1' },
            { name: 'document_url', type: 'TEXT' },
            { name: 'common_errors', type: 'TEXT' }
        ];

        for (const col of columnsToAdd) {
            try {
                await db.execute(`SELECT ${col.name} FROM procedures LIMIT 1`);
            } catch (e) {
                await db.execute(`ALTER TABLE procedures ADD COLUMN ${col.name} ${col.type}`);
            }
        }

        // Cấu hình mặc định
        const defaultSettings = [
            { key: 'bg_color', value: '#f0f4f8' },
            { key: 'bg_image', value: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1920&q=80' },
            { key: 'site_logo', value: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/18/C%C3%B4ng_an_Nh%C3%A2n_d%C3%A2n_Vi%E1%BB%87t_Nam.png/220px-C%C3%B4ng_an_Nh%C3%A2n_d%C3%A2n_Vi%E1%BB%87t_Nam.png' },
            { key: 'title_main', value: 'CÔNG AN XÃ THUẦN TRUNG' },
            { key: 'title_sub', value: 'Hỗ trợ thủ tục hành chính' }
        ];

        for (const set of defaultSettings) {
            await db.execute({
                sql: `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
                args: [set.key, set.value]
            });
        }

        // Các lĩnh vực mặc định (chỉ tạo khi chưa có)
        const defaultCategories = [
            { sort_order: 1, name: '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', background_color: '#c8e6c9', description: 'Đăng ký thường trú, tạm trú; xác nhận nơi cư trú,...' },
            { sort_order: 2, name: '2. LĨNH VỰC ĐĂNG KÝ XE', background_color: '#ffccbc', description: 'Đăng ký xe; sang tên; cấp lại đăng ký xe,...' },
            { sort_order: 3, name: '3. LĨNH VỰC CẤP HỘ CHIẾU', background_color: '#bbdefb', description: 'Cấp hộ chiếu phổ thông; tra cứu hồ sơ online' }
        ];

        for (const cat of defaultCategories) {
            await db.execute({
                sql: `INSERT OR IGNORE INTO categories (sort_order, name, background_image, background_color, description) VALUES (?, ?, '', ?, ?)`,
                args: [cat.sort_order, cat.name, cat.background_color, cat.description]
            });
        }

        const adminCheck = await db.execute({
            sql: `SELECT * FROM users WHERE username = 'admin'`,
            args: []
        });

        if (adminCheck.rows.length === 0) {
            await db.execute({
                sql: `INSERT INTO users VALUES ('admin', '123456', 'admin', 'Quản trị viên')`,
                args: []
            });
        }
        console.log('🚀 Khởi tạo CSDL thành công!');
    } catch (err) {
        console.error('❌ Lỗi kết nối CSDL:', err.message);
    }
}
initDB();

// API Lấy cài đặt giao diện
app.get('/api/settings', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM settings`);
        const settings = {};
        result.rows.forEach(r => settings[r.key] = r.value);
        res.json({ success: true, data: settings });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Cập nhật giao diện
app.post('/api/admin/settings', async (req, res) => {
    const settings = req.body;
    try {
        for (const [key, value] of Object.entries(settings)) {
            await db.execute({
                sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
                args: [key, value, value]
            });
        }
        res.json({ success: true, message: 'Lưu cấu hình giao diện thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Đăng nhập
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE username = ? AND password = ?`,
            args: [username, password]
        });

        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({ success: true, user: { username: user.username, name: user.name, role: user.role } });
        } else {
            res.json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Đổi mật khẩu
app.post('/api/admin/change-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    try {
        const check = await db.execute({
            sql: `SELECT * FROM users WHERE username = ? AND password = ?`,
            args: [username, oldPassword]
        });

        if (check.rows.length === 0) {
            return res.json({ success: false, message: 'Mật khẩu cũ không đúng!' });
        }

        await db.execute({
            sql: `UPDATE users SET password = ? WHERE username = ?`,
            args: [newPassword, username]
        });

        res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Lấy danh sách lĩnh vực
app.get('/api/categories', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM categories ORDER BY sort_order ASC, id ASC`);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Thêm / Sửa lĩnh vực
app.post('/api/admin/categories', async (req, res) => {
    const { id, sort_order, name, old_name, background_image, background_color, description } = req.body;
    const cleanName = (name || '').trim();
    if (!cleanName) return res.json({ success: false, message: 'Vui lòng nhập tên lĩnh vực!' });

    const orderNum = parseInt(sort_order) || 1;
    try {
        if (id) {
            const oldResult = await db.execute({ sql: `SELECT name FROM categories WHERE id = ?`, args: [id] });
            if (oldResult.rows.length === 0) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
            const previousName = oldResult.rows[0].name;

            await db.execute({
                sql: `UPDATE categories SET sort_order = ?, name = ?, background_image = ?, background_color = ?, description = ? WHERE id = ?`,
                args: [orderNum, cleanName, background_image || '', background_color || '#ffffff', description || '', id]
            });

            if (previousName !== cleanName) {
                await db.execute({
                    sql: `UPDATE procedures SET category = ? WHERE category = ?`,
                    args: [cleanName, previousName]
                });
            }
            res.json({ success: true, message: 'Cập nhật lĩnh vực thành công!' });
        } else {
            await db.execute({
                sql: `INSERT INTO categories (sort_order, name, background_image, background_color, description) VALUES (?, ?, ?, ?, ?)`,
                args: [orderNum, cleanName, background_image || '', background_color || '#ffffff', description || '']
            });
            res.json({ success: true, message: 'Thêm lĩnh vực mới thành công!' });
        }
    } catch (err) {
        const msg = String(err.message || err).toLowerCase().includes('unique')
            ? 'Tên lĩnh vực đã tồn tại!'
            : 'Lỗi lưu lĩnh vực: ' + err.message;
        res.status(500).json({ success: false, message: msg });
    }
});

// API Xóa lĩnh vực
app.delete('/api/admin/categories/:id', async (req, res) => {
    try {
        const found = await db.execute({ sql: `SELECT name FROM categories WHERE id = ?`, args: [req.params.id] });
        if (found.rows.length === 0) return res.json({ success: false, message: 'Không tìm thấy lĩnh vực!' });
        const name = found.rows[0].name;
        const used = await db.execute({ sql: `SELECT COUNT(*) AS total FROM procedures WHERE category = ?`, args: [name] });
        if (Number(used.rows[0].total) > 0) {
            return res.json({ success: false, message: 'Lĩnh vực này đang có thủ tục. Hãy chuyển hoặc xóa các thủ tục trước.' });
        }
        await db.execute({ sql: `DELETE FROM categories WHERE id = ?`, args: [req.params.id] });
        res.json({ success: true, message: 'Đã xóa lĩnh vực!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi khi xóa lĩnh vực: ' + err.message });
    }
});

// API Lấy danh sách thủ tục
app.get('/api/procedures', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM procedures ORDER BY sort_order ASC, id DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Thêm / Sửa thủ tục (Bổ sung document_url, common_errors)
app.post('/api/admin/procedures', async (req, res) => {
    const { id, sort_order, title, category, video_url, image_url, description, document_url, common_errors } = req.body;
    if (!title || !video_url) {
        return res.json({ success: false, message: 'Vui lòng điền Tên thủ tục và Link Video!' });
    }

    const formattedUrl = formatVideoEmbedUrl(video_url);
    const orderNum = parseInt(sort_order) || 1;

    try {
        if (id) {
            await db.execute({
                sql: `UPDATE procedures SET sort_order = ?, title = ?, category = ?, video_url = ?, image_url = ?, description = ?, document_url = ?, common_errors = ? WHERE id = ?`,
                args: [orderNum, title, category || '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', formattedUrl, image_url || '', description || '', document_url || '', common_errors || '', id]
            });
            res.json({ success: true, message: 'Cập nhật thủ tục thành công!' });
        } else {
            await db.execute({
                sql: `INSERT INTO procedures (sort_order, title, category, video_url, image_url, description, document_url, common_errors, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [orderNum, title, category || '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', formattedUrl, image_url || '', description || '', document_url || '', common_errors || '', new Date().toISOString()]
            });
            res.json({ success: true, message: 'Thêm thủ tục mới thành công!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi lưu dữ liệu: ' + err.message });
    }
});

// API Xóa thủ tục
app.delete('/api/admin/procedures/:id', async (req, res) => {
    try {
        await db.execute({
            sql: `DELETE FROM procedures WHERE id = ?`,
            args: [req.params.id]
        });
        res.json({ success: true, message: 'Đã xóa thủ tục thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi khi xóa thủ tục!' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));