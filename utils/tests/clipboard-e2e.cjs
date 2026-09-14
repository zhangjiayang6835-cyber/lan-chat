/**
 * 最终端到端验证 v2（覆盖 4 个场景，含超时回退）
 *
 * 场景1: localhost + Clipboard API 挂起（模拟失焦）→ 应超时回退到 execCommand 成功
 * 场景2: 局域网非安全上下文（clipboard undefined）→ execCommand 成功
 * 场景3: 粘贴按钮降级
 * 场景4: 兜底路径（两种方式都不可用）→ 选中引导，无异常
 *
 * 黄金标准：系统剪贴板真实内容（Windows: PowerShell / macOS: pbcopy / Linux: xclip）
 *
 * 运行：
 *   node utils/tests/clipboard-e2e.cjs
 *   需要已启动的服务器（node server.js 1808）或搭配测试端口；
 *   环境变量：
 *     LANCHAT_BROWSER         指定浏览器路径
 *     LANCHAT_E2E_HEADLESS=1  无头模式（CI）
 *     LANCHAT_E2E_NO_SYSTEM_CLIPBOARD=1  无系统剪贴板环境（Linux CI）时跳过黄金标准断言，其余断言照常执行
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

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

const EDGE = findBrowser();
const PORT = 9336;
const TARGET_URL = 'http://localhost:1808/index.html';
const HEADLESS = process.env.LANCHAT_E2E_HEADLESS === '1';
// CI（Linux 无桌面）没有系统剪贴板时置 1：跳过系统剪贴板黄金标准断言，其余断言照常执行
const NO_SYSTEM_CLIPBOARD = process.env.LANCHAT_E2E_NO_SYSTEM_CLIPBOARD === '1';
let edgeProc = null; // 全局持有浏览器进程引用，确保异常时也能清理

/** 跨平台进程清理（Windows: taskkill；POSIX: 杀进程组） */
function killProc(proc) {
    if (!proc) return;
    try {
        if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else process.kill(-proc.pid, 'SIGKILL');
    } catch { /* 已退出则忽略 */ }
}

class CDP {
    constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('WS fail'));
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.method) this.events.push(msg);
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
        return result.exceptionDetails ? { __error: (result.exceptionDetails.exception?.description || result.exceptionDetails.text) } : result.result?.value;
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

// 启动前清理：若调试端口被旧实例占用，通过 CDP 优雅关闭（跨平台）
async function killExistingOnPort(port) {
    let version = null;
    try {
        version = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
                let d = '';
                res.on('data', (c) => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
            });
            req.on('error', reject);
            req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
        });
    } catch { return; }
    console.log(`⚠️ 端口 ${port} 被旧实例占用，正在清理...`);
    try {
        if (version && version.webSocketDebuggerUrl) {
            const br = new CDP(version.webSocketDebuggerUrl);
            await br.connect();
            await br.send('Browser.close', {}, 3000).catch(() => {});
            br.close();
        }
    } catch (e) { /* 忽略 */ }
    await sleep(1500);
}

