import { chromium } from 'playwright';

export async function openUploadSession({ wsEndpoint }) {
  if (!wsEndpoint) throw new Error('Dolphin не вернул wsEndpoint для профиля');
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' });
  const needsLogin = /accounts\.google\.com|ServiceLogin/i.test(page.url());
  return { browser, context, page, needsLogin };
}

export async function uploadIntoSession({ session, videoPath, title, description = '', tags = [] }) {
  const { page } = session;
  if (/accounts\.google\.com|ServiceLogin/i.test(page.url())) return { status: 'manual-login-required', url: page.url() };
  await page.getByRole('button', { name: /создать|create/i }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByText(/загрузить видео|upload videos/i).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(videoPath);
  const titleField = page.getByLabel(/название|title/i);
  if (await titleField.count()) await titleField.fill(title);
  const descriptionField = page.getByLabel(/описание|description/i);
  if (await descriptionField.count()) await descriptionField.fill(description);
  const tagField = page.getByLabel(/теги|tags/i);
  if (tags.length && await tagField.count()) await tagField.fill(tags.join(', '));
  return { status: 'uploaded-to-form', url: page.url() };
}

export async function uploadOwnVideo(options) {
  const session = await openUploadSession(options);
  try { return await uploadIntoSession({ session, ...options }); }
  finally { await session.browser.close(); }
}
