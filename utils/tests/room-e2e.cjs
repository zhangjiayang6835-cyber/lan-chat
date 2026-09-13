/**
 * 数字房间号模式 · 双端真实浏览器端到端验证
 *
 * 覆盖场景：
 *   1. 双端浏览器打开页面，host 输入房间号 4321 → 创建房间并等待
 *   2. guest 输入相同房间号 → 自动加入，信令交换完成
 *   3. 双端 P2P DataChannel 建立，进入聊天视图
 *   4. host 发消息 → guest 收到（双向各验证一次）
 *   5. host 刷新/断线后房间清理验证（可选）
 *
 * 黄金标准：两个独立浏览器进程、真实 WebRTC 连接、真实 UI 点击与会话互通。
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_PORT = 1808;
const CDP_HOST = 9341;
const CDP_GUEST = 9342;
const BASE_URL = `http://127.0.0.1:${BASE_PORT}/index.html`;
const ROOM = String(1000 + Math.floor(Math.random() * 9000)); // 随机 4 位房间号

let hostProc = null, guestProc = null;

class CDP {
    constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; this.dialogs = []; }
    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('WS fail'));
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.method) {
                    this.events.push(msg);
                    if (msg.method === 'Page.javascriptDialogOpening') {
                        this.dialogs.push(msg.params.message);
                        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
                    }
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
    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.id;
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        return result.exceptionDetails
            ? { __error: (result.exceptionDetails.exception?.description || result.exceptionDetails.text) }
            : result.result?.value;
    }
    close() { if (this.ws) this.ws.close(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTargets(port) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

async function killExistingOnPort(port) {
    const occupied = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(1200, () => { req.destroy(); resolve(false); });
    });
    if (!occupied) return;
    try {
        const out = execSync(`wmic process where "name='msedge.exe'" get ProcessId,CommandLine`, { encoding: 'utf8' });
        const lines = out.split('\n').filter(l => l.includes(`remote-debugging-port=${port}`));
        const pids = new Set();
        for (const line of lines) { const m = line.match(/(\d+)\s*$/); if (m) pids.add(m[1]); }
        for (const pid of pids) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (e) {} }
    } catch (e) {}
    await sleep(1200);
}

async function launch(port, profileTag, url) {
    await killExistingOnPort(port);
    const profileDir = os.tmpdir() + `\\lanchat-room-${profileTag}-` + Date.now();
    const proc = spawn(EDGE, [
        `--remote-debugging-port=${port}`,
        '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        '--window-size=880,760',
        url
    ], { stdio: 'ignore', detached: true });

    let page = null;
    for (let i = 0; i < 40; i++) {
        await sleep(400);
        try {
            const targets = await getTargets(port);
            page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
            if (page) break;
        } catch (e) {}
    }
    if (!page) throw new Error(`浏览器 ${port} 页面未就绪`);
    const client = new CDP(page.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    return { proc, client };
}

async function waitFor(P, expr, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const val = await P.eval(expr);
        if (val && !(val && val.__error)) return { ok: true, val, ms: Date.now() - start };
        await sleep(350);
    }
    return { ok: false, val: null, ms: timeoutMs };
}

async function typeInto(P, selector, text) {
    // 聚焦 + 清空 + 真实文本输入（Input.insertText 触发一次 input 事件，避免字符重复）
    await P.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(120);
    await P.send('Input.insertText', { text });
    await sleep(200);
}

/**
 * 注入等待状态历史记录器（用于捕捉瞬态 UI 文案变化）
 */
async function injectStatusRecorder(P) {
    await P.eval(`(() => {
        window.__statusHistory = [];
        const el = document.getElementById('waiting-status');
        const record = () => {
            const t = el.textContent;
            if (window.__statusHistory[window.__statusHistory.length - 1] !== t) window.__statusHistory.push(t);
        };
        new MutationObserver(record).observe(el, { childList: true, characterData: true, subtree: true });
        const wc = document.getElementById('waiting-code');
        window.__codeHistory = [];
        new MutationObserver(() => {
            const t = wc.textContent;
            if (window.__codeHistory[window.__codeHistory.length - 1] !== t) window.__codeHistory.push(t);
        }).observe(wc, { childList: true, characterData: true, subtree: true });
        return 'ok';
    })()`);
}

