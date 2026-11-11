const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..');

function setup() {
  const fields = {};
  for (const name of ['session','date','period','title','notes','homework','notebook','output','context','preview','denise']) fields[`#mxra-summary-${name}`] = {value: '', dataset: {}, checked: true};
  fields['#mxra-summary-session'].value = '11';
  fields['#mxra-summary-date'].value = '2026-11-01';
  fields['#mxra-lesson'] = {value: 'Nâng cấp dự án game.'};
  fields['#mxra-log'] = {};
  const messages = [];
  const writes = [];
  const context = vm.createContext({
    window: {}, document: {querySelector: id => fields[id], querySelectorAll: () => [], body: {}}, setTimeout: fn => setTimeout(fn, 0),
    chrome: {runtime: {id: 'extension-id', sendMessage: async message => {
      messages.push(message);
      return {data: message.type.endsWith('-start') ? {job_id: 'a'.repeat(32)} : {status: 'done', result: {markdown: '**📌 Nhận xét:**\n\n- Bản tổng kết.', mock_mode: false}}};
    }}},
    navigator: {clipboard: {write: async items => writes.push(items)}},
    ClipboardItem: class {constructor(data) {this.data = data;}}, Blob, URL, console
  });
  const source = fs.readFileSync(path.join(dir, 'content.js'), 'utf8').replace('  createUI();', `
    requireCurrentPage = () => {};
    globalThis.api = {summaryToHtml, summaryToPlainText, generateParentSummary, copyParentSummary, getCourseName, isolatePanelEvents, getCourseFamily, updateHomeworkPolicy, runPanelAction, log, state};`);
  vm.runInContext(source, context);
  return {fields, messages, writes, context, api: context.api};
}

test('summary generation works without a student roster and only sends class data', async () => {
  const h = setup();
  await h.api.generateParentSummary();
  assert.equal(h.messages[0].type, 'mxra-summary-start');
  assert.equal(h.messages[0].payload.session_number, '11');
  assert.equal(h.messages[0].payload.study_date, '2026-11-01');
  assert.equal(h.messages[0].payload.students, undefined);
  assert.match(h.fields['#mxra-summary-output'].value, /Bản tổng kết/);
});

test('the class list is not treated as a selected class', () => {
  const h = setup();
  assert.equal(h.api.getCourseName(), '');
});

test('homework controls follow ROB/C4K policies when switching classes', () => {
  const h = setup();
  h.api.state.courseName = 'SH-KIND-ROB4A11';
  h.api.updateHomeworkPolicy(true);
  assert.equal(h.fields['#mxra-summary-denise'].checked, false);
  assert.equal(h.fields['#mxra-summary-denise'].disabled, true);
  assert.match(h.fields['#mxra-summary-homework'].placeholder, /tại lớp/);
  h.api.state.courseName = 'LVV-C4K-PTA18';
  h.api.updateHomeworkPolicy(true);
  assert.equal(h.fields['#mxra-summary-denise'].checked, true);
  assert.equal(h.fields['#mxra-summary-denise'].disabled, true);
  h.api.state.courseName = 'OTHER-CLASS';
  h.api.updateHomeworkPolicy(true);
  assert.equal(h.fields['#mxra-summary-denise'].checked, false);
  assert.equal(h.fields['#mxra-summary-denise'].disabled, false);
});

test('ROB generation never sends a stale checked Denise option', async () => {
  const h = setup();
  h.api.state.courseName = 'LVV-ROB-PREA14';
  h.fields['#mxra-summary-denise'].checked = true;
  await h.api.generateParentSummary();
  assert.equal(h.messages[0].payload.remind_denise, false);
});

test('finishing an action preserves controls locked by course policy', async () => {
  const h = setup();
  const locked = {disabled: true};
  const editable = {disabled: false};
  h.context.document.querySelectorAll = () => [locked, editable];
  await h.api.runPanelAction(async () => {
    assert.equal(locked.disabled, true);
    assert.equal(editable.disabled, true);
  });
  assert.equal(locked.disabled, true);
  assert.equal(editable.disabled, false);
});

