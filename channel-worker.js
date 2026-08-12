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
    const opened = await clickFirst(page, customizationText, deadline, 'Открытие настройки канала');
    if (!opened) {
      throw new Error('В YouTube Studio не найдена страница «Настройка канала».');
    }
    await withinDeadline(deadline, 'Ожидание настройки канала', () => (
      page.waitForTimeout(Math.min(700, deadline.remaining('Ожидание настройки канала')))
    ));

    const nameChanged = await fillByLabel(page, nameFieldName, name, deadline, 'Название канала');
    const descriptionChanged = await fillByLabel(page, descriptionFieldName, description, deadline, 'Описание канала');
    const normalizedLinks = Array.isArray(links)
      ? links.filter(link => link?.title && link?.url)
      : [];

    if (avatarPath || bannerPath) {
      const brandingOpened = await clickFirst(page, brandingText, deadline, 'Открытие вкладки брендинга');
      if (!brandingOpened) throw new Error('В YouTube Studio не найдена вкладка «Брендинг».');
      await withinDeadline(deadline, 'Ожидание вкладки брендинга', () => (
        page.waitForTimeout(Math.min(400, deadline.remaining('Ожидание вкладки брендинга')))
      ));

      const inputs = page.locator(fileInputSelector);
      const inputCount = await withinDeadline(deadline, 'Поиск полей файлов брендинга', () => inputs.count());
      // File paths are direct form values, not parts of a selector.
      if (avatarPath && inputCount >= 1) {
        await withinDeadline(deadline, 'Выбор аватара канала', () => inputs.nth(0).setInputFiles(avatarPath));
      }
      if (bannerPath && inputCount >= 2) {
        await withinDeadline(deadline, 'Выбор баннера канала', () => inputs.nth(1).setInputFiles(bannerPath));
      }
    }

    let linksAdded = 0;
    if (normalizedLinks.length) {
      const basicInfoOpened = await clickFirst(page, basicInfoText, deadline, 'Открытие основных сведений');
      if (!basicInfoOpened) throw new Error('В YouTube Studio не найдена вкладка «Основные сведения».');
      for (const link of normalizedLinks) {
        if (!await clickFirst(page, addLinkText, deadline, 'Добавление ссылки')) break;
        const fields = page.getByRole('textbox');
        const count = await withinDeadline(deadline, 'Поиск полей ссылки', () => fields.count());
        if (count < 2) continue;
        await withinDeadline(deadline, 'Заполнение названия ссылки', () => (
          fields.nth(count - 2).fill(link.title, { timeout: stepTimeout(deadline, 'Заполнение названия ссылки') })
        ));
        await withinDeadline(deadline, 'Заполнение URL ссылки', () => (
          fields.nth(count - 1).fill(link.url, { timeout: stepTimeout(deadline, 'Заполнение URL ссылки') })
        ));
        linksAdded += 1;
      }
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
