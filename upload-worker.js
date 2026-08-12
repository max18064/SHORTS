import { connectDolphinCdp } from './dolphin-cdp.js';

const loginUrl = /accounts\.google\.com|ServiceLogin|signin\/v2/i;
const studioUrl = 'https://studio.youtube.com/';

// A browser action should never hold a worker indefinitely if Studio stops
// responding. The value can be tuned for a slow machine/network, while the
// bounds avoid an accidental unbounded wait.
const DEFAULT_OPERATION_TIMEOUT_MS = 90_000;
const MIN_OPERATION_TIMEOUT_MS = 15_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

const createButtonName = /^(?:создать|create)$/i;
const uploadVideoName = /(?:загрузить\s+видео|upload\s+videos?)/i;
const onboardingDialogText = /добро\s+пожаловать.*творческ(?:ая|ую)\s+студи(?:я|ю)|welcome.*youtube\s+studio/i;
const closeButtonName = /^(?:закрыть|close)$/i;
const titleFieldName = /(?:название|title)/i;
const descriptionFieldName = /(?:описание|description)/i;
const tagsFieldName = /(?:теги|tags)/i;

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

async function locatorExists(locator, deadline, stage) {
  return (await withinDeadline(deadline, stage, () => locator.count())) > 0;
}

async function closeCreatedPage(page) {
  await page?.close({ runBeforeUnload: false }).catch(() => {});
}

/**
 * Opens YouTube Studio in an already-running Dolphin profile.
 * It only closes a tab that this function created when opening fails; it never
 * closes an existing user tab or the Dolphin browser profile.
 */
export async function openUploadSession({ wsEndpoint, operationTimeoutMs } = {}, sharedDeadline) {
  const deadline = sharedDeadline || createDeadline(operationTimeoutMs);
  let connection;
  let page;
  let createdPage = false;

  try {
    connection = await withinDeadline(deadline, 'Подключение к Automation API Dolphin', () => (
      connectDolphinCdp(wsEndpoint, { timeoutMs: deadline.remaining('Подключение к Automation API Dolphin') })
    ));
    const { browser } = connection;
    const context = browser.contexts()[0];

    if (!context) {
      throw new Error('В профиле Dolphin не найден контекст браузера.');
    }

    page = context.pages().find(item => /studio\.youtube\.com/i.test(item.url()));
    if (!page) {
      createdPage = true;
      page = await withinDeadline(deadline, 'Открытие вкладки YouTube Studio', () => context.newPage());
    }
    configurePageTimeouts(page, deadline);

    if (!/studio\.youtube\.com/i.test(page.url())) {
      await withinDeadline(deadline, 'Переход в YouTube Studio', () => (
        page.goto(studioUrl, {
          waitUntil: 'domcontentloaded',
          timeout: stepTimeout(deadline, 'Переход в YouTube Studio'),
        })
      ));
    }

    return {
      browser,
      context,
      page,
      needsLogin: loginUrl.test(page.url()),
      operationTimeoutMs: deadline.timeoutMs,
      disconnect: connection.disconnect,
    };
  } catch (error) {
    if (createdPage) await closeCreatedPage(page);
    await connection?.disconnect().catch(() => {});
    throw error;
  }
}

async function dismissOnboarding(page, deadline) {
  const dialog = page.getByRole('dialog').filter({ hasText: onboardingDialogText });
  if (!await locatorExists(dialog, deadline, 'Проверка приветственного окна')) return;

  const close = dialog.getByRole('button', { name: closeButtonName }).first();
  if (await locatorExists(close, deadline, 'Поиск кнопки закрытия приветствия')) {
    await withinDeadline(deadline, 'Закрытие приветственного окна', () => (
      close.click({ timeout: stepTimeout(deadline, 'Закрытие приветственного окна') })
    ));
  }
}

async function fillFirst(page, pattern, value, deadline, stage) {
  if (!value) return false;
  // `value` is only filled into a field; it is never interpolated into a CSS
  // or text selector. This keeps titles/descriptions safe as arbitrary text.
  const field = page.getByRole('textbox', { name: pattern }).first();
  if (!await locatorExists(field, deadline, `Поиск поля «${stage}»`)) return false;
  await withinDeadline(deadline, `Заполнение поля «${stage}»`, () => (
    field.fill(value, { timeout: stepTimeout(deadline, `Заполнение поля «${stage}»`) })
  ));
  return true;
}

/**
 * Opens the YouTube Studio upload form and fills available fields.
 * This worker intentionally has no selector or action for the final publish
 * control: it never publishes a video.
 */
export async function uploadIntoSession({ session, videoPath, title, description = '', tags = [], operationTimeoutMs }, sharedDeadline) {
  if (!session?.page) throw new Error('Сессия YouTube Studio не найдена.');
  const deadline = sharedDeadline || createDeadline(operationTimeoutMs ?? session.operationTimeoutMs);
  const { page } = session;
  configurePageTimeouts(page, deadline);

  if (loginUrl.test(page.url())) {
    return { status: 'manual-login-required', url: page.url() };
  }

  await dismissOnboarding(page, deadline);
  const create = page.getByRole('button', { name: createButtonName }).first();
  if (!await locatorExists(create, deadline, 'Поиск кнопки «Создать»')) {
    throw new Error('В YouTube Studio не найдена кнопка «Создать».');
  }

  await withinDeadline(deadline, 'Открытие меню «Создать»', () => (
    create.click({ timeout: stepTimeout(deadline, 'Открытие меню «Создать»') })
  ));
  const upload = page.getByText(uploadVideoName).first();
  if (!await locatorExists(upload, deadline, 'Поиск пункта «Загрузить видео»')) {
    throw new Error('В меню «Создать» не найден пункт «Загрузить видео».');
  }

  const chooserPromise = withinDeadline(deadline, 'Ожидание выбора файла', () => (
    page.waitForEvent('filechooser', { timeout: stepTimeout(deadline, 'Ожидание выбора файла') })
  ));
  try {
    await withinDeadline(deadline, 'Открытие выбора файла', () => (
      upload.click({ timeout: stepTimeout(deadline, 'Открытие выбора файла') })
    ));
  } catch (error) {
    // The event listener is tied to the current page and will be released when
    // its owner disconnects. Consume its rejection to avoid an unhandled one.
    void chooserPromise.catch(() => {});
    throw error;
  }
  const chooser = await chooserPromise;
  await withinDeadline(deadline, 'Передача файла в YouTube Studio', () => (
    chooser.setFiles(videoPath)
  ));
  await withinDeadline(deadline, 'Ожидание формы загрузки', () => (
    page.waitForTimeout(Math.min(350, deadline.remaining('Ожидание формы загрузки')))
  ));

  const titleChanged = await fillFirst(page, titleFieldName, title, deadline, 'Название');
  const descriptionChanged = await fillFirst(page, descriptionFieldName, description, deadline, 'Описание');
  const tagsChanged = tags.length
    ? await fillFirst(page, tagsFieldName, tags.join(', '), deadline, 'Теги')
    : false;

  return {
    status: 'uploaded-to-form',
    titleChanged,
    descriptionChanged,
    tagsChanged,
    url: page.url(),
  };
}

export async function uploadOwnVideo(options = {}) {
  const deadline = createDeadline(options.operationTimeoutMs);
  const session = await openUploadSession(options, deadline);
  try {
    return await uploadIntoSession({ session, ...options }, deadline);
  } finally {
    await session.disconnect();
  }
}