test('panel focus does not propagate to the LMS focus trap', () => {
  const h = setup();
  const panel = new EventTarget();
  h.api.isolatePanelEvents(panel);
  for (const type of ['focusin', 'focusout']) {
    const event = new Event(type, {bubbles: true});
    panel.dispatchEvent(event);
    assert.equal(event.cancelBubble, true, `${type} should stay inside the panel`);
    assert.equal(event.defaultPrevented, false);
  }
});

test('typing, Vietnamese composition, selection and paste keep their native defaults', () => {
  const h = setup();
  const panel = new EventTarget();
  h.api.isolatePanelEvents(panel);
  for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut', 'mousedown']) {
    const event = new Event(type, {bubbles: true, cancelable: true});
    assert.equal(panel.dispatchEvent(event), true);
    assert.equal(event.defaultPrevented, false, `${type} must not block native input`);
    assert.equal(event.cancelBubble, true);
  }
});

test('panel input handlers still run after event isolation', () => {
  const h = setup();
  const panel = new EventTarget();
  h.api.isolatePanelEvents(panel);
  let edited = false;
  panel.addEventListener('input', () => {edited = true;});
  panel.dispatchEvent(new Event('input', {bubbles: true}));
  assert.equal(edited, true);
});

test('missing dates do not send requests or overwrite the existing draft', async () => {
  const h = setup();
  h.fields['#mxra-summary-date'].value = '';
  h.fields['#mxra-summary-output'].value = 'Bản nháp trước';
  await assert.rejects(h.api.generateParentSummary(), /chọn ngày học/);
  assert.equal(h.messages.length, 0);
  assert.equal(h.fields['#mxra-summary-output'].value, 'Bản nháp trước');
});

