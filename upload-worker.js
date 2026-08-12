import { chromium } from 'playwright';

// Dolphin возвращает адрес отладки запущенного профиля. Этот worker подключается
// к уже запущенному профилю, не создавая отдельный браузер и не сохраняя cookies.
export async function uploadOwnVideo({ wsEndpoint, videoPath, title, description = '', tags = [] }) {
  if (!wsEndpoint) throw new Error('Dolphin не вернул wsEndpoint для профиля');
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /создать|create/i }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByText(/загрузить видео|upload videos/i).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(videoPath);
    await page.getByLabel(/название|title/i).fill(title);
    const descriptionField = page.getByLabel(/описание|description/i);
    if (await descriptionField.count()) await descriptionField.fill(description);
    for (const tag of tags) {
      const tagField = page.getByLabel(/теги|tags/i);
      if (await tagField.count()) await tagField.fill(tag);
    }
    return { status: 'uploaded-to-form', url: page.url() };
  } finally {
    await browser.close();
  }
}
