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
// Keep the primary selectors specific to the channel editor.  A broad
// `/name/` selector can otherwise select a newly-added link title field.
const channelNameFieldName = /(?:\bchannel\s*name\b|\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435\s+\u043a\u0430\u043d\u0430\u043b\u0430)/i;
const channelDescriptionFieldName = /(?:\bchannel\s*description\b|\u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435\s+\u043a\u0430\u043d\u0430\u043b\u0430)/i;
const linkTitleFieldName = /(?:\blink\s*title\b|\btitle\s*(?:of\s*)?link\b|\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435\s+\u0441\u0441\u044b\u043b\u043a\u0438)/i;
const linkUrlFieldName = /(?:\blink\s*(?:url|address)\b|\burl\b|\bwebsite\b|\u0430\u0434\u0440\u0435\u0441\s+\u0441\u0441\u044b\u043b\u043a\u0438|\u0441\u0441\u044b\u043b\u043a\u0430)/i;
const saveSuccessText = /(?:\b(?:changes?|settings?)\s+(?:were\s+)?(?:saved|published|updated)\b|\b(?:published|saved)\b|\u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f\s+(?:\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u044b|\u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u044b)|\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e|\u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u043e)/i;
const channelNameSelector = '#channel-name, ytcp-channel-name, [id="channel-name"]';
const modernChannelNameInputSelector = 'input.ytcpChannelEditingChannelNameFormInput, input[placeholder*="название канала" i], input[placeholder*="channel name" i]';
const channelAvatarSelector = 'ytcp-avatar img, ytcp-channel-avatar img, img[src*="yt3.ggpht.com"], img#img';
const fileInputSelector = 'input[type="file"]';
const modernBrandingFileSelectors = Object.freeze({
  banner: 'ytcp-banner-upload input[type="file"]',
  avatar: 'ytcp-profile-image-upload input[type="file"]',
});
// Playwright's CSS engine follows open shadow roots, which matters for the
// current `/editing/profile` Studio editor. The controls themselves can be
// custom elements, but the native inputs/contenteditables still live below
// those hosts.
const profileTextFieldSelector = 'input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, [contenteditable="true"], [role="textbox"]';
const customizationHrefSelector = 'a[href*="/customization"], a[href*="/editing"], [role="link"][href*="/customization"], [role="link"][href*="/editing"]';
const brandingHrefSelector = 'a[href*="branding"], [role="link"][href*="branding"]';
const basicInfoHrefSelector = 'a[href*="basic"], a[href*="info"], [role="link"][href*="basic"], [role="link"][href*="info"]';
// Studio's current channel editor is a single `/editing/profile` surface in
// some accounts. Keep these ASCII-escaped so the worker remains portable
// through Windows shells with non-UTF-8 console code pages.
const profileTabText = /(?:\u041f\u0440\u043e\u0444\u0438\u043b\u044c|profile)/i;
const channelNamePlaceholder = /(?:\u0423\u043a\u0430\u0436\u0438\u0442\u0435\s+\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435\s+\u043a\u0430\u043d\u0430\u043b\u0430|channel\s+name)/i;
const descriptionFieldHint = /(?:\u041e\u043f\u0438\u0441\u0430\u043d\u0438|description|\u0420\u0430\u0441\u0441\u043a\u0430\u0436\u0438\u0442\u0435\s+\u0430\u0443\u0434\u0438\u0442\u043e\u0440\u0438\u0438|tell\s+viewers)/i;

