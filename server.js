/**
 * lan-chat 一体化服务器（零依赖，仅需 Node.js）
 *
 * 功能：
 *   1. 静态文件服务（index.html 等）
 *   2. 数字房间号信令 API（WebRTC offer/answer 自动交换）
 *   3. 客户端 IP 反射 API（用于修复 mDNS 候选混淆问题）
 *
 * 启动：
 *   node server.js          # 默认 1808 端口
 *   node server.js 1808     # 指定端口
 *
 * API 一览：
 *   GET  /api/ping                        服务可用性探测
 *   GET  /api/ip                          返回客户端在服务端视角的局域网 IP
 *   POST /api/room   {room}               创建房间（4位数字，冲突返回 409）
 *   GET  /api/room?room=xxxx              查询房间状态
 *   POST /api/offer  {room, offer}        上传 offer
 *   GET  /api/offer?room=xxxx             拉取 offer（拉取后标记对方已加入）
 *   POST /api/answer {room, answer}       上传 answer
 *   GET  /api/answer?room=xxxx            拉取 answer（含 offerPulled 状态）
 *   POST /api/close  {room}               关闭房间（创建方取消）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.PORT || '1808', 10);
const ROOT = __dirname;
const ROOM_TTL = 10 * 60 * 1000;          // 房间有效期 10 分钟（滚动续期）
const MAX_BODY = 2 * 1024 * 1024;         // 请求体上限 2MB（SDP 约几 KB，留足余量）
const CLEAN_INTERVAL = 30 * 1000;         // 过期清理周期

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.webp': 'image/webp',
};

// ==================== 房间存储 ====================
/** code -> { offer, answer, offerPulled, createdAt, updatedAt } */
const rooms = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (now - room.updatedAt > ROOM_TTL) {
            rooms.delete(code);
            log(`房间 ${code} 已过期清理`);
        }
    }
}, CLEAN_INTERVAL).unref();

// ==================== 工具函数 ====================
function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('请求体过大'), { status: 413 }));
                req.destroy();
                return;
            }
            data += chunk;
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

/** 获取客户端 IP（服务端视角，用于前端修复 mDNS 候选） */
function clientIP(req) {
    let ip = req.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
    return ip;
}

/** 获取服务器自身所有局域网 IPv4 地址（mDNS 修复的兜底方案） */
function serverIPs() {
    const ips = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family === 'IPv4' && !info.internal) {
                ips.push(info.address);
            }
        }
    }
    return ips;
}

function validRoomCode(code) {
    return typeof code === 'string' && /^\d{4}$/.test(code);
}

