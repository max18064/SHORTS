import { connectDolphinCdp } from './dolphin-cdp.js';

const loginUrl = /accounts\.google\.com|ServiceLogin|signin\/v2/i;
const rowSelectors = [
  'ytcp-video-row',
  'ytcp-video-section-content [role="row"]',
  'ytcp-video-section-content tr',
  '[data-testid="video-row"]',
].join(', ');
const DEFAULT_STUDIO_READ_TIMEOUT_MS = 60_000;
const MIN_STUDIO_READ_TIMEOUT_MS = 10_000;
const MAX_STUDIO_READ_TIMEOUT_MS = 180_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeLimit(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, 1), 500) : 100;
}

function safeTimeout(value, fallback = DEFAULT_STUDIO_READ_TIMEOUT_MS) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, MIN_STUDIO_READ_TIMEOUT_MS), MAX_STUDIO_READ_TIMEOUT_MS);
}

function deadlineError(timeoutMs) {
  return new Error(`\u0427\u0442\u0435\u043d\u0438\u0435 YouTube Studio \u043f\u0440\u0435\u0432\u044b\u0441\u0438\u043b\u043e \u043e\u0431\u0449\u0438\u0439 \u043b\u0438\u043c\u0438\u0442 ${Math.ceil(timeoutMs / 1_000)} \u0441\u0435\u043a.`);
}

function contentUrl(currentUrl) {
  try {
    const current = new URL(currentUrl);
    const channel = current.pathname.match(/\/channel\/([^/]+)/i)?.[1];
    if (channel) return `${current.origin}/channel/${channel}/videos`;
  } catch {
    // Use the generic Studio content route below.
  }
  return 'https://studio.youtube.com/videos';
}

async function isLoginPage(page) {
  if (loginUrl.test(page.url())) return true;
  const title = await page.title().catch(() => '');
  return /sign in|\u0432\u043e\u0439\u0442\u0438|google accounts/i.test(title) && /google/i.test(title);
}

async function readRows(page) {
  return page.locator(rowSelectors).evaluateAll(rows => {
    const text = element => (element?.innerText || element?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const absolute = value => {
      try {
        return value ? new URL(value, window.location.href).href : '';
      } catch {
        return value || '';
      }
    };
    const valueAt = (root, selectors) => {
      for (const selector of selectors) {
        const value = text(root.querySelector(selector));
        if (value) return value;
      }
      return '';
    };

    return rows.map(row => {
      const link = row.querySelector('a#video-title, a[href*="/video/"], a[href*="watch"], .video-title a');
      const title = text(link) || valueAt(row, [
        '#video-title', '.video-title', '[id*="video-title"]', '[data-testid="video-title"]',
      ]);
      const url = absolute(link?.getAttribute('href'));
      const all = text(row);
      const views = valueAt(row, ['#views', '[id*="view"]', '[data-testid="views"]', '.views'])
        || (all.match(/([\d\s.,]+\s*(?:\u0442\u044b\u0441\.?|\u043c\u043b\u043d\.?|k|m)?\s*(?:\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440(?:\u0430|\u043e\u0432)?|views?))/i)?.[1] || '');
      const status = valueAt(row, [
        '#visibility', '#video-status', '[id*="visibility"]', '[id*="status"]', '[data-testid="status"]',
      ]);
      const date = valueAt(row, ['#date', '#video-date', '[id*="date"]', '[data-testid="date"]']);
      return { title, url, views, status, date, text: all };
    }).filter(video => video.title && !/^(?:\u0432\u0438\u0434\u0435\u043e|videos|\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435|title)$/i.test(video.title));
  });
}

async function readStudioContent(connection, { limit, deadlineAt, timeoutMs }) {
  const timeRemaining = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError(timeoutMs);
    return remaining;
  };

  const { browser } = connection;
  const context = browser.contexts()[0];
  if (!context) throw new Error('\u0412 \u043f\u0440\u043e\u0444\u0438\u043b\u0435 Dolphin \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430.');

  const page = context.pages().find(item => /studio\.youtube\.com/i.test(item.url()))
    || await context.newPage();
  if (!/studio\.youtube\.com/i.test(page.url())) {
    await page.goto('https://studio.youtube.com/', {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(20_000, timeRemaining()),
    });
  }
  if (await isLoginPage(page)) {
    return { status: 'manual-login-required', url: page.url(), videos: [], total: 0 };
  }

  const target = contentUrl(page.url());
  if (page.url() !== target) {
    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(20_000, timeRemaining()),
    });
  }
  if (await isLoginPage(page)) {
    return { status: 'manual-login-required', url: page.url(), videos: [], total: 0 };
  }

  await page.locator(rowSelectors).first().waitFor({
    state: 'attached',
    timeout: Math.min(8_000, timeRemaining()),
  }).catch(() => {});
  await delay(Math.min(500, timeRemaining()));

  const maximum = safeLimit(limit);
  const unique = new Map();
  let unchangedPasses = 0;
  for (let pass = 0; pass < 25 && unique.size < maximum && unchangedPasses < 3; pass += 1) {
    timeRemaining();
    const before = unique.size;
    for (const video of await readRows(page)) {
      const key = video.url || `${video.title}|${video.date}|${video.views}`;
      if (!unique.has(key)) unique.set(key, video);
      if (unique.size >= maximum) break;
    }
    unchangedPasses = unique.size === before ? unchangedPasses + 1 : 0;
    if (unique.size >= maximum || unchangedPasses >= 3) break;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.8, 700))).catch(() => {});
    await delay(Math.min(350, timeRemaining()));
  }

  return {
    status: 'read',
    url: page.url(),
    videos: [...unique.values()].slice(0, maximum),
    total: unique.size,
  };
}

/**
 * Reads visible YouTube Studio Content rows only. It never uploads, edits,
 * publishes, or deletes anything in the channel. `timeoutMs` (or
 * STUDIO_READ_TIMEOUT_MS) bounds the complete connect-and-read operation.
 */
export async function readStudioVideos({ wsEndpoint, limit = 100, timeoutMs = process.env.STUDIO_READ_TIMEOUT_MS } = {}) {
  if (!wsEndpoint) {
    throw new Error('Dolphin \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b \u0430\u0434\u0440\u0435\u0441 Automation API \u0434\u043b\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f.');
  }

  const totalTimeoutMs = safeTimeout(timeoutMs);
  const deadlineAt = Date.now() + totalTimeoutMs;
  let timedOut = false;
  let connection;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void connection?.disconnect().catch(() => {});
      reject(deadlineError(totalTimeoutMs));
    }, totalTimeoutMs);
  });

  const work = (async () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError(totalTimeoutMs);
    const candidate = await connectDolphinCdp(wsEndpoint, { timeoutMs: remaining });
    if (timedOut || Date.now() >= deadlineAt) {
      await candidate.disconnect().catch(() => {});
      throw deadlineError(totalTimeoutMs);
    }
    connection = candidate;
    return readStudioContent(connection, { limit, deadlineAt, timeoutMs: totalTimeoutMs });
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    timedOut = true;
    clearTimeout(timer);
    await connection?.disconnect().catch(() => {});
  }
}
