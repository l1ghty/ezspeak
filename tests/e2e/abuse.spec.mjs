// Browser-level checks for abuse protections.
import { test, expect } from '@playwright/test';

const uniq = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Headless Chrome may expose showSaveFilePicker; force the in-memory path.
const noSavePicker = () => { delete window.showSaveFilePicker; };

async function openUser(browser, baseURL, room, name) {
  const context = await browser.newContext({ baseURL, permissions: ['microphone'], acceptDownloads: true });
  await context.addInitScript(noSavePicker);
  const page = await context.newPage();
  await page.goto(`/server/${room}?username=${name}`);
  await expect(page.locator('#status-dot.connected')).toBeVisible({ timeout: 10000 });
  return { context, page };
}

const myId = (page) => page.evaluate(() => userId);

async function waitConnected(page, peerId) {
  await expect.poll(() => page.evaluate((id) => getPeerConnectionState(id), peerId), { timeout: 15000 }).toBe('connected');
}

test('admin removes a user; they are sent home and cannot rejoin', async ({ browser, baseURL }) => {
  const room = uniq('kick');
  const owner = await openUser(browser, baseURL, room, 'owner');
  const troll = await openUser(browser, baseURL, room, 'troll');
  const tid = await myId(troll.page);

  await expect(troll.page.locator('.peer-kick-btn')).toHaveCount(0);   // only the admin sees it
  await owner.page.locator(`.peer-kick-btn[data-peer="${tid}"]`).click();
  await owner.page.locator('#confirm-modal-ok').click();

  await expect(troll.page.locator('#confirm-modal-message')).toContainText('removed');
  await expect(owner.page.locator('#chat-messages')).toContainText('troll was removed');
  await expect(owner.page.locator('#user-list')).not.toContainText('troll');
  await troll.page.locator('#confirm-modal-ok').click();
  await troll.page.waitForURL(/\/$/);

  // Same IP → banned for this server's lifetime
  await troll.page.goto(`/server/${room}?username=troll2`);
  await expect(troll.page.locator('#confirm-modal-message')).toContainText('removed from this server');
  await owner.context.close(); await troll.context.close();
});

test('file transfer works, and a peer sending more than announced is cut off', async ({ browser, baseURL }) => {
  const room = uniq('file');
  const a = await openUser(browser, baseURL, room, 'alice');
  const b = await openUser(browser, baseURL, room, 'bob');
  await waitConnected(a.page, await myId(b.page));
  await waitConnected(b.page, await myId(a.page));

  // Normal transfer
  await a.page.locator('#file-input').setInputFiles({ name: 'hello.txt', mimeType: 'text/html', buffer: Buffer.from('hello world') });
  const btn = b.page.locator('.file-dl-btn').first();
  await expect(btn).toBeVisible();
  const [download] = await Promise.all([b.page.waitForEvent('download'), btn.click()]);
  expect(download.suggestedFilename()).toBe('hello.txt');
  const fs = await import('fs');
  expect(fs.readFileSync(await download.path(), 'utf8')).toBe('hello world');

  // Malicious sender: announces 10 bytes, then serves 100 KB.
  await a.page.locator('#file-input').setInputFiles({ name: 'small.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10) });
  await a.page.evaluate(() => {
    const [id] = [...fileBlobs.keys()].slice(-1);
    fileBlobs.set(id, new Blob([new Uint8Array(100 * 1024)]));
  });
  const evil = b.page.locator('.file-dl-btn').nth(1);
  await expect(evil).toBeVisible();
  let downloaded = false;
  b.page.on('download', () => { downloaded = true; });
  await evil.click();
  await expect(evil).toContainText('Failed');
  await b.page.waitForTimeout(500);
  expect(downloaded).toBe(false);
  await a.context.close(); await b.context.close();
});

test('chat flooding gets a slow-down notice', async ({ browser, baseURL }) => {
  const a = await openUser(browser, baseURL, uniq('flood'), 'alice');
  await expect(a.page.locator('#chat-input')).toBeVisible();
  await a.page.evaluate(() => { for (let i = 0; i < 30; i++) sendWs({ type: 'chat-message', message: 'spam ' + i }); });
  await expect(a.page.locator('#chat-messages')).toContainText('sending messages too fast');
  const count = await a.page.locator('#chat-messages .chat-msg:not(.system)').count();
  expect(count).toBeLessThanOrEqual(12);
  await a.context.close();
});

test('refreshing TURN credentials keeps the call connected', async ({ browser, baseURL }) => {
  const room = uniq('refresh');
  const a = await openUser(browser, baseURL, room, 'alice');
  const b = await openUser(browser, baseURL, room, 'bob');
  const idb = await myId(b.page);
  await waitConnected(a.page, idb);
  // Same path the timer takes: ask the server, apply the answer.
  await a.page.evaluate(() => sendWs({ type: 'get-ice-servers' }));
  await b.page.evaluate(() => sendWs({ type: 'get-ice-servers' }));
  await a.page.waitForTimeout(1500);
  const before = (await a.page.evaluate(() => getRtcDebugInfo()))[idb].bytesReceived;
  await expect.poll(async () => (await a.page.evaluate(() => getRtcDebugInfo()))[idb]?.bytesReceived || 0,
    { timeout: 8000 }).toBeGreaterThan(before + 2000);
  expect(await a.page.evaluate((id) => getPeerConnectionState(id), idb)).toBe('connected');
  await a.context.close(); await b.context.close();
});
