import { test, expect } from '@playwright/test';

test.describe('ezspeak', () => {
  test('landing page renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toContainText('ezspeak');
    await expect(page.locator('#username-input')).toBeVisible();
    await expect(page.locator('#server-input')).toBeVisible();
    await expect(page.locator('#join-form button[type="submit"]')).toBeVisible();
  });

  test('can join a server and see channel list', async ({ page }) => {
    await page.goto('/');
    await page.locator('#username-input').fill('PlaywrightBot');
    await page.locator('#server-input').fill('testroom');
    await page.locator('#join-form button[type="submit"]').click();

    // Should transition to server page
    await expect(page.locator('#server-page')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#status-dot.connected')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#channel-list .channel-item')).not.toHaveCount(0);

    // Should see self in user list
    await page.locator('#channel-list .channel-item').first().click();
    await expect(page.locator('#user-list .user-item')).toContainText('PlaywrightBot');
  });

  test('settings modal opens and shows devices', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-btn-landing').click();
    await expect(page.locator('#settings-modal')).toBeVisible();
    await expect(page.locator('#settings-mic-select')).toBeVisible();
    await expect(page.locator('#settings-cam-select')).toBeVisible();
  });

  test('PWA manifest is served', async ({ page }) => {
    const response = await page.request.get('/manifest.json');
    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.name).toBe('ezspeak');
    expect(json.display).toBe('standalone');
  });

  test('service worker registers', async ({ page }) => {
    await page.goto('/');
    // Wait for SW registration
    await page.waitForFunction(() => 'serviceWorker' in navigator);
  });
});
