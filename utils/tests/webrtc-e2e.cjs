/**
 * lan-chat 端到端自动化测试 v2（修复标签页绑定问题）
 * 使用 Chrome DevTools Protocol (CDP) 驱动 Edge headless
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** 浏览器探测：环境变量优先，其次常见安装路径（Windows / Linux / macOS） */
function findBrowser() {
    if (process.env.LANCHAT_BROWSER) {
        if (fs.existsSync(process.env.LANCHAT_BROWSER)) return process.env.LANCHAT_BROWSER;
        throw new Error('LANCHAT_BROWSER 指向的浏览器不存在: ' + process.env.LANCHAT_BROWSER);
    }
    const candidates = {
        win32: [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        ],
        linux: [
            '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium', '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge',
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ],
    }[process.platform] || [];
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
    }
    for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge', 'chrome']) {
        try {
            const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
            const p = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
            if (p && fs.existsSync(p)) return p;
        } catch { /* 继续探测 */ }
    }
    throw new Error('未找到可用浏览器（Chrome/Edge），请设置环境变量 LANCHAT_BROWSER 指向浏览器可执行文件');
}

// 全局 WebSocket 自 Node.js 21 起默认可用；Node 20 无此全局对象（CI 使用 Node 22）
if (typeof WebSocket === 'undefined') {
    console.error(`致命错误: 当前 Node.js（${process.version}）不提供全局 WebSocket，请改用 Node.js 21+ 运行。`);
    process.exit(1);
}

const EDGE = findBrowser();
const PORT = 9333;
const BASE_PORT = 1808;
const TARGET_URL = `http://127.0.0.1:${BASE_PORT}/index.html`;

let edgeProc = null;
let serverProc = null;

/** 跨平台进程清理（Windows: taskkill；POSIX: 杀进程组） */
function killProc(proc) {
    if (!proc) return;
    try {
        if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else process.kill(-proc.pid, 'SIGKILL');
    } catch { /* 已退出则忽略 */ }
}

