const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const comment = '**Điểm mạnh:** Con hoàn thành bài.\n\n**Điểm cần cải thiện:** Con cần luyện thêm.\n\n**Lời khuyên:** Con hãy ôn bài.';
const content = '<p><strong>Điểm mạnh:</strong> Con hoàn thành bài.</p><p><strong>Điểm cần cải thiện:</strong> Con cần luyện thêm.</p><p><strong>Lời khuyên:</strong> Con hãy ôn bài.</p>';

function setup({result = {data: {classes: {updateSlotComment: {id: 'class-1'}}}}, close = true, unrelated = false, disabled = false, blocked = false} = {}) {
  const window = new EventTarget();
  window.innerWidth = 1000;
  window.innerHeight = 800;
  class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
  class MouseEvent extends Event { constructor(type, options) { super(type, options); Object.assign(this, {clientX: options.clientX, clientY: options.clientY}); } }
  const attrs = new Map();
  const root = {
    dataset: {},
    getAttribute: key => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key)
  };
  let clicks = 0;
  let backdropClicks = 0;
  const sequence = [];
  const layer = {
    getBoundingClientRect: () => ({left: 0, top: 0, right: 1000, bottom: 800}),
    closest: () => null,
    dispatchEvent(event) {
      sequence.push(event.type);
      if (event.type === 'click') {
        assert.equal(sequence.at(-3), 'pointerup');
        assert.equal(sequence.at(-4), 'mousedown');
        backdropClicks++;
        if (close) modal.isConnected = false;
      }
    }
  };
  const dialogRoot = {
    querySelector: () => modal,
    querySelectorAll: () => [layer]
  };
  const modal = {
    isConnected: true, offsetWidth: 800,
    getClientRects: () => [1],
    closest: () => dialogRoot,
    contains: target => target === modal,
    querySelectorAll: () => [button]
  };
  const originalFetch = async () => new Response(JSON.stringify(result), {status: 200});
  window.fetch = originalFetch;
  const button = {
    textContent: 'Lưu', isConnected: true, disabled,
    getAttribute: () => null, scrollIntoView() {},
    click() {
      clicks++;
      window.fetch('/graphql', {method: 'POST', body: JSON.stringify({
        query: 'mutation UpdateSlotComment { classes { updateSlotComment(payload: $payload) { id } } }',
        variables: {payload: {studentComment: {content: unrelated ? 'Một nhận xét khác' : content}}}
      })});
    }
  };
  const document = {
    documentElement: root,
    querySelector: () => null,
    elementFromPoint: () => blocked ? modal : layer,
    createElement: () => ({set innerHTML(value) { this.textContent = value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '); }}),
  };
  const context = vm.createContext({window, document, Request, Response, CustomEvent, MouseEvent, Event,
    setTimeout, clearTimeout, console,
    getComputedStyle: () => ({visibility: 'visible'})});
  const dir = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(dir, 'page_bridge.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(dir, 'content.js'), 'utf8')
    .replace('setTimeout(r, ms)', 'setTimeout(r, 1)')
    .replace('  createUI();', `
      isVisibleControl = () => true;
      findVisibleModal = () => globalThis.modal.isConnected ? globalThis.modal : null;
      globalThis.api = {clickSave, watchReviewSave, askBackend, hasLmsSavedReview};`);
  context.modal = modal;
  vm.runInContext(source, context);
  return {context, window, modal, root, originalFetch, counts: () => ({clicks, backdropClicks})};
}

test('confirmed save closes a dialog that LMS intentionally leaves open; clicks Save once', async () => {
  const h = setup();
  assert.equal(await h.context.api.clickSave(h.modal, comment), true);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 1});
  assert.equal(h.window.fetch, h.originalFetch);
  assert.equal(h.root.getAttribute('data-mxra-save-text'), null);
});

test('consecutive reviews each get a fresh confirmation and restore fetch', async () => {
  const h = setup();
  for (let i = 0; i < 4; i++) {
    h.modal.isConnected = true;
    assert.equal(await h.context.api.clickSave(h.modal, comment), true);
    assert.equal(h.window.fetch, h.originalFetch);
  }
  assert.deepEqual(h.counts(), {clicks: 4, backdropClicks: 4});
});

test('HTTP 200 containing GraphQL errors never closes the form or reports a save', async () => {
  const h = setup({result: {errors: [{message: 'Validation failed'}]}});
  await assert.rejects(h.context.api.clickSave(h.modal, comment), /LMS trả lỗi/);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 0});
  assert.equal(h.window.fetch, h.originalFetch);
});