// Current Studio does not give the file controls a stable positional order.
// These patterns are deliberately based on the control's own accessible
// metadata and its nearest labelled container rather than a file-input index.
// The Russian terms are escaped to keep the worker portable through Windows
// shells that use a non-UTF-8 console code page.
const editorSemanticPatterns = Object.freeze({
  avatar: /(?:\b(?:profile|channel)\s*(?:photo|picture|image|avatar)\b|\bavatar\b|\u0444\u043e\u0442\u043e\s*(?:\u043f\u0440\u043e\u0444\u0438\u043b\u044f|\u043a\u0430\u043d\u0430\u043b\u0430)|\u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\s*(?:\u043f\u0440\u043e\u0444\u0438\u043b\u044f|\u043a\u0430\u043d\u0430\u043b\u0430)|\u0430\u0432\u0430\u0442\u0430\u0440)/i,
  banner: /(?:\b(?:channel\s*)?(?:banner|art|header|cover)\b|\u0431\u0430\u043d\u043d\u0435\u0440|\u0448\u0430\u043f\u043a\u0430\s*\u043a\u0430\u043d\u0430\u043b\u0430|\u0438\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435\s*\u0431\u0430\u043d\u043d\u0435\u0440\u0430)/i,
  watermark: /(?:\bwatermark\b|\u0432\u043e\u0434\u044f\u043d\u043e\u0439\s*\u0437\u043d\u0430\u043a)/i,
  name: /(?:\b(?:channel\s*)?name\b|\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435(?:\s*\u043a\u0430\u043d\u0430\u043b\u0430)?)/i,
  description: /(?:\b(?:channel\s*)?description\b|\u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435(?:\s*\u043a\u0430\u043d\u0430\u043b\u0430)?|\u0440\u0430\u0441\u0441\u043a\u0430\u0436\u0438\u0442\u0435\s+\u0430\u0443\u0434\u0438\u0442\u043e\u0440\u0438\u0438)/i,
});

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

