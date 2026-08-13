import { connectDolphinCdp } from './dolphin-cdp.js';

const loginUrl = /accounts\.google\.com|ServiceLogin|signin\/v2/i;
const studioUrl = 'https://studio.youtube.com/';

// Keep the browser worker finite even if Studio or a CDP connection stalls.
// Set CREATOR_FLOW_BROWSER_OPERATION_TIMEOUT_MS for slower installations.
const DEFAULT_OPERATION_TIMEOUT_MS = 90_000;
const MIN_OPERATION_TIMEOUT_MS = 15_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const MAX_LOCATOR_MATCHES = 25;

const studioPageMatcher = /studio\.youtube\.com/i;
const customizationText = /(?:настройка\s+канала|customization)/i;
const brandingText = /(?:брендинг|branding)/i;
const basicInfoText = /(?:основные\s+сведения|basic\s+info)/i;
const addLinkText = /(?:добавить\s+ссылку|add\s+link)/i;
const publishButtonName = /(?:опубликовать|publish)/i;
const nameFieldName = /(?:название|name)/i;
const descriptionFieldName = /(?:описание|description)/i;
const channelNameSelector = '#channel-name, ytcp-channel-name, [id="channel-name"]';
const channelAvatarSelector = 'ytcp-avatar img, ytcp-channel-avatar img, img[src*="yt3.ggpht.com"], img#img';
const fileInputSelector = 'input[type="file"]';
const customizationHrefSelector = 'a[href*="/customization"], a[href*="/editing"], [role="link"][href*="/customization"], [role="link"][href*="/editing"]';
const brandingHrefSelector = 'a[href*="branding"], [role="link"][href*="branding"]';
const basicInfoHrefSelector = 'a[href*="basic"], a[href*="info"], [role="link"][href*="basic"], [role="link"][href*="info"]';
// Studio's current channel editor is a single `/editing/profile` surface in
// some accounts. Keep these ASCII-escaped so the worker remains portable
// through Windows shells with non-UTF-8 console code pages.
const profileTabText = /(?:\u041f\u0440\u043e\u0444\u0438\u043b\u044c|profile)/i;
const channelNamePlaceholder = /(?:\u0423\u043a\u0430\u0436\u0438\u0442\u0435\s+\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435\s+\u043a\u0430\u043d\u0430\u043b\u0430|channel\s+name)/i;
const descriptionFieldHint = /(?:\u041e\u043f\u0438\u0441\u0430\u043d\u0438|description)/i;

function operationTimeout(value) {
  const parsed = Number.parseInt(value ?? process.env.CREATOR_FLOW_BROWSER_OPERATION_TIMEOUT_MS, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_OPERATION_TIMEOUT_MS;
  return Math.min(Math.max(parsed, MIN_OPERATION_TIMEOUT_MS), MAX_OPERATION_TIMEOUT_MS);
}

function createDeadline(timeoutOverride) {
  const timeoutMs = operationTimeout(timeoutOverride);
  const expiresAt = Date.now() + timeoutMs;

  return {
    timeoutMs,
    remaining(stage) {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        throw new Error(`${stage}: истёк общий лимит операции (${Math.ceil(timeoutMs / 1_000)} с).`);
      }
      return ms;
    },
  };
}

function stepTimeout(deadline, stage) {
  return Math.max(1, Math.min(DEFAULT_STEP_TIMEOUT_MS, deadline.remaining(stage)));
}