test('null mutation result does not count as saved', async () => {
  const h = setup({result: {data: {classes: {updateSlotComment: null}}}});
  await assert.rejects(h.context.api.clickSave(h.modal, comment), /LMS trả lỗi/);
  assert.equal(h.counts().backdropClicks, 0);
});

test('a mutation for different review text does not confirm the current review', async () => {
  const h = setup({unrelated: true});
  await assert.rejects(h.context.api.clickSave(h.modal, comment), /Chưa xác nhận/);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 0});
  assert.equal(h.window.fetch, h.originalFetch);
});

test('a new approval marker confirms saving even if the API watcher misses the request', async () => {
  const h = setup({unrelated: true});
  assert.equal(await h.context.api.clickSave(h.modal, comment, () => h.counts().clicks > 0), true);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 1});
  assert.equal(h.window.fetch, h.originalFetch);
});

test('a marker that predates Save does not confirm a new or changed review', async () => {
  const h = setup({unrelated: true});
  await assert.rejects(h.context.api.clickSave(h.modal, comment, () => true), /Chưa xác nhận/);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 0});
});

test('only an approval label in this student comment cell counts as saved', () => {
  const h = setup();
  function buttonWithLabels(labels) {
    return {closest(selector) {
      assert.equal(selector, 'td,[role="cell"]');
      return {querySelectorAll: () => labels.map(textContent => ({textContent, offsetWidth: 1, closest: () => null}))};
    }};
  }
  for (const label of ['Phê duyệt tự động', 'Phê duyệt tự động #1', '✓ Phê duyệt tự động', 'Phê duyệt tự động 2']) {
    assert.equal(h.context.api.hasLmsSavedReview(buttonWithLabels([label])), true);
  }
  for (const label of ['Có mặt', '✓ Có mặt', 'Chưa phê duyệt tự động', 'Chờ phê duyệt', 'Nhận xét học sinh']) {
    assert.equal(h.context.api.hasLmsSavedReview(buttonWithLabels([label])), false);
  }
  assert.equal(h.context.api.hasLmsSavedReview(null), false);
});

test('confirmed save is retained when the dialog cannot be closed', async () => {
  const h = setup({close: false});
  assert.equal(await h.context.api.clickSave(h.modal, comment), false);
  assert.equal(h.counts().clicks, 1);
});

test('does not click inside the review or through an obstructed backdrop', async () => {
  const h = setup({blocked: true});
  assert.equal(await h.context.api.clickSave(h.modal, comment), false);
  assert.deepEqual(h.counts(), {clicks: 1, backdropClicks: 0});
});

test('disabled Save does not send any request', async () => {
  const h = setup({disabled: true});
  await assert.rejects(h.context.api.clickSave(h.modal, comment), /đang bị khóa/);
  assert.deepEqual(h.counts(), {clicks: 0, backdropClicks: 0});
});

test('a stale tab without runtime shows instructions to reload LMS', async () => {
  const h = setup();
  await assert.rejects(h.context.api.askBackend({}), /tải lại tab LMS/);
  h.context.chrome = {};
  await assert.rejects(h.context.api.askBackend({}), /tải lại tab LMS/);
});

test('invalidated extension context shows instructions to reload LMS', async () => {
  const h = setup();
  h.context.chrome = {runtime: {id: 'extension-id', sendMessage: async () => { throw new Error('Extension context invalidated.'); }}};
  await assert.rejects(h.context.api.askBackend({}), /tải lại tab LMS/);
});

test('active extension returns backend data and preserves backend error messages', async () => {
  const h = setup();
  h.context.chrome = {runtime: {id: 'extension-id', sendMessage: async () => ({data: {job_id: 'job-1'}})}};
  assert.equal((await h.context.api.askBackend({})).job_id, 'job-1');
  h.context.chrome.runtime.sendMessage = async () => ({error: 'Backend đang bận.'});
  await assert.rejects(h.context.api.askBackend({}), /Backend đang bận/);
});