async function withStudio(wsEndpoint, callback, {
  operationTimeoutMs,
  useOwnedPage = false,
} = {}) {
  if (!wsEndpoint) {
    throw new Error('Dolphin не вернул адрес автоматизации профиля.');
  }

  const deadline = createDeadline(operationTimeoutMs);
  let connection;
  let page;
  let createdPage = false;
  let keepCreatedPage = false;
  try {
    connection = await withinDeadline(deadline, 'Подключение к Automation API Dolphin', () => (
      connectDolphinCdp(wsEndpoint, { timeoutMs: deadline.remaining('Подключение к Automation API Dolphin') })
    ));
    const { browser } = connection;
    const context = browser.contexts()[0];
    if (!context) throw new Error('В профиле Dolphin не найден контекст браузера.');

    // Mutating work gets its own tab. It must never navigate away from a
    // Studio tab where the user may have an upload or another draft open.
    page = useOwnedPage ? null : context.pages().find(item => studioPageMatcher.test(item.url()));
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
      keepCreatedPage = true;
      return { status: 'manual-login-required', url: page.url() };
    }
    const result = await withinDeadline(deadline, 'Работа с YouTube Studio', () => callback(page, deadline));
    if (result?.status === 'manual-login-required') keepCreatedPage = true;
    return result;
  } finally {
    // This worker owns only the tab it created. Existing user tabs stay intact.
    if (createdPage && !keepCreatedPage) {
      await closeCreatedPage(page);
    }
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

function trustedStudioEditorUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'studio.youtube.com') return '';
    if (!/\/channel\/[^/?#]+\/(?:editing|customization)(?:[/?#]|$)/i.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
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

function normalizedEditorValue(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

function editorValuesMatch(actual, expected) {
  return normalizedEditorValue(actual) === normalizedEditorValue(expected);
}

async function describeEditorControl(locator, deadline, stage) {
  try {
    return await withinDeadline(deadline, stage, () => locator.evaluate(element => {
      const segments = [];
      const seen = new Set();
      const add = value => {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        // A local card should be small. Bound it so a high-level container
        // cannot accidentally contribute labels for several other controls.
        segments.push(text.slice(0, 1_200));
      };
      const elementText = node => String(node?.innerText || node?.textContent || '');
      const attributes = node => [
        node?.getAttribute?.('aria-label'),
        node?.getAttribute?.('aria-description'),
        node?.getAttribute?.('placeholder'),
        node?.getAttribute?.('title'),
        node?.getAttribute?.('name'),
        node?.getAttribute?.('id'),
        node?.getAttribute?.('data-testid'),
        node?.getAttribute?.('data-qa'),
        node?.getAttribute?.('class'),
      ].filter(Boolean).join(' ');
      const root = element.getRootNode?.();
      const findById = id => root?.getElementById?.(id)
        || root?.querySelector?.(`#${CSS.escape(id)}`)
        || document.getElementById(id);

      add(attributes(element));
      for (const label of Array.from(element.labels || [])) add(elementText(label));
      const wrappingLabel = element.closest?.('label');
      if (wrappingLabel) add(elementText(wrappingLabel));
      for (const id of String(element.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        add(elementText(findById(id)));
      }

      let current = element;
      for (let depth = 0; current && depth < 6; depth += 1) {
        if (current === document.body || current === document.documentElement) break;
        add(attributes(current));
        add(elementText(current));
        const currentRoot = current.getRootNode?.();
        current = current.parentElement || currentRoot?.host || null;
      }

      return {
        segments,
        value: 'value' in element ? String(element.value || '') : String(element.textContent || ''),
      };
    }));
  } catch {
    return null;
  }
}

function semanticScore(descriptor, semantic) {
  const target = editorSemanticPatterns[semantic];
  if (!target || !descriptor?.segments?.length) return 0;
  let score = 0;
  for (const [index, segment] of descriptor.segments.entries()) {
    const weight = Math.max(12, 100 - index * 15);
    if (target.test(segment)) score += weight;
    for (const [otherSemantic, otherPattern] of Object.entries(editorSemanticPatterns)) {
      if (otherSemantic !== semantic && otherPattern.test(segment)) score -= Math.floor(weight / 3);
    }
  }
  return score;
}

async function isUsableEditorControl(locator, deadline, stage, { editable = false, visible = true } = {}) {
  if (visible && !await withinDeadline(deadline, `${stage}: visibility`, () => locator.isVisible()).catch(() => false)) {
    return false;
  }
  if (editable && !await withinDeadline(deadline, `${stage}: editable`, () => locator.isEditable()).catch(() => false)) {
    return false;
  }
  return true;
}

async function findSemanticEditorControl(page, selector, semantic, deadline, stage, {
  editable = false,
  visible = true,
  minimumScore = 25,
  ambiguityGap = 15,
} = {}) {
  const controls = page.locator(selector);
  const count = await withinDeadline(deadline, `${stage}: search`, () => controls.count()).catch(() => 0);
  const matches = [];
  for (let index = 0; index < Math.min(count, MAX_LOCATOR_MATCHES); index += 1) {
    const locator = controls.nth(index);
    if (!await isUsableEditorControl(locator, deadline, `${stage}: control`, { editable, visible })) continue;
    const descriptor = await describeEditorControl(locator, deadline, `${stage}: inspect control`);
    const score = semanticScore(descriptor, semantic);
    if (score >= minimumScore) matches.push({ locator, descriptor, score });
  }
  matches.sort((left, right) => right.score - left.score);
  if (!matches.length) return { locator: null, reason: 'not-found' };
  if (matches.length > 1 && (matches[0].score - matches[1].score) < ambiguityGap) {
    return { locator: null, reason: 'ambiguous' };
  }
  return { locator: matches[0].locator, descriptor: matches[0].descriptor, reason: null };
}

async function hasCurrentProfileEditorSurface(page, deadline, stage) {
  if (/\/editing\/profile(?:[/?#]|$)/i.test(page.url())) return true;
  const name = await firstVisibleFieldWithAttribute(
    page.locator('input[placeholder]'),
    ['placeholder'],
    channelNamePlaceholder,
    deadline,
    `${stage}: current name field`,
  );
  if (name) return true;
  const description = await firstVisibleFieldWithAttribute(
    page.locator('textarea, [contenteditable="true"], [role="textbox"]'),
    ['aria-label', 'placeholder'],
    descriptionFieldHint,
    deadline,
    `${stage}: current description field`,
  );
  return Boolean(description);
}

async function waitForLocatorCount(page, locator, deadline, stage, { maximumWaitMs = 3_000 } = {}) {
  const expiresAt = Date.now() + Math.min(maximumWaitMs, deadline.remaining(`${stage}: wait`));
  let count = 0;
  while (Date.now() < expiresAt) {
    count = await withinDeadline(deadline, stage, () => locator.count()).catch(() => 0);
    if (count) return count;
    await withinDeadline(deadline, `${stage}: wait`, () => (
      page.waitForTimeout(Math.min(250, deadline.remaining(`${stage}: wait`)))
    ));
  }
  return count;
}

async function findBrandingFileInput(page, semantic, deadline, stage) {
  // These are the current Studio component hosts observed on the Profile
  // editor. They are stronger than a generic score and deliberately exclude
  // the separate ytcp-video-watermark-upload control.
  if (await hasCurrentProfileEditorSurface(page, deadline, stage)) {
    const directSelector = modernBrandingFileSelectors[semantic];
    const direct = page.locator(directSelector);
    const directCount = await waitForLocatorCount(page, direct, deadline, `${stage}: modern control`);
    if (directCount === 1) return direct.first();
    if (directCount > 1) {
      throw new Error(`YouTube Studio exposed more than one ${semantic} image field. Nothing was saved.`);
    }
  }
  const semanticMatch = await findSemanticEditorControl(page, fileInputSelector, semantic, deadline, stage, {
    // Native file inputs are frequently visually hidden behind Studio's
    // upload button, so their surrounding label semantics are authoritative.
    visible: false,
    minimumScore: 25,
    ambiguityGap: 20,
  });
  if (semanticMatch.locator) return semanticMatch.locator;

  // The legacy customisation surface had stable avatar/banner ordering. Never
  // use that convention on the modern Profile editor: an added watermark
  // input (or a UI experiment) could otherwise send a file to the wrong slot.
  if (await hasCurrentProfileEditorSurface(page, deadline, stage)) {
    const reason = semanticMatch.reason === 'ambiguous' ? 'more than one matching field' : 'no matching field';
    throw new Error(`YouTube Studio exposed ${reason} for the ${semantic} image. Nothing was saved.`);
  }

  const legacyInputs = page.locator(fileInputSelector);
  const count = await withinDeadline(deadline, `${stage}: legacy controls`, () => legacyInputs.count());
  const legacyIndex = semantic === 'avatar' ? 0 : 1;
  if (count <= legacyIndex) {
    throw new Error(`YouTube Studio did not expose a ${semantic} image field. Nothing was saved.`);
  }
  return legacyInputs.nth(legacyIndex);
}

async function hasChannelProfileControls(page, deadline, stage) {
  if (await hasCurrentProfileEditorSurface(page, deadline, stage)) return true;
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
  return fillAndVerifyEditorField(field, value, deadline, stage);
}

async function fillAndVerifyEditorField(field, value, deadline, stage) {
  await withinDeadline(deadline, `${stage}: заполнение`, () => (
    field.fill(value, { timeout: stepTimeout(deadline, `${stage}: заполнение`) })
  ));
  const actual = await readLocatorFormValue(field, deadline, `${stage}: проверка значения`);
  if (!editorValuesMatch(actual, value)) {
    throw new Error(`YouTube Studio did not confirm the ${stage} value. Nothing was saved.`);
  }
  return true;
}

async function fillChannelName(page, value, deadline) {
  if (!value) return false;
  const field = await findChannelTextEditor(page, 'name', deadline, 'Название канала');
  return field ? fillAndVerifyEditorField(field, value, deadline, 'Название канала') : false;
}

async function fillChannelDescription(page, value, deadline) {
  if (!value) return false;
  const field = await findChannelTextEditor(page, 'description', deadline, 'Описание канала');
  return field ? fillAndVerifyEditorField(field, value, deadline, 'Описание канала') : false;
}

async function findChannelTextEditor(page, semantic, deadline, stage) {
  const expiresAt = Date.now() + Math.min(8_000, deadline.remaining(`${stage}: wait for editor`));
  while (Date.now() < expiresAt) {
    const field = await findChannelTextEditorOnce(page, semantic, deadline, stage);
    if (field) return field;
    await withinDeadline(deadline, `${stage}: wait for editor`, () => (
      page.waitForTimeout(Math.min(250, deadline.remaining(`${stage}: wait for editor`)))
    ));
  }
  return null;
}

async function findChannelTextEditorOnce(page, semantic, deadline, stage) {
  const labelPattern = semantic === 'name' ? channelNameFieldName : channelDescriptionFieldName;
  const placeholderPattern = semantic === 'name' ? channelNamePlaceholder : descriptionFieldHint;
  const primarySelector = semantic === 'name'
    ? modernChannelNameInputSelector
    : 'textarea, [contenteditable="true"], [role="textbox"]';
  const byLabel = await firstVisible(page.getByRole('textbox', { name: labelPattern }), deadline, `${stage}: labelled field`);
  if (byLabel) return byLabel;
  const byPlaceholder = await firstVisibleFieldWithAttribute(
    page.locator(primarySelector),
    ['aria-label', 'placeholder'],
    placeholderPattern,
    deadline,
    `${stage}: hinted field`,
  );
  if (byPlaceholder) return byPlaceholder;
  const semanticField = await findSemanticEditorControl(
    page,
    profileTextFieldSelector,
    semantic,
    deadline,
    `${stage}: semantic field`,
    { editable: true, visible: true },
  );
  return semanticField.locator;
}

async function verifyChannelEditorValue(page, semantic, expected, deadline) {
  if (!expected) return;
  const label = semantic === 'name' ? 'Название канала' : 'Описание канала';
  const field = await findChannelTextEditor(page, semantic, deadline, `${label}: final verification`);
  if (!field) throw new Error(`YouTube Studio did not retain the ${label} field. Nothing was saved.`);
  const actual = await readLocatorFormValue(field, deadline, `${label}: final value`);
  if (!editorValuesMatch(actual, expected)) {
    throw new Error(`YouTube Studio did not retain the ${label} value. Nothing was saved.`);
  }
}

async function visibleEditableTextboxes(page, namePattern, deadline, stage) {
  const fields = page.getByRole('textbox', { name: namePattern });
  const count = await withinDeadline(deadline, `${stage}: search`, () => fields.count()).catch(() => 0);
  const result = [];
  for (let index = 0; index < Math.min(count, MAX_LOCATOR_MATCHES); index += 1) {
    const field = fields.nth(index);
    if (await isUsableEditorControl(field, deadline, `${stage}: field`, { editable: true, visible: true })) {
      result.push(field);
    }
  }
  return result;
}

async function waitForNewLinkFields(page, beforeTitleCount, beforeUrlCount, deadline) {
  const expiresAt = Date.now() + Math.min(10_000, deadline.remaining('Waiting for a new channel link'));
  while (Date.now() < expiresAt) {
    const titles = await visibleEditableTextboxes(page, linkTitleFieldName, deadline, 'New link title');
    const urls = await visibleEditableTextboxes(page, linkUrlFieldName, deadline, 'New link URL');
    if (titles.length > beforeTitleCount && urls.length > beforeUrlCount) {
      // Studio appends a new link card. We only use controls whose own
      // accessible name identifies it as a link title or link URL.
      return { title: titles[beforeTitleCount], url: urls[beforeUrlCount] };
    }
    await withinDeadline(deadline, 'Waiting for a new channel link', () => (
      page.waitForTimeout(Math.min(250, deadline.remaining('Waiting for a new channel link')))
    ));
  }
  throw new Error('YouTube Studio did not expose a labelled title and URL field for the new link. Nothing was saved.');
}

async function addAndVerifyChannelLinks(page, links, deadline) {
  let added = 0;
  for (const link of links) {
    const previousTitles = await visibleEditableTextboxes(page, linkTitleFieldName, deadline, 'Existing link titles');
    const previousUrls = await visibleEditableTextboxes(page, linkUrlFieldName, deadline, 'Existing link URLs');
    if (!await clickFirst(page, addLinkText, deadline, 'Adding a channel link')) {
      throw new Error('YouTube Studio did not expose the control for adding a channel link. Nothing was saved.');
    }
    const fields = await waitForNewLinkFields(page, previousTitles.length, previousUrls.length, deadline);
    await fillAndVerifyEditorField(fields.title, link.title, deadline, 'Channel link title');
    await fillAndVerifyEditorField(fields.url, link.url, deadline, 'Channel link URL');
    added += 1;
  }
  return added;
}

async function verifyChannelLinks(page, links, deadline) {
  if (!links.length) return;
  const titleFields = await visibleEditableTextboxes(page, linkTitleFieldName, deadline, 'Saved link titles');
  const urlFields = await visibleEditableTextboxes(page, linkUrlFieldName, deadline, 'Saved link URLs');
  const pairs = [];
  for (let index = 0; index < Math.min(titleFields.length, urlFields.length); index += 1) {
    const [title, url] = await Promise.all([
      readLocatorFormValue(titleFields[index], deadline, 'Saved link title value'),
      readLocatorFormValue(urlFields[index], deadline, 'Saved link URL value'),
    ]);
    pairs.push({ title, url });
  }
  for (const link of links) {
    if (!pairs.some(pair => editorValuesMatch(pair.title, link.title) && editorValuesMatch(pair.url, link.url))) {
      throw new Error(`YouTube Studio did not retain channel link “${link.title}”. Nothing was saved.`);
    }
  }
}

async function readStudioSaveSignal(page, deadline) {
  const feedback = page.locator('[role="alert"], [role="status"], [aria-live], ytcp-toast, tp-yt-paper-toast');
  const count = await withinDeadline(deadline, 'Reading Studio save feedback', () => feedback.count()).catch(() => 0);
  for (let index = 0; index < Math.min(count, MAX_LOCATOR_MATCHES); index += 1) {
    const item = feedback.nth(index);
    if (!await withinDeadline(deadline, 'Checking Studio save feedback', () => item.isVisible()).catch(() => false)) continue;
    const message = await readLocatorText(item, deadline, 'Reading Studio save feedback text');
    if (saveSuccessText.test(message)) return message;
  }
  return '';
}

async function waitForStudioSaveSignal(page, deadline) {
  const expiresAt = Date.now() + Math.min(10_000, deadline.remaining('Waiting for Studio save confirmation'));
  while (Date.now() < expiresAt) {
    const message = await readStudioSaveSignal(page, deadline);
    if (message) return message;
    const publish = await firstVisible(page.getByRole('button', { name: publishButtonName }), deadline, 'Checking publish button');
    if (!publish) return 'publish-control-cleared';
    const disabled = await withinDeadline(deadline, 'Checking publish button state', () => publish.isDisabled()).catch(() => false);
    const ariaDisabled = await readLocatorAttribute(publish, 'aria-disabled', deadline, 'Reading publish button state');
    if (disabled || ariaDisabled === 'true') return 'publish-control-cleared';
    await withinDeadline(deadline, 'Waiting for Studio save confirmation', () => (
      page.waitForTimeout(Math.min(300, deadline.remaining('Waiting for Studio save confirmation')))
    ));
  }
  return '';
}

async function reloadAndOpenChannelProfile(page, deadline) {
  await withinDeadline(deadline, 'Reloading saved channel settings', () => (
    page.reload({ waitUntil: 'domcontentloaded', timeout: stepTimeout(deadline, 'Reloading saved channel settings') })
  ));
  if (loginUrl.test(page.url())) return false;
  if (!await openChannelCustomization(page, deadline)) return false;
  await settleStudioPage(page, deadline, 'Waiting for reloaded channel settings');
  return openChannelProfileSection(page, deadline, 'Opening reloaded channel profile');
}

async function setAndVerifyBrandingFile(input, filePath, deadline, stage) {
  await withinDeadline(deadline, stage, () => input.setInputFiles(filePath));
  const expectedName = String(filePath).split(/[\\/]/).pop();
  const actualName = await withinDeadline(deadline, `${stage}: verification`, () => input.evaluate(element => (
    element.files?.[0]?.name || ''
  )).catch(() => ''));
  if (!actualName || actualName !== expectedName) {
    throw new Error(`YouTube Studio did not confirm the selected ${stage} file. Nothing was saved.`);
  }
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

async function readLocatorFormValue(locator, deadline, stage) {
  return withinDeadline(deadline, stage, () => (
    locator.evaluate(element => {
      if ('value' in element) return String(element.value || '');
      return String(element.textContent || '');
    }).catch(() => '')
  ));
}

async function readCurrentEditorChannelName(page, deadline) {
  const field = await findChannelTextEditor(page, 'name', deadline, 'Чтение поля названия канала');
  return field ? readLocatorFormValue(field, deadline, 'Чтение значения названия канала') : '';
}

function channelNameFromPageText(pageText) {
  const match = pageText.match(/(?:Ваш\s+канал|Your\s+channel)\s*\n\s*([^\n]+)/i);
  return match?.[1]?.trim() || '';
}

/** Reads channel identity only; it does not alter channel settings. */
export async function inspectChannel({ wsEndpoint, channelUrl = '', operationTimeoutMs } = {}) {
  return withStudio(wsEndpoint, async (page, deadline) => {
    const directEditorUrl = trustedStudioEditorUrl(channelUrl);
    if (directEditorUrl) {
      await withinDeadline(deadline, 'Opening cached channel profile for read-only inspection', () => (
        page.goto(directEditorUrl, {
          waitUntil: 'domcontentloaded',
          timeout: stepTimeout(deadline, 'Opening cached channel profile for read-only inspection'),
        })
      ));
      await settleStudioPage(page, deadline, 'Waiting for cached channel profile');
    }
    const opened = await openChannelCustomization(page, deadline);
    if (loginUrl.test(page.url())) return { status: 'manual-login-required', url: page.url() };
    const editorOpened = opened && await openChannelProfileSection(page, deadline, 'Opening channel profile for read-only inspection');
    const editorName = editorOpened ? await readCurrentEditorChannelName(page, deadline) : '';
    const selectorName = await readLocatorText(
      page.locator(channelNameSelector).first(),
      deadline,
      'Чтение названия канала',
    );
    const avatarUrl = await readLocatorAttribute(
      page.locator(channelAvatarSelector).first(),
      'src',
      deadline,
      'Чтение аватара канала',
    );
    return {
      status: 'connected',
      // Do not guess a channel name from a Google-profile header or browser
      // title. The explicit editor field is authoritative; the legacy
      // selector is retained solely for older Studio pages.
      channelName: editorName.trim() || selectorName.trim() || '',
      channelNameVerified: Boolean(editorName.trim()),
      avatarUrl: avatarUrl || '',
      url: page.url(),
    };
  }, { operationTimeoutMs, useOwnedPage: true });
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

      // Resolve all inputs before changing either field. The current
      // `/editing/profile` surface can expose avatar, banner and watermark
      // inputs in an arbitrary order, so nth(0)/nth(1) is unsafe here.
      const avatarInput = avatarPath
        ? await findBrandingFileInput(page, 'avatar', deadline, 'Поиск поля аватара')
        : null;
      const bannerInput = bannerPath
        ? await findBrandingFileInput(page, 'banner', deadline, 'Поиск поля баннера')
        : null;
      // File paths are direct form values, not parts of a selector.
      if (avatarPath) {
        await setAndVerifyBrandingFile(avatarInput, avatarPath, deadline, 'Выбор аватара канала');
      }
      if (bannerPath) {
        await setAndVerifyBrandingFile(bannerInput, bannerPath, deadline, 'Выбор баннера канала');
      }
    }

    const linksAdded = normalizedLinks.length
      ? await addAndVerifyChannelLinks(page, normalizedLinks, deadline)
      : 0;

    // Re-read the values immediately before the one save action. This catches
    // a UI re-render (for example after image cropping) that silently dropped
    // a field after it had initially accepted the value.
    await verifyChannelEditorValue(page, 'name', name, deadline);
    await verifyChannelEditorValue(page, 'description', description, deadline);

    const publish = await firstVisible(page.getByRole('button', { name: publishButtonName }), deadline, 'Поиск сохранения оформления');
    if (!publish) {
      throw new Error('YouTube Studio не показала кнопку сохранения изменений канала.');
    }
    const publishDisabled = await withinDeadline(deadline, 'Проверка готовности сохранения', () => publish.isDisabled()).catch(() => false);
    const publishAriaDisabled = await readLocatorAttribute(publish, 'aria-disabled', deadline, 'Проверка готовности сохранения');
    if (publishDisabled || publishAriaDisabled === 'true') {
      throw new Error('YouTube Studio не отметила изменения как готовые к публикации. Задача не отмечена выполненной.');
    }
    // This click is deliberately restricted to the explicit branding task
    // above. It never participates in upload handling.
    await withinDeadline(deadline, 'Сохранение оформления канала', () => (
      publish.click({ timeout: stepTimeout(deadline, 'Сохранение оформления канала') })
    ));

    // A form accepting a value is not proof that Studio saved it. First wait
    // for Studio feedback/state, then reload the editor and read the actual
    // persisted values back from the server-rendered page.
    const saveSignal = await waitForStudioSaveSignal(page, deadline);
    const reloaded = await reloadAndOpenChannelProfile(page, deadline);
    if (!reloaded) {
      throw new Error('YouTube Studio did not reopen the saved channel profile. Save was not confirmed.');
    }
    await verifyChannelEditorValue(page, 'name', name, deadline);
    await verifyChannelEditorValue(page, 'description', description, deadline);
    await verifyChannelLinks(page, normalizedLinks, deadline);
    // Studio does not expose the selected local filename after a reload. For
    // image-only tasks, require an explicit Studio save signal rather than
    // reporting success based only on input.files before Publish.
    if ((avatarPath || bannerPath) && !saveSignal) {
      throw new Error('YouTube Studio did not confirm saving the selected channel image. Nothing was marked complete.');
    }

    return {
      status: 'applied',
      nameChanged,
      descriptionChanged,
      linksAdded,
      saveConfirmed: true,
      saveSignal: saveSignal || 'reloaded-profile-values',
      avatarSelectionConfirmed: Boolean(avatarPath),
      bannerSelectionConfirmed: Boolean(bannerPath),
      url: page.url(),
    };
  }, { operationTimeoutMs, useOwnedPage: true });
}