test('preview preserves headings and lists while escaping HTML from the draft', () => {
  const h = setup();
  const html = h.api.summaryToHtml('**📌 Nhận xét:**\n\n- Nội dung <img src=x onerror=alert(1)>\n\n- Ý hai\n\n1. Bài tập');
  assert.match(html, /<strong>.*📌 Nhận xét:.*<\/strong>/);
  assert.match(html, /<ul><li>/);
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.match(html, /<ol><li>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('copy writes both rich formatting and plain text without sending a message', async () => {
  const h = setup();
  h.fields['#mxra-summary-output'].value = '**📌 Nhận xét:**\n\n- Nội dung.';
  await h.api.copyParentSummary();
  const data = h.writes[0][0].data;
  assert.match(await data['text/html'].text(), /<strong>/);
  assert.equal(await data['text/plain'].text(), '📌 Nhận xét:\n\n- Nội dung.');
  assert.equal(h.messages.length, 0);
});

test('clipboard HTML carries explicit green/red/body/link colors without relying on page CSS', async () => {
  const h = setup();
  h.fields['#mxra-summary-output'].value = '**📚 KÍNH GỬI PHỤ HUYNH**\n\n**📌 Nội dung buổi học: LẬP TRÌNH**\n\n**📌 Nhận xét:**\n\n- Nội dung.\n\n**📌 Dặn dò:**\n\n- Notebook: https://example.com/view?a=1&b=2\n\n**Cảm ơn quý phụ huynh.**\n\n**Trân trọng @All**';
  await h.api.copyParentSummary();
  const html = await h.writes[0][0].data['text/html'].text();
  assert.match(html, /color:#15a85f/);
  assert.match(html, /color="#15a85f"/);
  assert.match(html, /color:#db342e/);
  assert.match(html, /color:#050a19/);
  assert.match(html, /color:#0068ff/);
  assert.match(html, /href="https:\/\/example.com\/view\?a=1&amp;b=2"/);
  assert.match(html, /color="#db342e">📌 Nội dung buổi học:/);
  assert.match(html, /color="#050a19"> LẬP TRÌNH/);
});

test('native rich copy is preferred and restores the active field and selection', async () => {
  const h = setup();
  h.fields['#mxra-summary-output'].value = '**📌 Nhận xét:**\n\n- Nội dung.';
  const calls = [];
  let restored;
  const oldRange = {cloneRange: () => oldRange};
  const selection = {rangeCount: 1, getRangeAt: () => oldRange, removeAllRanges: () => calls.push('clear'), addRange: range => calls.push(range === oldRange ? 'restore-range' : 'select-copy')};
  const area = {style: {}, setAttribute() {}, focus() {}, remove: () => calls.push('remove')};
  h.context.window.getSelection = () => selection;
  const doc = h.context.document;
  doc.activeElement = {selectionStart: 2, selectionEnd: 5, focus: () => calls.push('focus-original'), setSelectionRange: (start, end) => {restored = [start, end];}};
  doc.body = {appendChild: node => calls.push(node === area ? 'append' : 'wrong-node')};
  doc.createElement = () => area;
  doc.createRange = () => ({selectNodeContents: node => calls.push(node === area ? 'range-area' : 'wrong-range')});
  doc.execCommand = command => {calls.push(command); return true;};
  await h.api.copyParentSummary();
  assert.equal(h.writes.length, 0);
  assert.ok(calls.includes('copy'));
  assert.ok(calls.includes('remove'));
  assert.ok(calls.includes('restore-range'));
  assert.deepEqual(restored, [2, 5]);
  assert.match(area.innerHTML, /color:#db342e/);
});

test('failed native copy falls back to rich Clipboard API', async () => {
  const h = setup();
  h.fields['#mxra-summary-output'].value = '**📌 Dặn dò:**\n\n- Ôn bài.';
  h.context.document.execCommand = () => false;
  // Without a native selection API the HTML Clipboard API still works.
  await h.api.copyParentSummary();
  assert.equal(h.writes.length, 1);
  assert.match(await h.writes[0][0].data['text/html'].text(), /color:#db342e/);
});

test('mock reports cannot be copied as parent communications', async () => {
  const h = setup();
  h.fields['#mxra-summary-output'].value = 'Bản thử';
  h.fields['#mxra-summary-output'].dataset.mock = '1';
  await assert.rejects(h.api.copyParentSummary(), /Bản thử/);
  assert.equal(h.writes.length, 0);
});

test('background routes summary jobs and polling to the local backend', async () => {
  let handler;
  const requests = [];
  const context = vm.createContext({
    chrome: {runtime: {onMessage: {addListener: callback => {handler = callback;}}}},
    fetch: async (url, options) => { requests.push({url, options}); return {ok: true, json: async () => ({job_id: 'b'.repeat(32)})}; }, AbortSignal
  });
  vm.runInContext(fs.readFileSync(path.join(dir, 'backend.js'), 'utf8'), context);
  const send = message => new Promise(resolve => handler(message, {origin: 'https://lms.mindx.edu.vn', frameId: 0}, resolve));
  await send({type: 'mxra-summary-start', payload: {lesson_text: 'Nội dung'}});
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/summary/jobs');
  assert.equal(requests[0].options.method, 'POST');
  await send({type: 'mxra-generate-status', jobId: 'b'.repeat(32)});
  assert.equal(requests[1].url, 'http://127.0.0.1:8787/generate/jobs/' + 'b'.repeat(32));
});

test('status log updates tone attributes for visual feedback', () => {
  const h = setup();
  h.fields['#mxra-log'] = {dataset: {}};
  h.api.log('⏳ Đang tạo...');
  assert.equal(h.fields['#mxra-log'].dataset.tone, 'loading');
  h.api.log('✅ Hoàn tất');
  assert.equal(h.fields['#mxra-log'].dataset.tone, 'success');
  h.api.log('⚠️ Cảnh báo');
  assert.equal(h.fields['#mxra-log'].dataset.tone, 'warn');
  h.api.log('❌ Lỗi');
  assert.equal(h.fields['#mxra-log'].dataset.tone, 'error');
  h.api.log('🧪 Bản thử');
  assert.equal(h.fields['#mxra-log'].dataset.tone, 'mock');
});
