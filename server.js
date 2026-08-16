const express = require('express');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// Cho phép nhận dữ liệu dung lượng lớn (dành cho ảnh Base64 tải từ máy)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('❌ LỖI NGHIÊM TRỌNG: Chưa cấu hình TURSO_DATABASE_URL hoặc TURSO_AUTH_TOKEN');
    process.exit(1);
}

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

// Tự động khởi tạo và nâng cấp cấu trúc Bảng dữ liệu
async function initDb() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS procedures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                video_url TEXT,
                image_url TEXT,
                description TEXT,
                sort_order INTEGER DEFAULT 0
            )
        `);

        // Tự động bổ sung cột sort_order nếu cơ sở dữ liệu cũ chưa có
        try {
            await db.execute(`ALTER TABLE procedures ADD COLUMN sort_order INTEGER DEFAULT 0;`);
        } catch (e) {
            // Cột đã tồn tại, bỏ qua lỗi
        }

        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `);

        // Khởi tạo tài khoản admin mặc định nếu chưa có
        const adminCheck = await db.execute({
            sql: 'SELECT * FROM users WHERE username = ?',
            args: ['admin']
        });

        if (adminCheck.rows.length === 0) {
            await db.execute({
                sql: 'INSERT INTO users (username, password) VALUES (?, ?)',
                args: ['admin', 'admin123']
            });
            console.log('✅ Đã khởi tạo tài khoản Admin mặc định: admin / admin123');
        }
        console.log('✅ Kết nối và cấu hình Cơ sở dữ liệu Turso thành công!');
    } catch (err) {
        console.error('❌ Lỗi khởi tạo cơ sở dữ liệu:', err);
    }
}
initDb();

// Hàm chuẩn hóa link video (Facebook, Google Drive, YouTube)
function formatVideoEmbedUrl(url) {
    if (!url) return '';
    let cleanUrl = url.trim();

    // Xử lý link Google Drive
    if (cleanUrl.includes('drive.google.com')) {
        const fileIdMatch = cleanUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || cleanUrl.match(/id=([a-zA-Z0-9_-]+)/);
        if (fileIdMatch && fileIdMatch[1]) {
            return `https://drive.google.com/file/d/${fileIdMatch[1]}/preview`;
        }
    }

    // Xử lý link YouTube
    if (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) {
        let videoId = '';
        if (cleanUrl.includes('youtu.be/')) {
            videoId = cleanUrl.split('youtu.be/')[1].split('?')[0];
        } else if (cleanUrl.includes('watch?v=')) {
            videoId = cleanUrl.split('watch?v=')[1].split('&')[0];
        }
        if (videoId) return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
    }

    // Xử lý link Facebook Video
    if (cleanUrl.includes('facebook.com')) {
        return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(cleanUrl)}&show_text=0&autoplay=1`;
    }

    return cleanUrl;
}

// ---------------- API CLIENT ----------------

// Lấy danh sách thủ tục hành chính
app.get('/api/procedures', async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM procedures ORDER BY sort_order ASC, id ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi lấy danh sách thủ tục: ' + err.message });
    }
});

// Đăng nhập Admin
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({
            sql: 'SELECT id, username FROM users WHERE username = ? AND password = ?',
            args: [username, password]
        });

        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi đăng nhập: ' + err.message });
    }
});

// ---------------- API ADMIN ----------------

// Thêm hoặc cập nhật thủ tục
app.post('/api/admin/procedures', async (req, res) => {
    const { id, title, video_url, image_url, description, sort_order } = req.body;

    if (!title) {
        return res.json({ success: false, message: 'Tên thủ tục không được để trống!' });
    }

    const formattedVideoUrl = formatVideoEmbedUrl(video_url);
    const orderValue = parseInt(sort_order) || 0;

    try {
        if (id) {
            // Cập nhật
            await db.execute({
                sql: `UPDATE procedures SET title = ?, video_url = ?, image_url = ?, description = ?, sort_order = ? WHERE id = ?`,
                args: [title, formattedVideoUrl, image_url || '', description || '', orderValue, id]
            });
            res.json({ success: true, message: 'Cập nhật thủ tục thành công!' });
        } else {
            // Thêm mới
            await db.execute({
                sql: `INSERT INTO procedures (title, video_url, image_url, description, sort_order) VALUES (?, ?, ?, ?, ?)`,
                args: [title, formattedVideoUrl, image_url || '', description || '', orderValue]
            });
            res.json({ success: true, message: 'Thêm thủ tục mới thành công!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi lưu dữ liệu: ' + err.message });
    }
});

// Xóa thủ tục
app.delete('/api/admin/procedures/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute({
            sql: 'DELETE FROM procedures WHERE id = ?',
            args: [id]
        });
        res.json({ success: true, message: 'Đã xóa thủ tục thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi xóa thủ tục: ' + err.message });
    }
});

// Đổi mật khẩu Admin
app.post('/api/admin/change-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    try {
        const check = await db.execute({
            sql: 'SELECT * FROM users WHERE username = ? AND password = ?',
            args: [username, oldPassword]
        });

        if (check.rows.length === 0) {
            return res.json({ success: false, message: 'Mật khẩu hiện tại không đúng!' });
        }

        await db.execute({
            sql: 'UPDATE users SET password = ? WHERE username = ?',
            args: [newPassword, username]
        });

        res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi đổi mật khẩu: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại port ${PORT}`);
});