// ==================== API 处理 ====================
async function handleApi(req, res, pathname, query) {
    const method = req.method.toUpperCase();

    // 服务探测
    if (pathname === '/api/ping' && method === 'GET') {
        return json(res, 200, { ok: true, service: 'lan-chat-signal', ts: Date.now() });
    }

    // 客户端 IP 反射 + 服务器局域网 IP 列表
    if (pathname === '/api/ip' && method === 'GET') {
        return json(res, 200, { ip: clientIP(req), serverIPs: serverIPs() });
    }

    // 创建房间
    if (pathname === '/api/room' && method === 'POST') {
        const body = await readBody(req);
        const code = String(body.room || '');
        if (!validRoomCode(code)) {
            return json(res, 400, { error: '房间号必须为 4 位数字' });
        }
        if (rooms.has(code)) {
            return json(res, 409, { error: '房间号已被占用' });
        }
        rooms.set(code, {
            offer: null, answer: null, offerPulled: false,
            createdAt: Date.now(), updatedAt: Date.now(),
        });
        log(`房间 ${code} 已创建（来自 ${clientIP(req)}）`);
        return json(res, 200, { ok: true, room: code });
    }

    // 查询房间
    if (pathname === '/api/room' && method === 'GET') {
        const code = String(query.room || '');
        if (!validRoomCode(code)) return json(res, 400, { error: '房间号格式错误' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: '房间不存在或已过期' });
        room.updatedAt = Date.now();
        return json(res, 200, {
            ok: true,
            hasOffer: !!room.offer,
            hasAnswer: !!room.answer,
            offerPulled: room.offerPulled,
        });
    }

    // 上传 offer（创建方）
    if (pathname === '/api/offer' && method === 'POST') {
        const body = await readBody(req);
        const code = String(body.room || '');
        if (!validRoomCode(code)) return json(res, 400, { error: '房间号格式错误' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: '房间不存在或已过期' });
        if (typeof body.offer !== 'string' || !body.offer) {
            return json(res, 400, { error: 'offer 内容无效' });
        }
        room.offer = body.offer;
        room.updatedAt = Date.now();
        log(`房间 ${code} 收到 offer（${body.offer.length} 字符）`);
        return json(res, 200, { ok: true });
    }

    // 拉取 offer（加入方）
    if (pathname === '/api/offer' && method === 'GET') {
        const code = String(query.room || '');
        if (!validRoomCode(code)) return json(res, 400, { error: '房间号格式错误' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: '房间不存在或已过期' });
        room.updatedAt = Date.now();
        if (!room.offer) return json(res, 200, { ok: true, waiting: true });
        room.offerPulled = true; // 标记：已有加入方拉取
        log(`房间 ${code} offer 已被拉取`);
        return json(res, 200, { ok: true, offer: room.offer });
    }

    // 上传 answer（加入方）
    if (pathname === '/api/answer' && method === 'POST') {
        const body = await readBody(req);
        const code = String(body.room || '');
        if (!validRoomCode(code)) return json(res, 400, { error: '房间号格式错误' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: '房间不存在或已过期' });
        if (typeof body.answer !== 'string' || !body.answer) {
            return json(res, 400, { error: 'answer 内容无效' });
        }
        // 防止多个加入方互相覆盖：同一房间只接受一份 answer
        if (room.answer) {
            return json(res, 409, { error: '该房间已有加入方，请更换房间号' });
        }
        room.answer = body.answer;
        room.updatedAt = Date.now();
        log(`房间 ${code} 收到 answer（${body.answer.length} 字符）`);
        return json(res, 200, { ok: true });
    }

    // 拉取 answer（创建方轮询）
    if (pathname === '/api/answer' && method === 'GET') {
        const code = String(query.room || '');
        if (!validRoomCode(code)) return json(res, 400, { error: '房间号格式错误' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: '房间不存在或已过期' });
        room.updatedAt = Date.now();
        if (!room.answer) {
            return json(res, 200, { ok: true, waiting: true, offerPulled: room.offerPulled });
        }
        log(`房间 ${code} answer 已被创建方拉取，连接即将建立`);
        return json(res, 200, { ok: true, answer: room.answer, offerPulled: true });
    }

    // 关闭房间（创建方取消）
    if (pathname === '/api/close' && method === 'POST') {
        const body = await readBody(req);
        const code = String(body.room || '');
        if (validRoomCode(code) && rooms.has(code)) {
            rooms.delete(code);
            log(`房间 ${code} 已由创建方关闭`);
        }
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'API 不存在' });
}

// ==================== 静态文件服务 ====================
function serveStatic(req, res, pathname) {
    // 默认首页
    if (pathname === '/') pathname = '/index.html';

    // 路径安全：解码并阻止路径穿越
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        res.writeHead(400); res.end('Bad Request'); return;
    }

    const safePath = path.normalize(decoded).replace(/^([/\\])+/, '');
    const filePath = path.join(ROOT, safePath);

    // 确认最终路径在项目根目录内
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

// ==================== 主服务 ====================
const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams);

    try {
        if (pathname.startsWith('/api/')) {
            await handleApi(req, res, pathname, query);
        } else {
            serveStatic(req, res, pathname);
        }
    } catch (err) {
        const status = err.status || 500;
        json(res, status, { error: err.message || '服务器内部错误' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────┐');
    console.log('  │      局域网匿名聊天室 · 信令服务器          │');
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
    console.log(`  本机访问:   http://localhost:${PORT}`);
    console.log(`  局域网访问: http://<本机IP>:${PORT}`);
    console.log('');
    console.log('  数字房间号模式已启用，双击数字即连。');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n  ❌ 端口 ${PORT} 已被占用。请先停止占用进程，或换端口：node server.js <端口>\n`);
    } else {
        console.error('  服务器错误:', err.message);
    }
    process.exit(1);
});