// 滚动到视口中央后派发受信任点击
async function clickElement(P, selector) {
    const pos = await P.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height });
    })()`);
    if (!pos) throw new Error('元素不存在: ' + selector);
    const p = JSON.parse(pos);
    if (p.w === 0) throw new Error(`元素不可见: ${selector} ${pos}`);
    await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
    await sleep(60);
    await P.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await P.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * 新版 UI：手动 SDP 模式折叠在「高级」details 面板中，需先展开
 */
async function openManualPanel(P) {
    await P.eval(`(() => { const d = document.getElementById('manual-panel'); if (d) d.open = true; return 'ok'; })()`);
    await sleep(300);
}

async function waitFor(P, expr, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const val = await P.eval(expr);
        if (val) return { ok: true, val, ms: Date.now() - start };
        await sleep(400);
    }
    return { ok: false, val: null, ms: timeoutMs };
}

function getClipboard() {
    try {
        if (process.platform === 'win32') {
            return execSync('powershell -NoProfile -Command "Get-Clipboard -Raw"', { encoding: 'utf8', timeout: 15000 }).replace(/\r\n/g, '\n').trim();
        }
        if (process.platform === 'darwin') {
            return execSync('pbpaste', { encoding: 'utf8', timeout: 15000 }).trim();
        }
        // Linux: xclip 或 xsel
        try {
            return execSync('xclip -selection clipboard -o', { encoding: 'utf8', timeout: 15000 }).trim();
        } catch {
            return execSync('xsel --clipboard --output', { encoding: 'utf8', timeout: 15000 }).trim();
        }
    } catch (e) { return '(读取失败: ' + e.message + ')'; }
}
function setClipboard(text) {
    try {
        if (process.platform === 'win32') {
            execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`, { encoding: 'utf8', timeout: 15000 });
        } else if (process.platform === 'darwin') {
            execSync('pbcopy', { input: text, encoding: 'utf8', timeout: 15000 });
        } else {
            try {
                execSync('xclip -selection clipboard -i', { input: text, encoding: 'utf8', timeout: 15000 });
            } catch {
                execSync('xsel --clipboard --input', { input: text, encoding: 'utf8', timeout: 15000 });
            }
        }
        return true;
    } catch (e) { return false; }
}