async function clickElement(P, selector) {
    const pos = await P.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height });
    })()`);
    if (!pos || pos.__error) throw new Error('元素不存在: ' + selector);
    const p = JSON.parse(pos);
    if (p.w === 0) throw new Error('元素不可见: ' + selector);
    await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
    await sleep(60);
    await P.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(40);
    await P.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function main() {
    const results = [];
    const log = (name, pass, detail) => {
        results.push({ name, pass, detail });
        console.log(`[${pass ? '✅' : '❌'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    console.log(`\n====== 数字房间号模式 · 双端 e2e（房间号 ${ROOM}）======\n`);

    console.log('=== 启动双端浏览器 ===');
    const host = await launch(CDP_HOST, 'host', BASE_URL);
    hostProc = host.proc;
    const guest = await launch(CDP_GUEST, 'guest', BASE_URL);
    guestProc = guest.proc;
    const H = host.client, G = guest.client;

    await sleep(2000);

    // ---------- 场景1: 页面元素与 API 就绪 ----------
    console.log('----- 场景1: 页面与信令 API 就绪 -----');
    const hostReady = await waitFor(H, 'document.getElementById("room-code-input") && document.getElementById("room-code-input").getBoundingClientRect().width > 0', 8000, 'host房间输入框');
    log('[场景1] host 数字房间 UI 渲染', hostReady.ok, `${hostReady.ms}ms`);

    const ipReady = await waitFor(H, 'typeof state !== "undefined" && !!state.hostIp', 6000, 'hostIp');
    log('[场景1] mDNS 修复已就绪（hostIp 已获取）', ipReady.ok, ipReady.ok ? `IP=${ipReady.val === true ? '' : ''}已获取` : '未获取到 IP');

    // ---------- 场景2: host 创建房间 ----------
    console.log('----- 场景2: host 创建房间 -----');
    await injectStatusRecorder(H);
    await injectStatusRecorder(G);
    await typeInto(H, '#room-code-input', ROOM);
    const typed = await H.eval('document.getElementById("room-code-input").value');
    log('[场景2] 房间号输入', typed === ROOM, `value="${typed}"`);

    await clickElement(H, '#enter-room-btn');
    const waitShown = await waitFor(H, '!document.getElementById("waiting-panel").hidden && document.getElementById("waiting-code").textContent === ' + JSON.stringify(ROOM), 10000, '等待面板');
    log('[场景2] host 进入等待面板', waitShown.ok, `显示房间号 ${ROOM}`);

    // 服务器端验证房间已创建（offer 上传是异步的，需轮询等待）
    const offerUploaded = await waitFor(
        H,
        `fetch("/api/room?room=${ROOM}").then(r => r.json()).then(d => d.hasOffer === true).catch(() => false)`,
        12000, 'offer上传'
    );
    log('[场景2] 服务器确认房间已创建（offer 已上传）', offerUploaded.ok, `${offerUploaded.ms}ms`);

    await sleep(1000);

    // ---------- 场景3: guest 加入房间 ----------
    console.log('----- 场景3: guest 加入房间 -----');
    await typeInto(G, '#room-code-input', ROOM);
    await clickElement(G, '#enter-room-btn');

    // ---------- 场景4: 双端 P2P 连接建立 ----------
    console.log('----- 场景4: P2P 连接建立 -----');
    const hostConnected = await waitFor(H, 'typeof state !== "undefined" && state.isConnected === true && document.getElementById("chat-view").classList.contains("active")', 25000, 'host连接');
    const guestConnected = await waitFor(G, 'typeof state !== "undefined" && state.isConnected === true && document.getElementById("chat-view").classList.contains("active")', 25000, 'guest连接');

    // host 感知对方加入：检查瞬态文案（协商中/已找到）是否出现过
    const hostStatusHistory = await H.eval('JSON.stringify(window.__statusHistory || [])');
    const hostSawPull = String(hostStatusHistory).includes('协商') || String(hostStatusHistory).includes('朋友已找到') || String(hostStatusHistory).includes('回应');
    log('[场景3] host 感知到对方加入（瞬态文案）', hostSawPull, hostStatusHistory);

    log('[场景4] host 进入聊天视图（P2P已连）', hostConnected.ok, `${hostConnected.ms}ms`);
    log('[场景4] guest 进入聊天视图（P2P已连）', guestConnected.ok, `${guestConnected.ms}ms`);

    // 通过 window 上的辅助函数不可用，改用 DOM 状态检查
    const hostStatus = await H.eval('document.getElementById("status-text").textContent');
    const guestStatus = await G.eval('document.getElementById("status-text").textContent');
    log('[场景4] host 状态栏', hostStatus === '已连接', `"${hostStatus}"`);
    log('[场景4] guest 状态栏', guestStatus === '已连接', `"${guestStatus}"`);

    // ---------- 场景5: 消息双向互通 ----------
    console.log('----- 场景5: 消息互通 -----');
    // 等 host 视图切换过渡动画完成，避免点击落在动画期间
    await sleep(1000);

    // 真实用户操作时窗口在前台：把 host 窗口带到前台，确保输入事件投递
    await H.send('Page.bringToFront');
    await sleep(600);

    const MSG1 = '你好，这是host的消息 ' + Date.now();
    const sendBtnReady = await H.eval('!document.getElementById("send-btn").disabled && document.getElementById("send-btn").getBoundingClientRect().width > 0');
    log('[场景5] host 发送按钮就绪', sendBtnReady === true, `disabled=${!sendBtnReady}`);

    // 注入点击计数器（capture 阶段，不干扰原 handler）
    await H.eval(`window.__sendClicks = 0; document.getElementById('send-btn').addEventListener('click', () => { window.__sendClicks++; }, true); 'ok'`);

    await H.eval(`document.getElementById("message-input").value = ${JSON.stringify(MSG1)}`);
    await clickElement(H, '#send-btn');
    await sleep(1200);

    let clicks = await H.eval('window.__sendClicks');
    let sendPath = 'mouse';
    // 兜底：若鼠标事件被系统丢弃（后台窗口），改用键盘发送（产品支持 Enter 发送）
    if (clicks === 0) {
        console.log('  [诊断] 鼠标事件未投递，改用键盘 Enter 发送');
        await H.eval('document.getElementById("message-input").focus()');
        await H.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await H.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(800);
        sendPath = 'keyboard-enter';
    }

    const hostDiag = await H.eval(`JSON.stringify({
        clicks: window.__sendClicks,
        hasMsgLocal: document.getElementById('messages').textContent.includes(${JSON.stringify(MSG1)}),
        inputCleared: document.getElementById('message-input').value === ''
    })`);
    console.log(`  [诊断] host 发送路径=${sendPath}:`, hostDiag);

    const guestGot1 = await waitFor(G, `document.getElementById("messages").textContent.includes(${JSON.stringify(MSG1)})`, 8000, 'guest收消息');
    log('[场景5] host → guest 消息送达', guestGot1.ok, guestGot1.ok ? `OK（路径: ${sendPath}）` : '未收到');

    const MSG2 = '收到！这是guest的回复 ' + Date.now();
    await G.send('Page.bringToFront');
    await sleep(500);
    await G.eval(`document.getElementById("message-input").value = ${JSON.stringify(MSG2)}`);
    await clickElement(G, '#send-btn');
    const hostGot2 = await waitFor(H, `document.getElementById("messages").textContent.includes(${JSON.stringify(MSG2)})`, 8000, 'host收消息');
    log('[场景5] guest → host 消息送达', hostGot2.ok, hostGot2.ok ? 'OK' : '未收到');

    // ---------- 场景6: 确认房间号已释放（连接完成后自动清理） ----------
    console.log('----- 场景6: 房间生命周期收尾 -----');
    const roomAfter = await H.eval(`fetch("/api/room?room=${ROOM}").then(r => r.json()).then(d => JSON.stringify(d))`);
    const roomReleased = typeof roomAfter === 'string' && roomAfter.includes('不存在');
    log('[场景6] 连接后房间号已释放（可复用）', roomReleased, String(roomAfter).slice(0, 80));

    // ---------- 场景7: 无 JS 异常 ----------
    const hostErrors = H.events.filter(e => e.method === 'Runtime.exceptionThrown');
    const guestErrors = G.events.filter(e => e.method === 'Runtime.exceptionThrown');
    log('[场景7] host 无 JS 异常', hostErrors.length === 0, hostErrors.length ? hostErrors[0].params?.exceptionDetails?.text : '无');
    log('[场景7] guest 无 JS 异常', guestErrors.length === 0, guestErrors.length ? guestErrors[0].params?.exceptionDetails?.text : '无');

    // ---------- 汇总 ----------
    console.log('\n========== 双端 e2e 汇总 ==========');
    const passed = results.filter(r => r.pass).length;
    console.log(`通过: ${passed}/${results.length}`);
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail || ''}`));

    H.close(); G.close();
    try { execSync(`taskkill /F /T /PID ${hostProc.pid}`, { stdio: 'ignore' }); } catch (e) {}
    try { execSync(`taskkill /F /T /PID ${guestProc.pid}`, { stdio: 'ignore' }); } catch (e) {}
    process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
    console.error('致命错误:', e);
    if (hostProc) { try { execSync(`taskkill /F /T /PID ${hostProc.pid}`, { stdio: 'ignore' }); } catch (er) {} }
    if (guestProc) { try { execSync(`taskkill /F /T /PID ${guestProc.pid}`, { stdio: 'ignore' }); } catch (er) {} }
    process.exit(1);
});
