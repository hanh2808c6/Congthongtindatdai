const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const formidable = require('formidable');

// Import mammoth để parse Word files
const mammoth = require('mammoth');

// Load .env file
function loadEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        const envContent = fs.readFileSync(envPath, 'utf8');
        const envVars = {};
        envContent.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) {
                envVars[key.trim()] = value.trim();
            }
        });
        return envVars;
    } catch (err) {
        console.warn('.env file not found, using default API key');
        return {};
    }
}

const env = loadEnv();
const GEMINI_API_KEY = env.GEMINI_API_KEY || 'AIzaSyCsegOOALPLVQj28QxkhxzM7Bp9DTrOjtY';
const PORT = env.PORT || 3000;
const ADMIN_PASSWORD = 'admin@123'; // Thay đổi password này

// Helper để parse Word file
async function parseWordFile(filePath) {
    try {
        const result = await mammoth.extractText({ path: filePath });
        const text = result.value;
        
        // Parse text thành JSON
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length < 2) throw new Error('File Word không có dữ liệu hợp lệ');

        // Header line: ID, Tiêu đề, Loại, Ngày, Cơ quan, Nội dung, PDF URL
        const headers = lines[0].split('\t').map(h => h.toLowerCase().trim());
        const docs = [];

        for (let i = 1; i < lines.length; i++) {
            const cells = lines[i].split('\t');
            if (cells.length < 6) continue; // Bỏ qua hàng không đủ cột

            const doc = {
                id: cells[0]?.trim() || `doc_${i}`,
                title: cells[1]?.trim() || 'Không có tiêu đề',
                type: cells[2]?.trim() || 'Văn bản',
                date: cells[3]?.trim() || '01/01/2024',
                agency: cells[4]?.trim() || 'Chính phủ',
                excerpt: cells[5]?.trim() || '',
                pdfUrl: cells[6]?.trim() || ''
            };

            // Validate date format
            if (!/^\d{2}\/\d{2}\/\d{4}$/.test(doc.date)) {
                doc.date = '01/01/2024';
            }

            docs.push(doc);
        }

        return { success: true, docs: docs, addedCount: docs.length };
    } catch (error) {
        console.error('Word parse error:', error);
        return { success: false, error: error.message };
    }
}

// Helper để gọi Gemini API từ backend (an toàn hơn)
function callGeminiAPI(prompt, isChat = false, chatHistory = []) {
    return new Promise((resolve) => {
        const model = isChat ? 'gemini-2.5-flash' : 'gemini-1.5-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        
        let body;
        if (isChat) {
            body = {
                contents: chatHistory,
                systemInstruction: { parts: [{ text: prompt }] }
            };
        } else {
            body = {
                contents: [{ role: "user", parts: [{ text: prompt }] }]
            };
        }

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(body))
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "Không thể xử lý yêu cầu.";
                    resolve({ success: true, text: text });
                } catch (err) {
                    console.error('Parse error:', err);
                    resolve({ success: false, error: 'Lỗi parse response' });
                }
            });
        });

        req.on('error', (error) => {
            console.error('API error:', error);
            resolve({ success: false, error: error.message });
        });

        req.write(JSON.stringify(body));
        req.end();
    });
}