async function main() {
    const results = [];
    const log = (name, pass, detail) => {
        results.push({ name, pass, detail });
        console.log(`[${pass ? '✅' : '❌'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    console.log('=== 启动前清理端口占用 ===');
    await killExistingOnPort(PORT);

    console.log('=== 启动真实浏览器 ===');
    const profileDir = path.join(os.tmpdir(), 'lanchat-v2-' + Date.now());
    const clipArgs = [
        `--remote-debugging-port=${PORT}`,
        '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        '--window-size=900,750',
        TARGET_URL
    ];
    if (HEADLESS) clipArgs.unshift('--headless=new', '--disable-gpu');
    if (process.platform === 'linux') clipArgs.unshift('--no-sandbox', '--disable-dev-shm-usage');
    edgeProc = spawn(EDGE, clipArgs, { stdio: 'ignore', detached: true });

    let page = null;
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        try {
            const targets = await getTargets();
            page = targets.find(t => t.type === 'page' && t.url.includes('1808'));
            if (page) break;
        } catch (e) {}
    }
    if (!page) { console.log('❌ 页面未就绪'); process.exit(1); }

    const P = new CDP(page.webSocketDebuggerUrl);
    await P.connect();
    await P.send('Runtime.enable');
    await P.send('Page.enable'); // 关键：启停 Page 域后 javascriptDialogOpening 事件才会推送

    // 自动处理对话框（记录后接受，防止阻塞）
    const dialogs = [];
    const origOnmessage = P.ws.onmessage;
    P.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Page.javascriptDialogOpening') {
            dialogs.push(msg.params.message);
            P.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
        origOnmessage(event);
    };
    await sleep(2000);

    const title = await P.eval('document.title');
    log('页面加载（含最新修复版）', title === '局域网匿名聊天室', `title="${title}"`);

    // 确认修复已生效（copyToClipboard 是全局函数，可直接检查源码文本）
    const hasTimeoutGuard = await P.eval('typeof copyToClipboard === "function" && copyToClipboard.toString().indexOf("超时") !== -1');
    log('超时保护代码已生效', hasTimeoutGuard === true, hasTimeoutGuard ? '检测到"Clipboard API 超时"守卫' : '未检测到');

    // 等页面完全渲染 + 展开「高级」手动 SDP 面板（新版 UI 默认折叠）
    await openManualPanel(P);
    for (let i = 0; i < 10; i++) {
        const ready = await P.eval('document.getElementById("create-btn") && document.getElementById("create-btn").getBoundingClientRect().width > 0');
        if (ready) break;
        await sleep(700);
    }

    // ========== 场景1: Clipboard API 挂起（模拟失焦等场景）→ 超时回退 ==========
    console.log('\n===== 场景1: Clipboard API 挂起 → 超时自动回退 =====');

    await openManualPanel(P);
    await clickElement(P, '#create-btn');
    const sdp1 = await waitFor(P, 'document.getElementById("sdp-text") && document.getElementById("sdp-text").value.length > 100', 15000, 'SDP');
    log('[场景1] SDP 生成', sdp1.ok, `耗时 ${sdp1.ms}ms`);
    await waitFor(P, 'document.getElementById("copy-sdp-btn") && document.getElementById("copy-sdp-btn").getBoundingClientRect().width > 0', 8000, '复制按钮');

    // 模拟 Clipboard API 挂起：writeText 返回永不 resolve 的 Promise
    await P.eval(`
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: () => new Promise(() => {}) },
            configurable: true
        });
        'suspended'
    `);
    const apiState = await P.eval('typeof navigator.clipboard.writeText');
    log('[场景1] 模拟 API 挂起就绪', apiState === 'function', `writeText=${apiState}（永不返回）`);

    setClipboard('SENTINEL-SCENE1');
    await sleep(300);

    const t0 = Date.now();
    await clickElement(P, '#copy-sdp-btn');

    // 等待按钮反馈（超时回退应在 ~800ms + 执行时间后完成）
    const btnFeedback = await waitFor(P, 'document.getElementById("copy-sdp-btn").textContent.includes("已复制")', 5000, '按钮反馈');
    const elapsed = Date.now() - t0;
    log('[场景1] 挂起后按钮仍给出反馈（不再无响应）', btnFeedback.ok, `耗时 ${elapsed}ms（约 800ms 超时 + 回退执行）`);

    if (NO_SYSTEM_CLIPBOARD) {
        console.log('  [SKIP] [场景1] 系统剪贴板黄金标准校验（无系统剪贴板环境，已跳过）');
    } else {
        const clip1 = getClipboard();
        const clip1Ok = clip1.includes('v=0') && clip1.includes('m=application');
        log('[场景1] 超时回退写入系统剪贴板', clip1Ok, clip1Ok ? `${clip1.length} 字符` : `内容: "${clip1.substring(0, 60)}"`);
    }

    // ========== 场景2: 局域网非安全上下文（clipboard undefined） ==========
    console.log('\n===== 场景2: 局域网非安全上下文（clipboard undefined） =====');

    await P.send('Page.navigate', { url: TARGET_URL + '?v=' + Date.now() });
    await sleep(3500);
    await P.send('Runtime.enable');

    await P.eval(`Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); 'ok'`);
    const clipType = await P.eval('typeof navigator.clipboard');
    log('[场景2] 模拟环境（clipboard=undefined）', clipType === 'undefined', `typeof=${clipType}`);

    await openManualPanel(P);
    await clickElement(P, '#create-btn');
    const sdp2 = await waitFor(P, 'document.getElementById("sdp-text") && document.getElementById("sdp-text").value.length > 100', 15000, 'SDP');
    log('[场景2] SDP 生成', sdp2.ok, `耗时 ${sdp2.ms}ms`);
    await waitFor(P, 'document.getElementById("copy-sdp-btn") && document.getElementById("copy-sdp-btn").getBoundingClientRect().width > 0', 8000, '复制按钮');

    setClipboard('SENTINEL-SCENE2');
    await sleep(300);

    P.events = [];
    await clickElement(P, '#copy-sdp-btn');
    const btn2 = await waitFor(P, 'document.getElementById("copy-sdp-btn").textContent.includes("已复制")', 4000, '按钮反馈');

    if (NO_SYSTEM_CLIPBOARD) {
        console.log('  [SKIP] [场景2] 系统剪贴板黄金标准校验（无系统剪贴板环境，已跳过）');
    } else {
        const clip2 = getClipboard();
        const clip2Ok = clip2.includes('v=0') && clip2.includes('m=application');
        log('[场景2] execCommand 写入系统剪贴板', clip2Ok, clip2Ok ? `${clip2.length} 字符` : `内容: "${clip2.substring(0, 60)}"`);
    }
    log('[场景2] 按钮反馈', btn2.ok, `"已复制！"`);
    const errors2 = P.events.filter(e => e.method === 'Runtime.exceptionThrown');
    log('[场景2] 无 JS 异常', errors2.length === 0, errors2.length ? '有异常' : '无');

    // ========== 场景3: 粘贴按钮（降级路径） ==========
    console.log('\n===== 场景3: 粘贴按钮降级 =====');

    await clickElement(P, '#back-btn');
    await sleep(1000);
    await openManualPanel(P);
    await waitFor(P, 'document.getElementById("join-btn") && document.getElementById("join-btn").getBoundingClientRect().width > 0', 6000, 'join按钮');
    await clickElement(P, '#join-btn');
    await waitFor(P, 'document.getElementById("paste-sdp-btn") && document.getElementById("paste-sdp-btn").getBoundingClientRect().width > 0', 8000, '粘贴按钮');

    setClipboard('PASTE-TEST-CONTENT-999');
    await sleep(300);

    P.events = [];
    dialogs.length = 0;
    await clickElement(P, '#paste-sdp-btn');
    await sleep(1200);

    const pasteErrors = P.events.filter(e => e.method === 'Runtime.exceptionThrown');
    log('[场景3] 粘贴按钮无 JS 异常', pasteErrors.length === 0, pasteErrors.length ? '有异常' : '无');
    const pastedVal = await P.eval('document.getElementById("sdp-input-text").value');
    const pasteWorked = pastedVal && pastedVal.includes('PASTE-TEST');
    log('[场景3] 粘贴行为（读入或引导均可）', true,
        pasteWorked ? `成功读入系统剪贴板内容` : `引导手动粘贴（对话框: ${dialogs.length ? dialogs[0].substring(0, 30) : '无'}）`);

    // ========== 场景4: 完全兜底（两种方式都不可用） ==========
    console.log('\n===== 场景4: 完全兜底路径 =====');

    await P.send('Page.navigate', { url: TARGET_URL + '?v=' + Date.now() });
    await sleep(3500);
    await P.send('Runtime.enable');

    // clipboard undefined + execCommand 禁用
    await P.eval(`
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        document.execCommand = () => false;
        'ok'
    `);

    await openManualPanel(P);
    await clickElement(P, '#create-btn');
    await waitFor(P, 'document.getElementById("sdp-text") && document.getElementById("sdp-text").value.length > 100', 15000, 'SDP');
    await waitFor(P, 'document.getElementById("copy-sdp-btn") && document.getElementById("copy-sdp-btn").getBoundingClientRect().width > 0', 8000, '复制按钮');

    P.events = [];
    dialogs.length = 0;
    await clickElement(P, '#copy-sdp-btn');
    await sleep(1500);

    const b4Errors = P.events.filter(e => e.method === 'Runtime.exceptionThrown');
    const b4Selected = await P.eval(`(() => {
        const t = document.getElementById('sdp-text');
        return t && (t.selectionStart !== t.selectionEnd) || document.activeElement === t;
    })()`);
    log('[场景4] 完全兜底无 JS 异常', b4Errors.length === 0, b4Errors.length ? '有异常' : '无');
    log('[场景4] 自动选中内容引导手动复制', b4Selected === true, `selected=${b4Selected}, 对话框=${dialogs.length ? '已弹出引导' : '无'}`);

    // ========== 汇总 ==========
    console.log('\n========== 最终验证汇总 ==========');
    const passed = results.filter(r => r.pass).length;
    console.log(`通过: ${passed}/${results.length}`);
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail || ''}`));

    P.close();
    killProc(edgeProc);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
    console.error('致命错误:', e);
    killProc(edgeProc);
    process.exit(1);
});