/** 信令服务器探测 / 自动拉起 */
function pingServer() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${BASE_PORT}/api/ping`, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
}
async function ensureServer() {
    if (await pingServer()) return { started: false };
    const proc = spawn(process.execPath, ['server.js', String(BASE_PORT)], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
        await sleep(300);
        if (await pingServer()) return { started: true, proc };
    }
    killProc(proc);
    throw new Error('信令服务器启动失败');
}

class CDP {
    constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.jsErrors = []; }
    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('WS连接失败'));
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.method === 'Runtime.exceptionThrown') {
                    this.jsErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
                }
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            };
        });
    }
    send(method, params = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const id = ++this.id;
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP 命令超时（${timeoutMs}ms）: ${method}`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
            return { __error: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
        }
        return result.result?.value;
    }
    close() { if (this.ws) this.ws.close(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTargets() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

// 打开新标签页，直接使用 /json/new 返回值绑定 —— 避免列表查询的不确定性
async function openTab(url) {
    const resp = await new Promise((res, rej) => {
        http.get(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });
    await sleep(2500); // 等待页面完全加载
    return resp; // 包含 webSocketDebuggerUrl
}

async function main() {
    const results = [];
    const log = (name, pass, detail) => {
        results.push({ name, pass, detail });
        console.log(`[${pass ? '✅ PASS' : '❌ FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    console.log('准备信令服务器...');
    const srv = await ensureServer();
    serverProc = srv.proc || null;
    console.log(srv.started ? `已自动启动服务器（端口 ${BASE_PORT}）` : `复用已运行的服务器（端口 ${BASE_PORT}）`);

    console.log('启动浏览器 headless...');
    const profileDir = path.join(os.tmpdir(), 'lanchat-e2e-v2-' + Date.now());
    const browserArgs = [
        '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + profileDir, '--disable-gpu'
    ];
    if (process.platform === 'linux') browserArgs.unshift('--no-sandbox', '--disable-dev-shm-usage');
    const edge = spawn(EDGE, browserArgs, { stdio: 'ignore', detached: true });
    edgeProc = edge;

    let targets = null;
    for (let i = 0; i < 20; i++) { await sleep(500); try { targets = await getTargets(); if (targets?.length) break; } catch (e) {} }
    console.log('CDP 就绪');

    // 打开两个标签页 —— 使用 /json/new 的返回值精确绑定 WS
    const tabA = await openTab(TARGET_URL);
    const tabB = await openTab(TARGET_URL);
    console.log('tabA ws:', tabA.webSocketDebuggerUrl ? 'OK' : 'MISSING', '| tabB ws:', tabB.webSocketDebuggerUrl ? 'OK' : 'MISSING');

    const pageA = new CDP(tabA.webSocketDebuggerUrl);
    const pageB = new CDP(tabB.webSocketDebuggerUrl);
    await pageA.connect(); await pageB.connect();
    await pageA.send('Runtime.enable'); await pageB.send('Runtime.enable');

    // 自检：在每个页面打标记，确认两个页面独立
    await pageA.eval('window.__TAB_TAG = "A"');
    await pageB.eval('window.__TAB_TAG = "B"');
    const tagA = await pageA.eval('window.__TAB_TAG');
    const tagB = await pageB.eval('window.__TAB_TAG');
    log('标签页独立自检', tagA === 'A' && tagB === 'B', `A=${tagA}, B=${tagB}`);
    if (tagA !== 'A' || tagB !== 'B') { console.log('标签页绑定错误，终止'); process.exit(1); }

    try {
        // ========== 测试 1: 基础加载 ==========
        const titleA = await pageA.eval('document.title');
        log('页面加载（标题）', titleA === '局域网匿名聊天室', `title="${titleA}"`);

        // ========== 测试 2: A 创建连接生成 Offer ==========
        await pageA.eval('document.getElementById("create-btn").click()');
        await sleep(6500); // 等 ICE gathering（含5s超时兜底）

        const modeA = await pageA.eval('state.mode');
        log('A 进入 create 模式', modeA === 'create', `mode=${modeA}`);

        const sdpA = await pageA.eval('document.getElementById("sdp-text").value');
        const sdpAValid = sdpA && sdpA.includes('"offer"');
        log('A 生成 Offer SDP', !!sdpAValid, sdpA ? `长度=${sdpA.length}` : '空');
        if (!sdpAValid) throw new Error('Offer 生成失败');
        console.log('  [SDP候选行]', (sdpA.match(/a=candidate:[^"\\]{0,120}/g) || ['无']).join('\n  '));

        // ========== 测试 3: B 加入并提交 Offer 生成 Answer ==========
        await pageB.eval('document.getElementById("join-btn").click()');
        await sleep(500);
        const modeB = await pageB.eval('state.mode');
        log('B 进入 join 模式', modeB === 'join', `mode=${modeB}`);

        await pageB.eval(`document.getElementById("sdp-input-text").value = ${JSON.stringify(sdpA)}`);
        await pageB.eval('document.getElementById("submit-sdp-btn").click()');
        await sleep(6500);

        const sdpB = await pageB.eval('document.getElementById("sdp-text").value');
        const sdpBValid = sdpB && sdpB.includes('"answer"');
        log('B 生成 Answer SDP', !!sdpBValid, sdpB ? `长度=${sdpB.length}` : '空');
        if (!sdpBValid) throw new Error('Answer 生成失败');
        console.log('  [SDP候选行]', (sdpB.match(/a=candidate:[^"\\]{0,120}/g) || ['无']).join('\n  '));

        const sigB = await pageB.eval('state.peerConnection.signalingState');
        log('B signalingState', sigB === 'stable', `state=${sigB}`);

        // ========== 测试 4: A 提交 Answer，建立连接 ==========
        await pageA.eval(`document.getElementById("sdp-input-text").value = ${JSON.stringify(sdpB)}`);
        await pageA.eval('document.getElementById("submit-sdp-btn").click()');

        let connA = '', connB = '', dcA = '', dcB = '';
        for (let i = 0; i < 20; i++) {
            await sleep(1000);
            connA = await pageA.eval('state.peerConnection ? state.peerConnection.connectionState : "none"');
            connB = await pageB.eval('state.peerConnection ? state.peerConnection.connectionState : "none"');
            dcA = await pageA.eval('state.dataChannel ? state.dataChannel.readyState : "none"');
            dcB = await pageB.eval('state.dataChannel ? state.dataChannel.readyState : "none"');
            if (connA === 'connected' && connB === 'connected' && dcA === 'open' && dcB === 'open') break;
        }
        log('A 连接状态 connected', connA === 'connected', `connState=${connA}`);
        log('B 连接状态 connected', connB === 'connected', `connState=${connB}`);
        log('A DataChannel open', dcA === 'open', `readyState=${dcA}`);
        log('B DataChannel open', dcB === 'open', `readyState=${dcB}`);

        // ========== 测试 5: 消息收发 ==========
        if (dcA === 'open' && dcB === 'open') {
            await pageA.eval('document.getElementById("message-input").value = "你好，我是A"');
            await pageA.eval('document.getElementById("send-btn").click()');
            await sleep(1500);

            const recvB = await pageB.eval('(elements.messages.querySelector(".message.received .message-text") || {}).textContent || ""');
            log('B 收到 A 的消息', recvB.includes('你好'), `内容="${recvB}"`);

            await pageB.eval('document.getElementById("message-input").value = "收到，我是B"');
            await pageB.eval('document.getElementById("send-btn").click()');
            await sleep(1500);

            const recvA = await pageA.eval('(elements.messages.querySelector(".message.received .message-text") || {}).textContent || ""');
            log('A 收到 B 的回复', recvA.includes('收到'), `内容="${recvA}"`);

            // ========== 测试 6: 阅后即焚 ==========
            await pageB.eval('document.getElementById("burn-toggle").click()');
            await pageB.eval('document.getElementById("message-input").value = "这条消息会消失"');
            await pageB.eval('document.getElementById("send-btn").click()');
            await sleep(1200);

            const burnCountA = await pageA.eval('elements.messages.querySelectorAll(".message.burn-message").length');
            log('A 收到阅后即焚消息', burnCountA >= 1, `数量=${burnCountA}`);

            await sleep(8500); // 等待焚毁：5s 倒计时 + 最长 1.5s 兜底移除（留 ~2s 余量，避免边界抖动）
            const burnAfterA = await pageA.eval('elements.messages.querySelectorAll(".message.burn-message").length');
            log('阅后即焚消息自动消失', burnAfterA === 0, `剩余=${burnAfterA}`);

            // ========== 测试 7: 文件传输 ==========
            // 用 DataChannel 直接发一个模拟文件（走 sendFile 逻辑）
            const fileTestResult = await pageA.eval(`
                (async () => {
                    try {
                        const content = 'Hello lan-chat file transfer ' + Date.now();
                        const file = new File([content], 'e2e-test.txt', { type: 'text/plain' });
                        await sendFile(file);
                        return 'sent:' + content.length;
                    } catch (e) { return 'error:' + e.message; }
                })()
            `);
            log('A 发送文件（sendFile）', String(fileTestResult).startsWith('sent:'), String(fileTestResult));

            await sleep(3000); // 等待分片传输完成
            const fileRecvB = await pageB.eval(`
                (() => {
                    const btns = Array.from(elements.messages.querySelectorAll('.file-download-btn, .file-message button, .download-btn'));
                    return btns.length > 0 ? 'has-download-btn(' + btns.length + ')' : 'no-btn';
                })()
            `);
            const fileRecvMsgB = await pageB.eval(`
                Array.from(elements.messages.querySelectorAll('.system-message')).map(e => e.textContent).filter(t => t.includes('文件')).join(' | ')
            `);
            log('B 收到文件', String(fileRecvB).includes('has-download-btn') || String(fileRecvMsgB).includes('接收完成'), `按钮=${fileRecvB}, 消息=${fileRecvMsgB}`);

            // ========== 测试 8: 断线检测 ==========
            // 关闭 B 标签页
            await pageB.send('Page.close').catch(() => {});
            await sleep(6000);

            const disconnectShown = await pageA.eval(`
                Array.from(elements.messages.querySelectorAll(".system-message"))
                    .some(el => el.textContent.includes("断开") || el.textContent.includes("关闭"))
            `);
            log('A 检测到对方断开', disconnectShown === true);

            const inputDisabled = await pageA.eval('document.getElementById("message-input").disabled');
            log('断线后输入禁用', inputDisabled === true, `disabled=${inputDisabled}`);
        }

    } catch (err) {
        console.log('❌ 测试中断:', err.message);
    }

    // ========== 汇总 ==========
    console.log('\n========== 测试汇总 ==========');
    const passed = results.filter(r => r.pass).length;
    console.log(`通过: ${passed}/${results.length}`);
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail || ''}`));

    if (pageA.jsErrors.length) console.log('\n页面A JS错误:\n' + pageA.jsErrors.join('\n'));
    if (pageB.jsErrors.length) console.log('\n页面B JS错误:\n' + pageB.jsErrors.join('\n'));

    pageA.close();
    try { pageB.close(); } catch (e) {}
    killProc(edgeProc);
    killProc(serverProc);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
    console.error('致命错误:', e);
    killProc(edgeProc);
    killProc(serverProc);
    process.exit(1);
});