// Helper để parse request body
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(err);
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Xử lý API requests
    if (req.url === '/api/gemini-chat' && req.method === 'POST') {
        try {
            const reqData = await parseRequestBody(req);
            const { messages = [], systemPrompt } = reqData;
            
            const result = await callGeminiAPI(systemPrompt, true, messages);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    if (req.url === '/api/gemini-summarize' && req.method === 'POST') {
        try {
            const reqData = await parseRequestBody(req);
            const { prompt } = reqData;
            
            const result = await callGeminiAPI(prompt, false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // Admin upload endpoint
    if (req.url === '/admin/upload' && req.method === 'POST') {
        const form = new formidable.IncomingForm({
            uploadDir: path.join(__dirname, 'temp'),
            keepExtensions: true
        });

        if (!fs.existsSync(form.uploadDir)) {
            fs.mkdirSync(form.uploadDir, { recursive: true });
        }

        form.parse(req, async (err, fields, files) => {
            try {
                const password = Array.isArray(fields.password) ? fields.password[0] : fields.password;
                
                if (password !== ADMIN_PASSWORD) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Mật khẩu không đúng' }));
                    return;
                }

                const file = Array.isArray(files.file) ? files.file[0] : files.file;
                if (!file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Không có file' }));
                    return;
                }

                // Parse Word file
                const parseResult = await parseWordFile(file.filepath);
                
                if (!parseResult.success) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(parseResult));
                    fs.unlinkSync(file.filepath);
                    return;
                }

                // Save to JSON file
                const jsonPath = path.join(__dirname, 'GEMINI', 'van_ban_phap_luat_dat_dai.json');
                fs.writeFileSync(jsonPath, JSON.stringify(parseResult.docs, null, 2));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    addedCount: parseResult.docs.length
                }));

                // Cleanup
                fs.unlinkSync(file.filepath);
            } catch (error) {
                console.error('Upload error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }

    // Admin delete endpoint
    if (req.url === '/admin/delete' && req.method === 'POST') {
        try {
            const reqData = await parseRequestBody(req);
            const { id, password } = reqData;

            if (password !== ADMIN_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Mật khẩu không đúng' }));
                return;
            }

            // Load JSON
            const jsonPath = path.join(__dirname, 'GEMINI', 'van_ban_phap_luat_dat_dai.json');
            let docs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

            // Filter out deleted document
            docs = docs.filter(doc => doc.id !== id);

            // Save updated JSON
            fs.writeFileSync(jsonPath, JSON.stringify(docs, null, 2));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (error) {
            console.error('Delete error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // API: List PDF/Word files
    if (req.url === '/api/list-files' && req.method === 'GET') {
        try {
            const geminiDir = path.join(__dirname, 'GEMINI');
            const files = fs.readdirSync(geminiDir);
            
            // Filter only PDF and Word files
            const docFiles = files.filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ext === '.pdf' || ext === '.docx' || ext === '.doc';
            });

            // Get file info
            const fileList = docFiles.map(f => {
                const filePath = path.join(geminiDir, f);
                const stats = fs.statSync(filePath);
                return {
                    name: f,
                    size: (stats.size / 1024).toFixed(2), // KB
                    uploaded: new Date(stats.mtime).toLocaleString('vi-VN')
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files: fileList }));
        } catch (error) {
            console.error('List files error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // Admin: Add new document with file
    if (req.url === '/admin/add-doc' && req.method === 'POST') {
        const form = new formidable.IncomingForm({
            uploadDir: path.join(__dirname, 'GEMINI'),
            keepExtensions: true
        });

        form.parse(req, async (err, fields, files) => {
            try {
                const password = Array.isArray(fields.password) ? fields.password[0] : fields.password;
                
                if (password !== ADMIN_PASSWORD) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Mật khẩu không đúng' }));
                    return;
                }

                // Get metadata from form
                const docId = (Array.isArray(fields.docId) ? fields.docId[0] : fields.docId || '').trim();
                const docTitle = (Array.isArray(fields.docTitle) ? fields.docTitle[0] : fields.docTitle || '').trim();
                const docType = (Array.isArray(fields.docType) ? fields.docType[0] : fields.docType || '').trim();
                const docDate = (Array.isArray(fields.docDate) ? fields.docDate[0] : fields.docDate || '').trim();
                const docAgency = (Array.isArray(fields.docAgency) ? fields.docAgency[0] : fields.docAgency || '').trim();
                const docExcerpt = (Array.isArray(fields.docExcerpt) ? fields.docExcerpt[0] : fields.docExcerpt || '').trim();

                // Validate required fields
                if (!docId || !docTitle || !docType || !docDate || !docAgency) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Thiếu thông tin bắt buộc' }));
                    return;
                }

                const file = Array.isArray(files.file) ? files.file[0] : files.file;
                if (!file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Không có file' }));
                    return;
                }

                // Load existing JSON
                const jsonPath = path.join(__dirname, 'GEMINI', 'van_ban_phap_luat_dat_dai.json');
                let docs = [];
                if (fs.existsSync(jsonPath)) {
                    docs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                }

                // Check if ID already exists
                if (docs.find(d => d.id === docId)) {
                    fs.unlinkSync(file.filepath);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'ID văn bản đã tồn tại!' }));
                    return;
                }

                // Rename file with docId
                const ext = path.extname(file.originalFilename);
                const newFilename = `${docId}${ext}`;
                const newPath = path.join(__dirname, 'GEMINI', newFilename);

                // Move file
                fs.renameSync(file.filepath, newPath);

                // Create new document object
                const newDoc = {
                    id: docId,
                    title: docTitle,
                    type: docType,
                    date: docDate,
                    agency: docAgency,
                    excerpt: docExcerpt,
                    pdfUrl: newFilename,
                    content: ''
                };

                // Add to documents array
                docs.push(newDoc);

                // Save updated JSON
                fs.writeFileSync(jsonPath, JSON.stringify(docs, null, 2));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Lưu thành công',
                    docId: docId,
                    filename: newFilename
                }));
            } catch (error) {
                console.error('Add doc error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }
    if (req.url === '/admin/upload-pdf' && req.method === 'POST') {
        const form = new formidable.IncomingForm({
            uploadDir: path.join(__dirname, 'GEMINI'),
            keepExtensions: true
        });

        form.parse(req, async (err, fields, files) => {
            try {
                const password = Array.isArray(fields.password) ? fields.password[0] : fields.password;
                
                if (password !== ADMIN_PASSWORD) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Mật khẩu không đúng' }));
                    return;
                }

                const file = Array.isArray(files.file) ? files.file[0] : files.file;
                if (!file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Không có file' }));
                    return;
                }

                // Keep original filename, just move to GEMINI folder
                const filename = file.originalFilename;
                const oldPath = file.filepath;
                const newPath = path.join(__dirname, 'GEMINI', filename);

                // Check if file already exists
                if (fs.existsSync(newPath)) {
                    fs.unlinkSync(oldPath);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'File đã tồn tại! Đổi tên file hoặc xóa file cũ.' }));
                    return;
                }

                // Move file to GEMINI folder
                fs.renameSync(oldPath, newPath);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    filename: filename,
                    size: (file.size / 1024).toFixed(2)
                }));
            } catch (error) {
                console.error('Upload PDF error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }

    // Admin delete file endpoint
    if (req.url === '/admin/delete-file' && req.method === 'POST') {
        try {
            const reqData = await parseRequestBody(req);
            const { filename, password } = reqData;

            if (password !== ADMIN_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Mật khẩu không đúng' }));
                return;
            }

            const filePath = path.join(__dirname, 'GEMINI', filename);
            
            // Security: prevent path traversal attacks
            if (!filePath.startsWith(path.join(__dirname, 'GEMINI'))) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid filename' }));
                return;
            }

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'File not found' }));
            }
        } catch (error) {
            console.error('Delete file error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // Serve static files
    let urlPath = req.url.startsWith('/GEMINI/') ? req.url.substring(8) : req.url;
    if (urlPath === '' || urlPath === '/') urlPath = 'index.html';
    let filePath = path.join(__dirname, 'GEMINI', urlPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(path.join(__dirname, 'GEMINI'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    let contentType = 'text/html';
    switch (ext) {
        case '.css': contentType = 'text/css'; break;
        case '.js': contentType = 'text/javascript'; break;
        case '.json': contentType = 'application/json'; break;
        case '.avif': contentType = 'image/avif'; break;
        case '.pdf': contentType = 'application/pdf'; break;
        case '.docx': contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; break;
        case '.doc': contentType = 'application/msword'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': case '.jpeg': contentType = 'image/jpeg'; break;
        case '.webp': contentType = 'image/webp'; break;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('API endpoints ready: /api/gemini-chat, /api/gemini-summarize');
});