async function withinDeadline(deadline, stage, action) {
  const timeoutMs = deadline.remaining(stage);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${stage}: истёк общий лимит операции (${Math.ceil(deadline.timeoutMs / 1_000)} с).`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function configurePageTimeouts(page, deadline) {
  const timeoutMs = stepTimeout(deadline, 'Настройка ограничений страницы');
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
}

async function closeCreatedPage(page) {
  await page?.close({ runBeforeUnload: false }).catch(() => {});
}

async function withStudio(wsEndpoint, callback, { operationTimeoutMs } = {}) {
  if (!wsEndpoint) {
    throw new Error('Dolphin не вернул адрес автоматизации профиля.');
  }

  const deadline = createDeadline(operationTimeoutMs);
  let connection;
  let page;
  let createdPage = false;
  try {
    connection = await withinDeadline(deadline, 'Подключение к Automation API Dolphin', () => (
      connectDolphinCdp(wsEndpoint, { timeoutMs: deadline.remaining('Подключение к Automation API Dolphin') })
    ));
    const { browser } = connection;
    const context = browser.contexts()[0];
    if (!context) throw new Error('В профиле Dolphin не найден контекст браузера.');

    page = context.pages().find(item => studioPageMatcher.test(item.url()));
    if (!page) {
      createdPage = true;
      page = await withinDeadline(deadline, 'Открытие вкладки YouTube Studio', () => context.newPage());
    }
    configurePageTimeouts(page, deadline);

    if (!studioPageMatcher.test(page.url())) {
      await withinDeadline(deadline, 'Переход в YouTube Studio', () => (
        page.goto(studioUrl, {
          waitUntil: 'domcontentloaded',
          timeout: stepTimeout(deadline, 'Переход в YouTube Studio'),
        })
      ));
    }

    if (loginUrl.test(page.url())) {
      // Keep the user-visible Studio tab open for the required manual login.
      return { status: 'manual-login-required', url: page.url() };
    }
    return await withinDeadline(deadline, 'Работа с YouTube Studio', () => callback(page, deadline));
  } catch (error) {
    // This worker owns only the tab it created. Existing user tabs stay intact.
    if (createdPage) await closeCreatedPage(page);
    throw error;
  } finally {
    await connection?.disconnect().catch(() => {});
  }
}

async function firstVisible(locator, deadline, stage) {
  const count = await withinDeadline(deadline, `${stage}: поиск`, () => locator.count()).catch(() => 0);
  for (let index = 0; index < Math.min(count, MAX_LOCATOR_MATCHES); index += 1) {
    const candidate = locator.nth(index);
    if (await withinDeadline(deadline, `${stage}: проверка видимости`, () => candidate.isVisible()).catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function clickFirst(page, pattern, deadline, stage) {
  const item = await firstVisible(page.getByText(pattern), deadline, stage);
  if (!item) return false;
  await withinDeadline(deadline, `${stage}: клик`, () => (
    item.click({ timeout: stepTimeout(deadline, `${stage}: клик`) })
  ));
  return true;
}

async function clickVisibleLocator(locator, deadline, stage) {
  const item = await firstVisible(locator, deadline, stage);
  if (!item) return false;
  await withinDeadline(deadline, `${stage}: клик`, () => (
    item.click({ timeout: stepTimeout(deadline, `${stage}: клик`) })
  ));
  return true;
}

async function settleStudioPage(page, deadline, stage) {
  await withinDeadline(deadline, stage, () => (
    page.waitForTimeout(Math.min(600, deadline.remaining(stage)))
  ));
}

function customizationUrlsFromCurrentPage(currentUrl) {
  try {
    const url = new URL(currentUrl);
    const match = url.pathname.match(/\/channel\/([^/?#]+)/i);
    if (!match) return [];
    const channelId = encodeURIComponent(match[1]);
    // `/editing/profile` is the live route exposed by current Studio. Keep
    // the older routes as fallbacks for accounts that still use them.
    return [
      `${url.origin}/channel/${channelId}/editing/profile`,
      `${url.origin}/channel/${channelId}/editing`,
      `${url.origin}/channel/${channelId}/customization`,
    ];
  } catch {
    return [];
  }
}

function isCustomizationPage(currentUrl) {
  return /\/(?:customization|editing)(?:[/?#]|$)/i.test(String(currentUrl || ''));
}

async function openStudioSection(page, { text, hrefSelector, stage }, deadline) {
  if (hrefSelector && await clickVisibleLocator(page.locator(hrefSelector), deadline, `${stage}: ссылка`)) {
    await settleStudioPage(page, deadline, `${stage}: ожидание`);
    return true;
  }
  if (await clickVisibleLocator(page.getByRole('link', { name: text }), deadline, `${stage}: пункт меню`)) {
    await settleStudioPage(page, deadline, `${stage}: ожидание`);
    return true;
  }
  if (await clickFirst(page, text, deadline, stage)) {
    await settleStudioPage(page, deadline, `${stage}: ожидание`);
    return true;
  }
  return false;
}

async function openChannelCustomization(page, deadline) {
  if (isCustomizationPage(page.url())) return true;

  // Recent Studio versions expose a direct /editing or /customization link.
  // Prefer it over matching rendered text, because the navigation label can
  // vary by language and the side menu can be collapsed.
  if (await clickVisibleLocator(page.locator(customizationHrefSelector), deadline, 'Открытие настройки канала: ссылка')) {
    await settleStudioPage(page, deadline, 'Ожидание настройки канала');
    if (isCustomizationPage(page.url())) return true;
  }

  const directUrls = customizationUrlsFromCurrentPage(page.url());
  for (const directUrl of directUrls) {
    await withinDeadline(deadline, 'Переход к настройке канала', () => (
      page.goto(directUrl, {
        waitUntil: 'domcontentloaded',
        timeout: stepTimeout(deadline, 'Переход к настройке канала'),
      })
    )).catch(() => {});
    await settleStudioPage(page, deadline, 'Ожидание настройки канала');
    if (isCustomizationPage(page.url())) return true;
  }

  return openStudioSection(page, {
    text: customizationText,
    hrefSelector: customizationHrefSelector,
    stage: 'Открытие настройки канала',
  }, deadline);
}

async function firstVisibleFieldWithAttribute(locator, attributes, pattern, deadline, stage) {
  const count = await withinDeadline(deadline, `${stage}: поиск`, () => locator.count()).catch(() => 0);
  for (let index = 0; index < Math.min(count, MAX_LOCATOR_MATCHES); index += 1) {
    const candidate = locator.nth(index);
    if (!await withinDeadline(deadline, `${stage}: проверка видимости`, () => candidate.isVisible()).catch(() => false)) continue;
    for (const attribute of attributes) {
      const value = await withinDeadline(deadline, `${stage}: чтение поля`, () => candidate.getAttribute(attribute)).catch(() => '');
      if (pattern.test(String(value || ''))) return candidate;
    }
  }
  return null;
}

async function hasChannelProfileControls(page, deadline, stage) {
  const nameInput = await firstVisibleFieldWithAttribute(
    page.locator('input[placeholder]'),
    ['placeholder'],
    channelNamePlaceholder,
    deadline,
    `${stage}: название канала`,
  );
  if (nameInput) return true;
  const description = await firstVisibleFieldWithAttribute(
    page.locator('textarea, [contenteditable="true"]'),
    ['aria-label', 'placeholder'],
    descriptionFieldHint,
    deadline,
    `${stage}: описание канала`,
  );
  if (description) return true;
  return Boolean(await firstVisible(page.locator(fileInputSelector), deadline, `${stage}: файл оформления`));
}

async function openChannelProfileSection(page, deadline, stage) {
  if (await hasChannelProfileControls(page, deadline, stage)) return true;

  const tab = await firstVisible(page.getByRole('tab', { name: profileTabText }), deadline, `${stage}: вкладка «Профиль»`);
  if (tab) {
    await withinDeadline(deadline, `${stage}: открытие вкладки «Профиль»`, () => (
      tab.click({ timeout: stepTimeout(deadline, `${stage}: открытие вкладки «Профиль»`) })
    ));
    await settleStudioPage(page, deadline, `${stage}: ожидание вкладки «Профиль»`);
  }
  return hasChannelProfileControls(page, deadline, stage);
}

async function fillByLabel(page, pattern, value, deadline, stage) {
  if (!value) return false;
  // `value` comes from the explicit task and is only written to a form field;
  // it is never concatenated into a selector.
  const field = await firstVisible(page.getByRole('textbox', { name: pattern }), deadline, stage);
  if (!field) return false;
  await withinDeadline(deadline, `${stage}: заполнение`, () => (
    field.fill(value, { timeout: stepTimeout(deadline, `${stage}: заполнение`) })
  ));
  return true;
}

async function fillChannelName(page, value, deadline) {
  if (!value) return false;
  if (await fillByLabel(page, nameFieldName, value, deadline, 'Название канала')) return true;
  const field = await firstVisibleFieldWithAttribute(
    page.locator('input[placeholder]'),
    ['placeholder'],
    channelNamePlaceholder,
    deadline,
    'Название канала',
  );
  if (!field) return false;
  await withinDeadline(deadline, 'Название канала: заполнение', () => (
    field.fill(value, { timeout: stepTimeout(deadline, 'Название канала: заполнение') })
  ));
  return true;
}

async function fillChannelDescription(page, value, deadline) {
  if (!value) return false;
  if (await fillByLabel(page, descriptionFieldName, value, deadline, 'Описание канала')) return true;
  const field = await firstVisibleFieldWithAttribute(
    page.locator('textarea, [contenteditable="true"]'),
    ['aria-label', 'placeholder'],
    descriptionFieldHint,
    deadline,
    'Описание канала',
  );
  if (!field) return false;
  await withinDeadline(deadline, 'Описание канала: заполнение', () => (
    field.fill(value, { timeout: stepTimeout(deadline, 'Описание канала: заполнение') })
  ));
  return true;
}

async function readLocatorText(locator, deadline, stage) {
  return withinDeadline(deadline, stage, () => (
    locator.innerText({ timeout: stepTimeout(deadline, stage) }).catch(() => '')
  ));
}

async function readLocatorAttribute(locator, attribute, deadline, stage) {
  return withinDeadline(deadline, stage, () => (
    locator.getAttribute(attribute, { timeout: stepTimeout(deadline, stage) }).catch(() => '')
  ));
}

function channelNameFromPageText(pageText) {
  const match = pageText.match(/(?:Ваш\s+канал|Your\s+channel)\s*\n\s*([^\n]+)/i);
  return match?.[1]?.trim() || '';
}

/** Reads channel identity only; it does not alter channel settings. */
export async function inspectChannel({ wsEndpoint, operationTimeoutMs } = {}) {
  return withStudio(wsEndpoint, async (page, deadline) => {
    await withinDeadline(deadline, 'Ожидание загрузки данных канала', () => (
      page.waitForTimeout(Math.min(500, deadline.remaining('Ожидание загрузки данных канала')))
    ));
    const selectorName = await readLocatorText(
      page.locator(channelNameSelector).first(),
      deadline,
      'Чтение названия канала',
    );
    const pageText = await readLocatorText(page.locator('body'), deadline, 'Чтение страницы канала');
    const avatarUrl = await readLocatorAttribute(
      page.locator(channelAvatarSelector).first(),
      'src',
      deadline,
      'Чтение аватара канала',
    );
    const title = await withinDeadline(deadline, 'Чтение заголовка Studio', () => page.title().catch(() => ''));
    const fallbackTitle = title.replace(/\s*[—-]\s*(YouTube Studio|Творческая студия YouTube).*$/i, '').trim();

    return {
      status: 'connected',
      channelName: selectorName.trim() || channelNameFromPageText(pageText) || fallbackTitle,
      avatarUrl: avatarUrl || '',
      url: page.url(),
    };
  }, { operationTimeoutMs });
}

/**
 * Applies branding only for an explicit task passed by the dashboard. This is
 * the sole channel-mutating workflow in this module.
 */
export async function updateChannelBranding({
  wsEndpoint,
  name = '',
  description = '',
  links = [],
  avatarPath = '',
  bannerPath = '',
  operationTimeoutMs,
} = {}) {
  return withStudio(wsEndpoint, async (page, deadline) => {
    const opened = await openChannelCustomization(page, deadline);
    if (loginUrl.test(page.url())) return { status: 'manual-login-required', url: page.url() };
    if (!opened) {
      throw new Error('В YouTube Studio не удалось открыть настройку канала. Проверьте, что выбран именно канал, а не страница с правами доступа.');
    }
    await settleStudioPage(page, deadline, 'Ожидание формы настройки канала');

    const normalizedLinks = Array.isArray(links)
      ? links.filter(link => link?.title && link?.url)
      : [];
    let nameChanged = false;
    let descriptionChanged = false;

    // Channel name, description and external links live in the Basic info
    // section in older Studio, and directly in the Profile editor in newer
    // Studio. Enter a known editor surface before attempting to fill fields;
    // otherwise a hidden dashboard control could make a task look complete.
    if (name || description || normalizedLinks.length) {
      const profileOpened = await openChannelProfileSection(page, deadline, 'Открытие профиля канала');
      if (!profileOpened) {
        const basicInfoOpened = await openStudioSection(page, {
          text: basicInfoText,
          hrefSelector: basicInfoHrefSelector,
          stage: 'Открытие основных сведений',
        }, deadline);
        if (!basicInfoOpened) throw new Error('В YouTube Studio не найдена вкладка «Профиль» или «Основные сведения».');
      }
      nameChanged = await fillChannelName(page, name, deadline);
      descriptionChanged = await fillChannelDescription(page, description, deadline);
      if (name && !nameChanged) throw new Error('YouTube Studio не показала поле названия канала. Изменение не сохранено.');
      if (description && !descriptionChanged) throw new Error('YouTube Studio не показала поле описания канала. Изменение не сохранено.');
    }

    if (avatarPath || bannerPath) {
      const profileOpened = await openChannelProfileSection(page, deadline, 'Открытие профиля для оформления');
      if (!profileOpened) {
        const brandingOpened = await openStudioSection(page, {
          text: brandingText,
          hrefSelector: brandingHrefSelector,
          stage: 'Открытие вкладки брендинга',
        }, deadline);
        if (!brandingOpened) throw new Error('В YouTube Studio не найдена вкладка «Профиль» или «Брендинг».');
        await settleStudioPage(page, deadline, 'Ожидание вкладки брендинга');
      }

      const inputs = page.locator(fileInputSelector);
      const inputCount = await withinDeadline(deadline, 'Поиск полей файлов брендинга', () => inputs.count());
      // File paths are direct form values, not parts of a selector.
      if (avatarPath && inputCount < 1) throw new Error('YouTube Studio не показала поле выбора аватара. Изменение не сохранено.');
      if (bannerPath && inputCount < 2) throw new Error('YouTube Studio не показала поле выбора баннера. Изменение не сохранено.');
      if (avatarPath) {
        await withinDeadline(deadline, 'Выбор аватара канала', () => inputs.nth(0).setInputFiles(avatarPath));
      }
      if (bannerPath) {
        await withinDeadline(deadline, 'Выбор баннера канала', () => inputs.nth(1).setInputFiles(bannerPath));
      }
    }

    let linksAdded = 0;
    if (normalizedLinks.length) {
      for (const link of normalizedLinks) {
        if (!await clickFirst(page, addLinkText, deadline, 'Добавление ссылки')) {
          throw new Error('YouTube Studio не показала кнопку добавления ссылки. Изменение не сохранено.');
        }
        const fields = page.getByRole('textbox');
        const count = await withinDeadline(deadline, 'Поиск полей ссылки', () => fields.count());
        if (count < 2) throw new Error('YouTube Studio не показала поля для новой ссылки. Изменение не сохранено.');
        await withinDeadline(deadline, 'Заполнение названия ссылки', () => (
          fields.nth(count - 2).fill(link.title, { timeout: stepTimeout(deadline, 'Заполнение названия ссылки') })
        ));
        await withinDeadline(deadline, 'Заполнение URL ссылки', () => (
          fields.nth(count - 1).fill(link.url, { timeout: stepTimeout(deadline, 'Заполнение URL ссылки') })
        ));
        linksAdded += 1;
      }
      if (linksAdded !== normalizedLinks.length) throw new Error('Не все ссылки были добавлены в YouTube Studio. Изменение не сохранено.');
    }

    const publish = await firstVisible(page.getByRole('button', { name: publishButtonName }), deadline, 'Поиск сохранения оформления');
    if (!publish) {
      throw new Error('YouTube Studio не показала кнопку сохранения изменений канала.');
    }
    // This click is deliberately restricted to the explicit branding task
    // above. It never participates in upload handling.
    await withinDeadline(deadline, 'Сохранение оформления канала', () => (
      publish.click({ timeout: stepTimeout(deadline, 'Сохранение оформления канала') })
    ));

    return {
      status: 'applied',
      nameChanged,
      descriptionChanged,
      linksAdded,
      url: page.url(),
    };
  }, { operationTimeoutMs });
}
