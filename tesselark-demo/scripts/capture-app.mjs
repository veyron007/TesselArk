import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const origin = process.env.TESSELARK_URL || 'http://127.0.0.1:3001';
const output = new URL('../public/screens/', import.meta.url);
await mkdir(output, {recursive: true});

const browser = await chromium.launch({headless: true, channel: 'chrome'});
const page = await browser.newPage({viewport: {width: 1600, height: 900}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const capture = async (name) => {
  await page.screenshot({path: fileURLToPath(new URL(`${name}.png`, output))});
  await page.screenshot({path: fileURLToPath(new URL(`${name}-focus.png`, output)), clip: {x: 220, y: 70, width: 1380, height: 776}});
};

try {
  await page.goto(`${origin}/demo`);
  await page.locator('.chooser-card').filter({hasText: 'Dev Accountant'}).first().getByRole('link', {name: /Enter demo as/}).click();
  await page.waitForURL('**/app');

  const routes = [
    ['overview', '/app'],
    ['orders', '/orders'],
    ['batches', '/batches'],
    ['invoice-checks', '/invoice-checks'],
    ['evidence', '/evidence'],
    ['work-tasks', '/work-tasks'],
    ['gst', '/gst'],
    ['simulator', '/simulator'],
  ];

  for (const [name, route] of routes) {
    await page.goto(`${origin}${route}?gstin=1&branch=1`);
    await page.waitForSelector('.app-shell');
    await page.waitForTimeout(700);
    await capture(name);
    console.log(`${name}: ${await page.locator('h1').first().textContent()}`);

    if (name === 'orders') {
      await page.locator('.orders-row').nth(1).click();
      await capture('orders-detail');
    }
    if (name === 'invoice-checks') {
      await page.getByRole('tab', {name: /Tax policy register/}).click();
      await capture('tax-policies');
    }
    if (name === 'work-tasks') {
      await page.evaluate(() => window.scrollTo(0, 450));
      await capture('work-tasks-detail');
    }
    if (name === 'gst') {
      await page.locator('.gst-period').nth(1).click();
      await capture('gst-reviewed');
    }
  }

  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
} finally {
  await browser.close();
}
