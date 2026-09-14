/**
 * 信令服务器 API 自动化测试（纯 Node，零依赖，跨平台）
 *
 * 覆盖：
 *   - /api/ping 服务探测
 *   - /api/ip   客户端 IP 反射
 *   - /api/room 创建 / 冲突 / 非法房间号 / 查询 / 关闭
 *   - /api/offer 上传 / 拉取 / 等待中
 *   - /api/answer 上传 / 防覆盖 / 拉取 / 不存在房间
 *   - 静态文件服务 / 路径穿越防护 / 请求体上限 / 无效 JSON
 *
 * 运行：
 *   node utils/tests/signal-api.cjs
 *
 * 说明：本测试自行在测试端口（默认 1899）拉起 server.js，跑完自动清理，
 *       不依赖外部已启动的服务，适合 CI 直接执行。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.SIGNAL_TEST_PORT || '1899', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function log(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`[${pass ? '✅' : '❌'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, pathname, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(BASE + pathname, opts);
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
}

async function waitServerReady(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const { status, data } = await req('GET', '/api/ping');
            if (status === 200 && data && data.ok) return true;
        } catch { /* 尚未就绪 */ }
        await sleep(300);
    }
    return false;
}

async function main() {
    console.log(`\n====== 信令 API 测试（端口 ${PORT}）======\n`);

    // ---------- 启动独立服务器实例 ----------
    console.log('--- 启动测试服务器（node server.js ' + PORT + '）---');
    const server = spawn(process.execPath, ['server.js', String(PORT)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    const ready = await waitServerReady(15000);
    if (!ready) {
        console.error('服务器启动失败，日志：\n' + serverLog);
        try { server.kill(); } catch (e) {}
        process.exit(1);
    }
    log('服务器启动就绪', true, `端口 ${PORT}`);

    try {
        // ---------- /api/ping ----------
        const ping = await req('GET', '/api/ping');
        log('/api/ping 服务探测', ping.status === 200 && ping.data.ok === true && ping.data.service === 'lan-chat-signal',
            `status=${ping.status}`);

        // ---------- /api/ip ----------
        const ip = await req('GET', '/api/ip');
        log('/api/ip 客户端 IP 反射', ip.status === 200 && typeof ip.data.ip === 'string' && ip.data.ip.length > 0 && Array.isArray(ip.data.serverIPs),
            `ip=${ip.data.ip}, serverIPs=${(ip.data.serverIPs || []).length}个`);

        // ---------- 房间创建 ----------
        const ROOM = String(1000 + Math.floor(Math.random() * 9000));

        const created = await req('POST', '/api/room', { room: ROOM });
        log('创建房间成功', created.status === 200 && created.data.ok === true, `房间 ${ROOM}`);

        const conflict = await req('POST', '/api/room', { room: ROOM });
        log('房间号冲突返回 409', conflict.status === 409, `status=${conflict.status}`);

        const badCode = await req('POST', '/api/room', { room: 'abc1' });
        log('非法房间号返回 400', badCode.status === 400, `status=${badCode.status}`);

        const longCode = await req('POST', '/api/room', { room: '12345' });
        log('超长房间号返回 400', longCode.status === 400, `status=${longCode.status}`);

        // ---------- 查询房间 ----------
        const roomQuery = await req('GET', `/api/room?room=${ROOM}`);
        log('查询房间（已创建、无 offer）', roomQuery.status === 200 && roomQuery.data.hasOffer === false,
            `hasOffer=${roomQuery.data.hasOffer}`);

        // ---------- offer 上传 / 拉取 ----------
        const OFFER = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n';
        const offerUp = await req('POST', '/api/offer', { room: ROOM, offer: OFFER });
        log('上传 offer 成功', offerUp.status === 200 && offerUp.data.ok === true, `${OFFER.length} 字符`);

        const roomHasOffer = await req('GET', `/api/room?room=${ROOM}`);
        log('查询房间（含 offer）', roomHasOffer.data.hasOffer === true, `hasOffer=${roomHasOffer.data.hasOffer}`);

        const offerGet = await req('GET', `/api/offer?room=${ROOM}`);
        log('拉取 offer 内容一致', offerGet.status === 200 && offerGet.data.offer === OFFER, `长度 ${String(offerGet.data.offer || '').length}`);

        const roomPulled = await req('GET', `/api/room?room=${ROOM}`);
        log('拉取后标记 offerPulled', roomPulled.data.offerPulled === true, `offerPulled=${roomPulled.data.offerPulled}`);

        // 新房间：未上传 offer 时拉取应 waiting
        let ROOM2 = String(1000 + Math.floor(Math.random() * 8999));
        while (ROOM2 === ROOM) ROOM2 = String(1000 + Math.floor(Math.random() * 8999));
        await req('POST', '/api/room', { room: ROOM2 });
        const offerWaiting = await req('GET', `/api/offer?room=${ROOM2}`);
        log('无 offer 时拉取返回 waiting', offerWaiting.status === 200 && offerWaiting.data.waiting === true,
            `waiting=${offerWaiting.data.waiting}`);

        // ---------- answer 上传 / 拉取 ----------
        const ANSWER = 'v=0\r\no=- 6440144415730901619 2 IN IP4 127.0.0.1\r\ns=-\r\na=group:BUNDLE 0\r\n';
        const answerUp = await req('POST', '/api/answer', { room: ROOM, answer: ANSWER });
        log('上传 answer 成功', answerUp.status === 200 && answerUp.data.ok === true, `${ANSWER.length} 字符`);

        const answerDup = await req('POST', '/api/answer', { room: ROOM, answer: ANSWER });
        log('重复 answer 返回 409（防覆盖）', answerDup.status === 409, `status=${answerDup.status}`);

        const answerGet = await req('GET', `/api/answer?room=${ROOM}`);
        log('拉取 answer 内容一致', answerGet.status === 200 && answerGet.data.answer === ANSWER, `长度 ${String(answerGet.data.answer || '').length}`);

        // ---------- 错误分支 ----------
        const notExist = await req('GET', '/api/offer?room=0000');
        log('不存在房间返回 404', notExist.status === 404, `status=${notExist.status}`);

        const badJson = await req('POST', '/api/room', '{bad json');
        log('无效 JSON 返回 400', badJson.status === 400, `status=${badJson.status}`);

        const bigBody = await req('POST', '/api/offer', { room: ROOM, offer: 'x'.repeat(3 * 1024 * 1024) });
        log('超大请求体返回 413', bigBody.status === 413, `status=${bigBody.status}`);

        // ---------- 关闭房间 ----------
        const closed = await req('POST', '/api/close', { room: ROOM });
        log('关闭房间成功', closed.status === 200 && closed.data.ok === true, ``);

        const afterClose = await req('GET', `/api/room?room=${ROOM}`);
        log('关闭后查询返回 404', afterClose.status === 404, `status=${afterClose.status}`);

        // ---------- 静态文件 ----------
        const page = await fetch(BASE + '/');
        const pageText = await page.text();
        log('静态首页可访问且内容正确', page.status === 200 && pageText.includes('局域网匿名聊天室'),
            `status=${page.status}, ${pageText.length} 字节`);

        const notFound = await fetch(BASE + '/not-exist-file.xyz');
        log('不存在文件返回 404', notFound.status === 404, `status=${notFound.status}`);

        // 路径穿越防护：无论 403/404，只要不返回非项目文件内容即安全
        const traversal = await fetch(BASE + '/..%5c..%5cWindows%5cwin.ini');
        const traversalText = await traversal.text();
        const traversed = traversal.status === 200 && /\[fonts\]/i.test(traversalText);
        log('路径穿越防护（未泄露系统文件）', !traversed, `status=${traversal.status}`);

    } finally {
        try { server.kill(); } catch (e) {}
        await sleep(300);
    }

    // ---------- 汇总 ----------
    const passed = results.filter((r) => r.pass).length;
    console.log('\n========== 信令 API 测试汇总 ==========');
    console.log(`通过: ${passed}/${results.length}`);
    results.filter((r) => !r.pass).forEach((r) => console.log(`  ❌ ${r.name}: ${r.detail || ''}`));
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
});
