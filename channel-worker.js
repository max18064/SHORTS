import { chromium } from 'playwright';

const loginUrl = /accounts\.google\.com|ServiceLogin/i;
const byText = (page, expression) => page.getByText(expression).first();

async function fillIfPresent(locator, value) {
  if (value == null || value === '' || !(await locator.count())) return false;
  await locator.first().fill(value);
  return true;
}

export async function updateChannelBranding({ wsEndpoint, name = '', description = '', links = [], avatarPath = '', bannerPath = '' }) {
  if (!wsEndpoint) throw new Error('Dolphin не вернул адрес автоматизации профиля');
  const browser = await chromium.connectOverCDP(wsEndpoint);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' });
    if (loginUrl.test(page.url())) return { status: 'manual-login-required', url: page.url() };

    const customize = page.getByText(/настройка канала|customization/i).first();
    if (await customize.count()) await customize.click();
    await page.waitForTimeout(700);

    const nameChanged = await fillIfPresent(page.getByRole('textbox', { name: /название|name/i }), name);
    const descriptionChanged = await fillIfPresent(page.getByRole('textbox', { name: /описание|description/i }), description);

    if (avatarPath || bannerPath) {
      const branding = byText(page, /брендинг|branding/i);
      if (await branding.count()) await branding.click();
      await page.waitForTimeout(400);
      const inputs = page.locator('input[type="file"]');
      if (avatarPath && await inputs.count()) await inputs.nth(0).setInputFiles(avatarPath);
      if (bannerPath && await inputs.count() > 1) await inputs.nth(1).setInputFiles(bannerPath);
    }

    const normalizedLinks = Array.isArray(links) ? links.filter(link => link?.title && link?.url) : [];
    if (normalizedLinks.length) {
      const basic = byText(page, /основные сведения|basic info/i);
      if (await basic.count()) await basic.click();
      for (const link of normalizedLinks) {
        const addLink = byText(page, /добавить ссылку|add link/i);
        if (!(await addLink.count())) break;
        await addLink.click();
        const fields = page.getByRole('textbox');
        const count = await fields.count();
        if (count >= 2) {
          await fields.nth(count - 2).fill(link.title);
          await fields.nth(count - 1).fill(link.url);
        }
      }
    }

    const publish = page.getByRole('button', { name: /опубликовать|publish/i }).first();
    if (await publish.count()) await publish.click();
    else throw new Error('Кнопка сохранения оформления канала не найдена');
    return { status: 'applied', nameChanged, descriptionChanged, linksAdded: normalizedLinks.length, url: page.url() };
  } finally {
    await browser.close();
  }
}
