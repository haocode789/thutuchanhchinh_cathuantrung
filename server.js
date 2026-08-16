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

// Hàm chuẩn hóa link video
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

// Khởi tạo và tự động vá lỗi cấu trúc Cơ sở dữ liệu Turso
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
                createdAt TEXT
            )
        `);

        // Tự động kiểm tra và bổ sung các cột nếu CSDL cũ bị thiếu
        const columnsToAdd = [
            { name: 'image_url', type: 'TEXT' },
            { name: 'description', type: 'TEXT' },
            { name: 'category', type: 'TEXT DEFAULT "1. LĨNH VỰC QUẢN LÝ CƯ TRÚ"' },
            { name: 'sort_order', type: 'INTEGER DEFAULT 1' }
        ];

        for (const col of columnsToAdd) {
            try {
                await db.execute(`SELECT ${col.name} FROM procedures LIMIT 1`);
            } catch (e) {
                console.log(`⚠️ Đang tự động bổ sung cột ${col.name} vào CSDL...`);
                await db.execute(`ALTER TABLE procedures ADD COLUMN ${col.name} ${col.type}`);
            }
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
        console.log('🚀 Khởi tạo và đồng bộ CSDL thành công!');
    } catch (err) {
        console.error('❌ Lỗi kết nối CSDL:', err.message);
    }
}
initDB();

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

// API Lấy danh sách thủ tục
app.get('/api/procedures', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM procedures ORDER BY sort_order ASC, id DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Thêm / Sửa thủ tục
app.post('/api/admin/procedures', async (req, res) => {
    const { id, sort_order, title, category, video_url, image_url, description } = req.body;
    if (!title || !video_url) {
        return res.json({ success: false, message: 'Vui lòng điền Tên thủ tục và Link Video!' });
    }

    const formattedUrl = formatVideoEmbedUrl(video_url);
    const orderNum = parseInt(sort_order) || 1;

    try {
        if (id) {
            await db.execute({
                sql: `UPDATE procedures SET sort_order = ?, title = ?, category = ?, video_url = ?, image_url = ?, description = ? WHERE id = ?`,
                args: [orderNum, title, category || '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', formattedUrl, image_url || '', description || '', id]
            });
            res.json({ success: true, message: 'Cập nhật thủ tục thành công!' });
        } else {
            await db.execute({
                sql: `INSERT INTO procedures (sort_order, title, category, video_url, image_url, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [orderNum, title, category || '1. LĨNH VỰC QUẢN LÝ CƯ TRÚ', formattedUrl, image_url || '', description || '', new Date().toISOString()]
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