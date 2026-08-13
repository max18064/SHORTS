import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This test never reaches Dolphin, YouTube, or a user browser profile. It
// imports a temporary copy of the worker with its semantic helpers exposed,
// then drives those helpers against a minimal DOM-shaped fixture. Keeping the
// production worker unmodified makes this a regression guard, not a second
// implementation of the picker.
const workerPath = path.resolve('channel-worker.js');
const workerSource = await fs.readFile(workerPath, 'utf8');
const temporaryModulePath = path.join(
  os.tmpdir(),
  `creator-flow-channel-profile-fixture-${process.pid}-${Date.now()}.mjs`,
);
const temporaryAssetPath = path.join(
  os.tmpdir(),
  `creator-flow-channel-profile-fixture-${process.pid}-${Date.now()}.png`,
);

class FixtureContainer {
  constructor(text, parentElement = null) {
    this.innerText = text;
    this.textContent = text;
    this.parentElement = parentElement;
  }

  getAttribute() {
    return null;
  }

  getRootNode() {
    return null;
  }
}

class FixtureElement {
  constructor({ id, type = 'text', label, placeholder = '', value = '', role = '', visible = true }) {
    this.id = id;
    this.type = type;
    this.value = value;
    this.visible = visible;
    this.files = [];
    this._attributes = {
      id,
      type,
      placeholder,
      role,
    };
    this.labels = label ? [{ innerText: label, textContent: label }] : [];
    this.parentElement = new FixtureContainer(label || 'Image asset');
    this.innerText = '';
    this.textContent = '';
  }

  getAttribute(name) {
    return this._attributes[name] || null;
  }

  getRootNode() {
    return null;
  }

  closest() {
    return null;
  }
}

class FixtureLocator {
  constructor(items) {
    this.items = items.filter(Boolean);
  }

  async count() {
    return this.items.length;
  }

  nth(index) {
    return new FixtureLocator([this.items[index]]);
  }

  async isVisible() {
    return Boolean(this.items[0]?.visible);
  }

  async getAttribute(name) {
    return this.items[0]?.getAttribute(name) || null;
  }

  async evaluate(callback) {
    if (!this.items[0]) throw new Error('Fixture locator has no element.');
    return callback(this.items[0]);
  }

  async fill(value) {
    if (!this.items[0]) throw new Error('Fixture locator has no element.');
    this.items[0].value = String(value);
  }

  async setInputFiles(filePath) {
    if (!this.items[0]) throw new Error('Fixture locator has no element.');
    this.items[0].files = [{ name: path.basename(filePath) }];
  }
}

class ProfileDomFixture {
  constructor(elements) {
    this.elements = elements;
    this.currentUrl = 'http://fixture.local/channel/UC_fixture/editing/profile';
  }

  url() {
    return this.currentUrl;
  }

  locator(selector) {
    if (selector === 'input[type="file"]') {
      return new FixtureLocator(this.elements.filter(element => element.type === 'file'));
    }
    if (selector.includes('input[placeholder]')) {
      return new FixtureLocator(this.elements.filter(element => element.type === 'text' && element.getAttribute('placeholder')));
    }
    if (selector.includes('textarea') || selector.includes('[contenteditable') || selector.includes('[role="textbox"]')) {
      return new FixtureLocator(this.elements.filter(element => element.type === 'textarea' || element.getAttribute('role') === 'textbox'));
    }
    if (selector.includes('input:not')) {
      return new FixtureLocator(this.elements.filter(element => element.type === 'text' || element.type === 'textarea' || element.getAttribute('role') === 'textbox'));
    }
    return new FixtureLocator([]);
  }

  getByRole(role, { name } = {}) {
    if (role !== 'textbox') return new FixtureLocator([]);
    const items = this.elements.filter(element => {
      if (!(element.type === 'text' || element.type === 'textarea' || element.getAttribute('role') === 'textbox')) return false;
      if (!name) return true;
      const label = element.labels.map(item => item.innerText).join(' ');
      return name instanceof RegExp ? name.test(label) : label === name;
    });
    return new FixtureLocator(items);
  }
}

function modernProfileFixture({ duplicateAvatar = false, unnamedAvatar = false } = {}) {
  // The intentional order matches the observed modern Studio page: banner,
  // avatar, then watermark. Tests prove the worker does not use that order.
  const avatar = new FixtureElement({
    id: unnamedAvatar ? 'image-asset' : 'avatar',
    type: 'file',
    label: unnamedAvatar ? 'Image asset' : 'Profile photo',
  });
  const elements = [
    new FixtureElement({ id: 'banner', type: 'file', label: 'Channel banner' }),
    avatar,
  ];
  if (duplicateAvatar) {
    elements.push(new FixtureElement({ id: 'avatar-second', type: 'file', label: 'Profile photo' }));
  }
  elements.push(
    new FixtureElement({ id: 'watermark', type: 'file', label: 'Video watermark' }),
    new FixtureElement({ id: 'channel-name', label: 'Channel name', placeholder: 'Channel name', value: 'Before fixture' }),
    new FixtureElement({ id: 'channel-description', type: 'textarea', label: 'Channel description', placeholder: 'Description' }),
  );
  return new ProfileDomFixture(elements);
}

function assertWorkerSafetyContract(source) {
  assert.match(source, /\/editing\/profile/, 'Current Studio Profile route must remain supported.');
  assert.match(source, /function findBrandingFileInput\(/, 'Image selection must be centralized.');
  assert.match(source, /findSemanticEditorControl\(page, fileInputSelector, semantic/, 'Modern image fields must be selected semantically.');
  assert.match(source, /setAndVerifyBrandingFile\(/, 'Image selection must be read back before saving.');
  assert.match(source, /verifyChannelEditorValue\(page, 'name', name/, 'Channel name must be re-read before saving.');
  assert.match(source, /verifyChannelEditorValue\(page, 'description', description/, 'Channel description must be re-read before saving.');

  const modernGuard = source.indexOf('if (await hasCurrentProfileEditorSurface(page, deadline, stage))');
  const legacyFallback = source.indexOf("const legacyIndex = semantic === 'avatar' ? 0 : 1;");
  assert.ok(modernGuard >= 0 && legacyFallback > modernGuard, 'Positional image fallback must stay behind the modern-editor guard.');

  const firstNameVerification = source.indexOf("await verifyChannelEditorValue(page, 'name', name, deadline);");
  const firstDescriptionVerification = source.indexOf("await verifyChannelEditorValue(page, 'description', description, deadline);");
  const publish = source.indexOf('const publish =', firstDescriptionVerification);
  assert.ok(firstNameVerification >= 0 && firstDescriptionVerification >= 0 && publish > firstDescriptionVerification, 'Both fields must be verified before Publish is clicked.');

  const reload = source.indexOf('const reloaded = await reloadAndOpenChannelProfile', publish);
  const savedNameVerification = source.indexOf("await verifyChannelEditorValue(page, 'name', name, deadline);", reload);
  const savedDescriptionVerification = source.indexOf("await verifyChannelEditorValue(page, 'description', description, deadline);", reload);
  assert.ok(reload > publish && savedNameVerification > reload && savedDescriptionVerification > reload, 'Saved channel fields must be re-read after reload.');
}

async function importFixtureWorker() {
  // The worker has a relative local import. Replace only that specifier in a
  // temporary module, then expose the existing private helpers to this test.
  const cdpUrl = pathToFileURL(path.resolve('dolphin-cdp.js')).href;
  const fixtureSource = `${workerSource.replace("from './dolphin-cdp.js'", `from '${cdpUrl}'`)}\nexport { createDeadline, describeEditorControl, findBrandingFileInput, findChannelTextEditor, findSemanticEditorControl, setAndVerifyBrandingFile, verifyChannelEditorValue };\n`;
  await fs.writeFile(temporaryModulePath, fixtureSource, 'utf8');
  return import(`${pathToFileURL(temporaryModulePath).href}?fixture=${Date.now()}`);
}

assertWorkerSafetyContract(workerSource);
await fs.writeFile(temporaryAssetPath, 'fixture-image', 'utf8');
const priorDocument = globalThis.document;
globalThis.document = {
  body: new FixtureContainer(''),
  documentElement: new FixtureContainer(''),
  getElementById: () => null,
};

try {
  const fixtureWorker = await importFixtureWorker();
  const deadline = () => fixtureWorker.createDeadline(15_000);

  let page = modernProfileFixture();
  assert.ok((await fixtureWorker.describeEditorControl(page.locator('input[type="file"]').nth(1), deadline(), 'fixture descriptor')).segments.some(segment => /profile photo/i.test(segment)));
  const avatar = await fixtureWorker.findBrandingFileInput(page, 'avatar', deadline(), 'fixture avatar');
  const banner = await fixtureWorker.findBrandingFileInput(page, 'banner', deadline(), 'fixture banner');
  assert.equal(await avatar.getAttribute('id'), 'avatar');
  assert.equal(await banner.getAttribute('id'), 'banner');

  await fixtureWorker.setAndVerifyBrandingFile(avatar, temporaryAssetPath, deadline(), 'fixture avatar');
  assert.equal(await avatar.evaluate(input => input.files?.[0]?.name), path.basename(temporaryAssetPath));

  const name = await fixtureWorker.findChannelTextEditor(page, 'name', deadline(), 'fixture name');
  const description = await fixtureWorker.findChannelTextEditor(page, 'description', deadline(), 'fixture description');
  assert.equal(await name.getAttribute('id'), 'channel-name');
  assert.equal(await description.getAttribute('id'), 'channel-description');
  await name.fill('Fixture channel');
  await description.fill('Fixture description');
  await fixtureWorker.verifyChannelEditorValue(page, 'name', 'Fixture channel', deadline());
  await fixtureWorker.verifyChannelEditorValue(page, 'description', 'Fixture description', deadline());
  await assert.rejects(
    () => fixtureWorker.verifyChannelEditorValue(page, 'description', 'Changed elsewhere', deadline()),
    /did not retain/i,
    'A value lost after filling must prevent saving.',
  );

  // A current editor with two equally-labelled avatar fields is unsafe. It
  // must stop, never fall back to the second input by position.
  page = modernProfileFixture({ duplicateAvatar: true });
  await assert.rejects(
    () => fixtureWorker.findBrandingFileInput(page, 'avatar', deadline(), 'ambiguous avatar'),
    /more than one matching field/i,
  );

  // An unlabeled modern file field is equally unsafe: no semantic match means
  // no selection and therefore no subsequent Publish operation.
  page = modernProfileFixture({ unnamedAvatar: true });
  await assert.rejects(
    () => fixtureWorker.findBrandingFileInput(page, 'avatar', deadline(), 'unknown avatar'),
    /no matching field/i,
  );

  console.log('Channel Profile DOM fixture test passed');
} finally {
  await fs.rm(temporaryModulePath, { force: true });
  await fs.rm(temporaryAssetPath, { force: true });
  if (priorDocument === undefined) delete globalThis.document;
  else globalThis.document = priorDocument;
}
