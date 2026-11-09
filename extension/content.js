(() => {
  if (window.__MXRA_LOADED__) return;
  window.__MXRA_LOADED__ = true;

  const TAGS = [
    'Tập trung', 'Chủ động', 'Hoàn thành tốt', 'Hiểu bài nhanh',
    'Cần luyện thêm', 'Cần cẩn thận', 'Cần hỗ trợ', 'Sáng tạo'
  ];
  const CLASS_CODE = /\b[A-Z][A-Z0-9]{1,5}(?:-[A-Z0-9]{2,12}){2,}\b/;

  const state = {
    students: [],
    lessonText: '',
    mode: 'B',
    courseName: '',
    sessionLabel: '',
    isCheckpoint: false,
    lessonManuallyEdited: false,
    pageUrl: '',
    busy: false,
    mockDrafts: false
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const isMxra = el => !!(el && el.closest && el.closest('#mxra-panel, #mxra-launcher'));

  function pageElements(selector) {
    return [...document.querySelectorAll(selector)].filter(el => visible(el) && !isMxra(el));
  }

  function findExactText(text) {
    return pageElements('h1,h2,h3,h4,h5,h6,button,a,label,p,div,span,strong,b')
      .filter(el => norm(el.textContent) === text)
      .sort((a, b) => a.children.length - b.children.length || a.textContent.length - b.textContent.length)[0] || null;
  }

  // MindX LMS hiện có chỗ ghi nhầm "Tổng kết" thành "Tổng két".
  // Fold dấu tiếng Việt để cả hai biến thể đều trở thành "tong ket".
  function foldText(s) {
    return norm(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLocaleLowerCase('vi-VN');
  }

  function findHeadingByFoldedText(foldedText) {
    return pageElements('h1,h2,h3,h4,h5,h6,button,a,label,p,div,span,strong,b')
      .filter(el => foldText(el.textContent) === foldedText)
      .sort((a, b) => a.children.length - b.children.length || a.textContent.length - b.textContent.length)[0] || null;
  }

  function findSummaryHeading() {
    // Bắt được cả: Tổng kết / Tổng két / TỔNG KẾT / TỔNG KÉT.
    return findHeadingByFoldedText('tong ket');
  }

  function findHomeworkHeading() {
    return findHeadingByFoldedText('bai ve nha');
  }

  function elText(el) {
    if (!el) return '';
    if ('value' in el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return norm(el.value);
    return norm(el.innerText || el.textContent || '');
  }

  function getClassDetailRoot() {
    // Chỉ quét vùng chi tiết lớp đang mở. Danh sách lớp phía nền vẫn tồn tại trong DOM,
    // nên quét toàn trang rất dễ lấy nhầm mã lớp đầu tiên.
    const summary = findSummaryHeading();
    if (!summary) return document.body;

    const buttons = reviewButtons();
    let node = summary.parentElement;
    let contentFallback = null;
    for (let i = 0; i < 16 && node && node !== document.body; i++, node = node.parentElement) {
      if (!visible(node) || isMxra(node)) continue;
      const t = elText(node);
      const hasEnd = t.includes('Bài về nhà');
      const hasStudents = t.includes('Học viên') || buttons.some(btn => node.contains(btn));
      const hasClassCode = CLASS_CODE.test(t);
      if (hasEnd && hasStudents && !contentFallback) contentFallback = node;
      // Ưu tiên ancestor nhỏ nhất vừa chứa nội dung tab Nhận xét vừa chứa mã lớp header.
      if (hasEnd && hasStudents && hasClassCode) return node;
    }

    const dialog = summary.closest('[role="dialog"], .modal, .drawer, .ant-drawer, .ant-drawer-content, .ant-modal, .ant-modal-content');
    if (dialog && CLASS_CODE.test(elText(dialog))) return dialog;
    return contentFallback || dialog || document.body;
  }

  function getCourseName() {
    const root = getClassDetailRoot();
    const summary = findSummaryHeading();
    const summaryTop = summary?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const rootRect = root?.getBoundingClientRect?.() || {top: 0};
    const codeRe = new RegExp(CLASS_CODE, 'g');
    const candidates = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !visible(parent) || isMxra(parent)) return NodeFilter.FILTER_REJECT;
        const raw = norm(node.nodeValue);
        if (!raw || raw.length > 120 || !raw.includes('-')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      const raw = norm(node.nodeValue);
      for (const match of raw.matchAll(codeRe)) {
        const code = match[0];
        const rect = parent.getBoundingClientRect();
        const aboveSummary = rect.top <= summaryTop + 10;
        const distanceFromRootTop = Math.abs(rect.top - rootRect.top);
        candidates.push({code, aboveSummary, distanceFromRootTop, top: rect.top});
      }
    }

    if (!candidates.length) return '';
    candidates.sort((a, b) => {
      if (a.aboveSummary !== b.aboveSummary) return a.aboveSummary ? -1 : 1;
      return a.distanceFromRootTop - b.distanceFromRootTop || a.top - b.top;
    });
    return candidates[0].code;
  }

  function colorActivityScore(el) {
    const style = getComputedStyle(el);
    const raw = style.backgroundColor || '';
    const m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
    if (!m) return 0;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const alpha = m[4] == null ? 1 : Number(m[4]);
    if (alpha === 0) return 0;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const darkness = 255 - ((r + g + b) / 3);
    return spread * 2 + darkness * 0.15;
  }

  function normalizeSessionText(raw) {
    let t = norm(raw);
    t = t.replace(/#\s*(\d+)\s*(?=\d{1,2}:\d{2})/, '# $1 ');
    t = t.replace(/#\s*(\d+)\s*(?=\d{2}\/\d{2})/, '# $1 ');
    return norm(t);
  }

  function getSessionLabel() {
    const root = getClassDetailRoot();
    const nodes = [...root.querySelectorAll('button,[role="button"],li,div,span')]
      .filter(el => visible(el) && !isMxra(el));
    const candidates = nodes
      .map(el => ({el, text: normalizeSessionText(el.innerText || el.textContent)}))
      .filter(x => x.text.length >= 6 && x.text.length <= 90)
      .filter(x => /#\s*\d+/.test(x.text) && /\d{2}\/\d{2}/.test(x.text));

    if (!candidates.length) return '';

    const explicitlyActive = candidates.find(x =>
      x.el.getAttribute('aria-selected') === 'true' ||
      x.el.classList.contains('active') ||
      x.el.classList.contains('selected') ||
      /(^|\s)(active|selected)(\s|$)/i.test(x.el.className || '')
    );
    if (explicitlyActive) return explicitlyActive.text;

    candidates.sort((a, b) => {
      const scoreDiff = colorActivityScore(b.el) - colorActivityScore(a.el);
      if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
      return a.text.length - b.text.length;
    });
    return candidates[0].text;
  }

  function getSessionNumber(sessionLabel) {
    const m = String(sessionLabel || '').match(/#\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function getCourseFamily(courseName) {
    const folded = foldText(courseName || '');
    if (/\bc4k\b/.test(folded)) return 'C4K';
    if (/\brob\b|robotics/.test(folded)) return 'ROB';
    return '';
  }

  function isCheckpointSession(courseName, sessionLabel) {
    const family = getCourseFamily(courseName);
    const sessionNo = getSessionNumber(sessionLabel);
    if (family === 'C4K') return sessionNo === 5 || sessionNo === 9;
    if (family === 'ROB') return sessionNo === 4 || sessionNo === 8;
    return false;
  }

  function defaultCheckpointByLevel(level) {
    if (level === 'Xuất sắc') return {ability: 5, practice: 5, quizCorrect: 10};
    if (level === 'Khá') return {ability: 3, practice: 3.5, quizCorrect: 7};
    if (level === 'Cần cố gắng') return {ability: 2, practice: 2.5, quizCorrect: 5};
    return {ability: 4, practice: 4, quizCorrect: 8};
  }

  function applyCheckpointDefaults(student, force = false) {
    const defaults = defaultCheckpointByLevel(student.level);
    if (force || student.checkpointAbility == null) student.checkpointAbility = defaults.ability;
    if (force || student.checkpointPractice == null) student.checkpointPractice = defaults.practice;
    if (force || student.checkpointQuizCorrect == null) student.checkpointQuizCorrect = defaults.quizCorrect;
  }

  function textBetweenElements(startEl, endEl) {
    try {
      const range = document.createRange();
      range.setStartAfter(startEl);
      range.setEndBefore(endEl);
      const fragment = range.cloneContents();
      const holder = document.createElement('div');
      holder.appendChild(fragment);
      holder.querySelectorAll('#mxra-panel,#mxra-launcher,script,style,noscript').forEach(el => el.remove());
      return norm(holder.textContent);
    } catch (_) {
      return '';
    }
  }

  function collectVisiblePageText() {
    const parts = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || !visible(parent) || isMxra(parent)) return NodeFilter.FILTER_REJECT;
          const t = norm(node.nodeValue);
          if (!t) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) parts.push(norm(node.nodeValue));
    return parts.join('\n');
  }

  function isBetweenVertically(el, startEl, endEl) {
    const r = el.getBoundingClientRect();
    const a = startEl.getBoundingClientRect();
    const b = endEl.getBoundingClientRect();
    const mid = r.top + Math.min(r.height, 40) / 2;
    return mid >= a.bottom - 8 && mid <= b.top + 8;
  }

  function readEditorCandidate(el) {
    if (!el) return '';
    if (el.tagName === 'IFRAME') {
      try { return norm(el.contentDocument?.body?.innerText || el.contentDocument?.body?.textContent || ''); }
      catch (_) { return ''; }
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return norm(el.value);
    return norm(el.innerText || el.textContent || '');
  }

  function extractLessonText() {
    const root = getClassDetailRoot();
    const heading = findSummaryHeading();
    const endHeading = findHomeworkHeading();
    if (!heading || !endHeading) return '';
    if (!(heading.compareDocumentPosition(endHeading) & Node.DOCUMENT_POSITION_FOLLOWING)) return '';

    // Rich-text editor của LMS có thể lưu nội dung trong .ql-editor/contenteditable/textarea.
    const editorSelectors = [
      '.ql-editor', '.ProseMirror', '.ck-content', '.fr-element', '.note-editable',
      '[contenteditable="true"]', '[role="textbox"]', 'textarea', 'iframe'
    ].join(',');
    const editors = [...root.querySelectorAll(editorSelectors)]
      .filter(el => visible(el) && !isMxra(el) && isBetweenVertically(el, heading, endHeading))
      .map(el => ({el, text: readEditorCandidate(el)}))
      .filter(x => x.text.length >= 10 && x.text.length <= 8000)
      .filter(x => !/^B\s+I\s+U\b/.test(x.text));

    if (editors.length) {
      editors.sort((a, b) => b.text.length - a.text.length);
      return editors[0].text;
    }

    const ranged = textBetweenElements(heading, endHeading);
    if (ranged.length >= 10 && ranged.length <= 8000) {
      const cleaned = ranged.replace(/^B\s+I\s+U(?:\s+\S+){0,8}\s+/i, '').trim();
      if (cleaned.length >= 10) return norm(cleaned);
    }

    const pieces = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !visible(parent) || isMxra(parent)) return NodeFilter.FILTER_REJECT;
        const t = norm(node.nodeValue);
        if (!t) return NodeFilter.FILTER_REJECT;
        const afterStart = !!(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
        const beforeEnd = !!(node.compareDocumentPosition(endHeading) & Node.DOCUMENT_POSITION_FOLLOWING);
        return afterStart && beforeEnd ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let node;
    while ((node = walker.nextNode())) pieces.push(norm(node.nodeValue));
    const joined = norm(pieces.join(' ')).replace(/^B\s+I\s+U(?:\s+\S+){0,8}\s+/i, '').trim();
    if (joined.length >= 10 && joined.length <= 8000) return joined;

    const rootText = norm(root.innerText || root.textContent || '');
    const m = rootText.match(/Tổng (?:kết|két)\s+([\s\S]{10,7000}?)(?:Bài về nhà|Chọn nhóm|Học viên)/i);
    return m ? norm(m[1]).replace(/^B\s+I\s+U(?:\s+\S+){0,8}\s+/i, '').trim() : '';
  }

  function findStudentContainer(button) {
    let el = button;
    for (let i = 0; i < 9 && el; i++, el = el.parentElement) {
      if (isMxra(el)) break;
      const t = norm(el.innerText);
      if (t.includes('Nhận xét học sinh') && (t.includes('Có mặt') || t.includes('Vắng') || t.includes('Sản phẩm của học sinh'))) {
        if (t.length < 1000) return el;
      }
    }
    return button.parentElement;
  }

  function inferStudentName(container) {
    const lines = (container?.innerText || '').split('\n').map(norm).filter(Boolean);
    const banned = [
      'Nhận xét học sinh','Phê duyệt tự động','Sản phẩm của học sinh','Có mặt','Vắng','Đi muộn','Comment'
    ];
    const candidates = lines.filter(x =>
      !banned.some(b => x.includes(b)) &&
      x.length >= 3 && x.length <= 70 &&
      !/^\d+$/.test(x)
    );
    return candidates[0] || 'Học viên';
  }

  function reviewButtons() {
    // LMS có thể render chữ "Nhận xét học sinh" ở button và nhiều span/div con.
    // Chuẩn hóa tất cả về đúng phần tử clickable rồi unique theo DOM element.
    const raw = pageElements('button,a,[role="button"],div,span')
      .filter(el => norm(el.textContent) === 'Nhận xét học sinh');

    const unique = new Set();
    for (const el of raw) {
      const clickable = el.closest('button,a,[role="button"]') || el;
      if (visible(clickable) && !isMxra(clickable)) unique.add(clickable);
    }
    return [...unique];
  }

  function extractStudents() {
    const buttons = reviewButtons();
    const seenContainers = new Set();
    const result = [];

    for (const button of buttons) {
      const container = findStudentContainer(button);
      if (!container || seenContainers.has(container)) continue;
      seenContainers.add(container);

      const name = inferStudentName(container);
      const attendance = studentAttendance(container);

      result.push({
        id: result.length + 1,
        name,
        button,
        container,
        attendance,
        level: 'Tốt',
        tags: [],
        note: '',
        checkpointAbility: null,
        checkpointPractice: null,
        checkpointQuizCorrect: null,
        comment: ''
      });
    }
    return result;
  }

  function studentAttendance(container) {
    const lines = (container.innerText || '').split('\n').map(foldText);
    if (lines.includes('vang')) return 'Vắng';
    if (lines.includes('di muon')) return 'Đi muộn';
    return 'Có mặt';
  }

  function createUI() {
    const launcher = document.createElement('button');
    launcher.id = 'mxra-launcher';
    launcher.textContent = '✨ MindX AI Review';
    document.body.appendChild(launcher);

    const panel = document.createElement('div');
    panel.id = 'mxra-panel';
    panel.className = 'mxra-hidden';
    panel.innerHTML = `
      <div class="mxra-head">
        <h3>MindX Review Assistant <span class="mxra-pill">v${chrome.runtime.getManifest().version}</span></h3>
        <button class="mxra-close">×</button>
      </div>
      <div class="mxra-body">
        <div class="mxra-row">
          <label>Chế độ</label>
          <select id="mxra-mode">
            <option value="B">B — Sinh nhận xét → duyệt → lưu</option>
            <option value="C">C — Sinh nhận xét → tự động lưu</option>
          </select>
        </div>
        <div class="mxra-row">
          <label>Nội dung buổi học</label>
          <textarea id="mxra-lesson" rows="6" spellcheck="true" autocomplete="off" placeholder="Extension sẽ tự đồng bộ từ mục Tổng kết/Tổng két. Nếu không đồng bộ được, bạn có thể click vào đây và nhập hoặc dán nội dung buổi học trực tiếp."></textarea>
          <div class="mxra-lesson-help">
            <span id="mxra-lesson-source" class="mxra-source mxra-source-warn">Nguồn: chưa có</span>
            <span>Nếu LMS không đồng bộ được, nội dung bạn tự nhập vẫn sẽ được dùng để tạo nhận xét.</span>
          </div>
          <div class="mxra-actions" style="margin-top:6px">
            <button id="mxra-scan" class="mxra-btn mxra-secondary">↻ Đồng bộ lại từ LMS</button>
            <button id="mxra-manual-lesson" class="mxra-btn mxra-secondary" type="button">✍ Nhập thủ công</button>
            <button id="mxra-clear-lesson" class="mxra-btn mxra-secondary" type="button">Xóa nội dung</button>
          </div>
        </div>
        <div id="mxra-meta" class="mxra-status"></div>
        <div id="mxra-students"></div>
        <div id="mxra-log" class="mxra-status mxra-log">Sẵn sàng.</div>
        <div class="mxra-small" style="margin-top:10px">
          Tên học viên chỉ dùng cục bộ trong trình duyệt; backend nhận ID, mức đánh giá, tag và ghi chú để giảm dữ liệu cá nhân gửi lên AI.
        </div>
      </div>
      <div class="mxra-footer">
        <button id="mxra-generate" class="mxra-btn mxra-primary">✨ Tạo nhận xét</button>
        <button id="mxra-save-approved" class="mxra-btn mxra-success">💾 Lưu tất cả</button>
      </div>`;
    document.body.appendChild(panel);

    launcher.onclick = () => {
      panel.classList.remove('mxra-hidden');
      if (!isCurrentPage()) scanPage();
    };
    panel.querySelector('.mxra-close').onclick = () => panel.classList.add('mxra-hidden');
    panel.querySelector('#mxra-scan').onclick = scanPage;

    const lessonInput = panel.querySelector('#mxra-lesson');
    // Một số listener của LMS bắt click/keydown ở document. Chặn propagation tại panel
    // để textarea luôn focus và gõ/paste thủ công được. Không preventDefault để giữ hành vi nhập liệu.
    ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup', 'paste'].forEach(type => {
      lessonInput.addEventListener(type, e => e.stopPropagation());
    });
    lessonInput.readOnly = false;
    lessonInput.disabled = false;
    lessonInput.addEventListener('input', e => {
      state.lessonText = e.target.value;
      state.lessonManuallyEdited = true;
      updateLessonSource(e.target.value.trim() ? 'manual' : 'empty');
    });

    panel.querySelector('#mxra-manual-lesson').onclick = e => {
      e.stopPropagation();
      lessonInput.readOnly = false;
      lessonInput.disabled = false;
      lessonInput.focus({preventScroll: true});
      const end = lessonInput.value.length;
      try { lessonInput.setSelectionRange(end, end); } catch (_) {}
      state.lessonManuallyEdited = true;
      if (lessonInput.value.trim()) updateLessonSource('manual');
      log('✍ Chế độ nhập thủ công: click vào ô Nội dung buổi học để gõ hoặc dán nội dung.');
    };

    panel.querySelector('#mxra-clear-lesson').onclick = () => {
      const box = panel.querySelector('#mxra-lesson');
      box.value = '';
      state.lessonText = '';
      state.lessonManuallyEdited = false;
      updateLessonSource('empty');
      log('Đã xóa nội dung buổi học. Bạn có thể đồng bộ lại từ LMS hoặc tự nhập.');
    };
    panel.querySelector('#mxra-mode').onchange = e => { state.mode = e.target.value; };
    panel.querySelector('#mxra-generate').onclick = () => runPanelAction(generateComments);
    panel.querySelector('#mxra-save-approved').onclick = () => runPanelAction(saveAllComments);
  }

  function updateLessonSource(source) {
    const el = document.querySelector('#mxra-lesson-source');
    if (!el) return;
    el.classList.remove('mxra-source-ok', 'mxra-source-manual', 'mxra-source-warn');
    if (source === 'lms') {
      el.textContent = 'Nguồn: LMS';
      el.classList.add('mxra-source-ok');
    } else if (source === 'manual') {
      el.textContent = 'Nguồn: nhập thủ công';
      el.classList.add('mxra-source-manual');
    } else {
      el.textContent = 'Nguồn: chưa có';
      el.classList.add('mxra-source-warn');
    }
  }

  function log(msg) {
    // Luôn REPLACE status hiện tại, tuyệt đối không append.
    const el = document.querySelector('#mxra-log');
    if (el) el.textContent = String(msg || '');
  }

  function renderStudents() {
    const root = document.querySelector('#mxra-students');
    root.innerHTML = '';
    if (!state.students.length) {
      root.innerHTML = '<div class="mxra-status" style="margin:10px 0">Chưa tìm thấy nút “Nhận xét học sinh”. Hãy mở tab Nhận xét và chọn một buổi học.</div>';
      return;
    }

    for (const s of state.students) {
      if (state.isCheckpoint) applyCheckpointDefaults(s);
      const card = document.createElement('div');
      card.className = 'mxra-student';
      card.innerHTML = `
        <div class="mxra-student-top">
          <div class="mxra-student-name">${escapeHtml(s.name)}</div>
          <select data-role="level">
            <option>Xuất sắc</option><option selected>Tốt</option><option>Khá</option><option>Cần cố gắng</option>
          </select>
        </div>
        ${state.isCheckpoint ? `
          <div class="mxra-checkpoint-box">
            <div class="mxra-checkpoint-title">Checkpoint</div>
            <div class="mxra-checkpoint-grid">
              <label>Điểm năng lực
                <select data-role="checkpoint-ability">
                  ${[1,2,3,4,5].map(v => `<option value="${v}" ${Number(s.checkpointAbility) === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
              </label>
              <label>Thực hành
                <input data-role="checkpoint-practice" type="number" min="0" max="5" step="0.5" value="${escapeHtml(s.checkpointPractice)}" />
              </label>
              <label>Trắc nghiệm đúng
                <input data-role="checkpoint-quiz" type="number" min="0" max="10" step="1" value="${escapeHtml(s.checkpointQuizCorrect)}" />
              </label>
            </div>
          </div>
        ` : ''}
        <div class="mxra-tags">${TAGS.map(t => `<label class="mxra-tag"><input type="checkbox" value="${t}">${t}</label>`).join('')}</div>
        <input data-role="note" placeholder="Ghi chú riêng (tùy chọn): ví dụ cần nhắc làm bài, hay mất tập trung..." />
        <textarea data-role="comment" placeholder="Nhận xét AI sẽ xuất hiện ở đây..."></textarea>
      `;
      card.querySelector('[data-role="level"]').value = s.level;
      card.querySelector('[data-role="note"]').value = s.note;
      card.querySelector('[data-role="comment"]').value = s.comment;
      card.querySelectorAll('.mxra-tag input').forEach(cb => { cb.checked = s.tags.includes(cb.value); });
      card.querySelector('[data-role="level"]').onchange = e => {
        s.level = e.target.value;
        if (state.isCheckpoint) {
          applyCheckpointDefaults(s, true);
          card.querySelector('[data-role="checkpoint-ability"]').value = String(s.checkpointAbility);
          card.querySelector('[data-role="checkpoint-practice"]').value = String(s.checkpointPractice);
          card.querySelector('[data-role="checkpoint-quiz"]').value = String(s.checkpointQuizCorrect);
        }
      };
      if (state.isCheckpoint) {
        card.querySelector('[data-role="checkpoint-ability"]').onchange = e => s.checkpointAbility = Number(e.target.value);
        card.querySelector('[data-role="checkpoint-practice"]').oninput = e => s.checkpointPractice = clampNumber(e.target.value, 0, 5);
        card.querySelector('[data-role="checkpoint-quiz"]').oninput = e => s.checkpointQuizCorrect = Math.round(clampNumber(e.target.value, 0, 10));
      }
      card.querySelector('[data-role="note"]').oninput = e => s.note = e.target.value;
      card.querySelectorAll('.mxra-tag input').forEach(cb => cb.onchange = () => {
        s.tags = [...card.querySelectorAll('.mxra-tag input:checked')].map(x => x.value);
      });
      card.querySelector('[data-role="comment"]').oninput = e => s.comment = e.target.value;
      s._card = card;
      root.appendChild(card);
    }
  }

  function scanPage() {
    if (state.busy) return;
    log('🔎 Đang đồng bộ dữ liệu từ LMS...');

    const lessonBox = document.querySelector('#mxra-lesson');
    const autoLesson = extractLessonText();
    const students = extractStudents();
    const courseName = getCourseName();
    const sessionLabel = getSessionLabel();
    const checkpoint = isCheckpointSession(courseName, sessionLabel);
    const samePage = state.pageUrl === location.href && state.courseName === courseName && state.sessionLabel === sessionLabel;
    const previous = new Map(samePage ? state.students.map(s => [s.button, s]) : []);
    const sameRoster = samePage && students.length === previous.size &&
      students.every(s => previous.get(s.button)?.name === s.name);
    const manualBeforeScan = samePage && state.lessonManuallyEdited && ((courseName && sessionLabel) || sameRoster)
      ? lessonBox.value.trim() : '';

    state.students = students.map(s => {
      const old = previous.get(s.button);
      if (old?.name !== s.name || old.attendance !== s.attendance) return s;
      return {...old, id: s.id, container: s.container};
    });
    if (!state.students.some(s => s.comment)) state.mockDrafts = false;
    state.pageUrl = location.href;
    state.courseName = courseName;
    state.sessionLabel = sessionLabel;
    state.isCheckpoint = checkpoint;

    if (autoLesson && !manualBeforeScan) {
      state.lessonText = autoLesson;
      state.lessonManuallyEdited = false;
      if (lessonBox) lessonBox.value = autoLesson;
      updateLessonSource('lms');
    } else if (manualBeforeScan) {
      // Quan trọng: KHÔNG xóa nội dung người dùng đã tự nhập khi LMS quét thất bại.
      state.lessonText = manualBeforeScan;
      state.lessonManuallyEdited = true;
      updateLessonSource('manual');
    } else {
      state.lessonText = '';
      state.lessonManuallyEdited = false;
      if (lessonBox) lessonBox.value = '';
      updateLessonSource('empty');
    }

    const meta = document.querySelector('#mxra-meta');
    if (meta) {
      meta.textContent = [
        `Lớp: ${courseName || 'chưa xác định'}`,
        `Buổi: ${sessionLabel || 'chưa xác định'}`,
        `Form: ${checkpoint ? 'Checkpoint' : 'Nhận xét thường'}`,
        `Học viên tìm thấy: ${students.length}`
      ].join('\n');
    }

    renderStudents();

    if (!autoLesson && !manualBeforeScan && !students.length) {
      log('⚠️ Chưa lấy được nội dung buổi học và danh sách học viên. Bạn có thể tự nhập nội dung buổi học vào ô phía trên.');
    } else if (state.lessonManuallyEdited) {
      log(`Đang giữ nội dung bạn nhập thủ công. Tìm thấy ${students.length} học viên.`);
    } else if (!autoLesson) {
      log(`⚠️ Đã tìm thấy ${students.length} học viên nhưng chưa đọc được mục Tổng kết/Tổng két. Hãy nhập/dán nội dung buổi học trực tiếp vào ô phía trên.`);
    } else if (!students.length) {
      log('⚠️ Đã đồng bộ được nội dung buổi học nhưng chưa tìm thấy học viên.');
    } else if (!courseName) {
      log(`✅ Đã đồng bộ nội dung buổi học và ${students.length} học viên. Chưa xác định được chính xác mã lớp.`);
    } else {
      log(`✅ Đồng bộ xong: lớp ${courseName}, ${checkpoint ? 'đã nhận diện buổi checkpoint' : 'form nhận xét thường'}, đã lấy nội dung buổi học và ${students.length} học viên.`);
    }
  }

  function isCurrentPage() {
    if (location.href !== state.pageUrl || getCourseName() !== state.courseName || getSessionLabel() !== state.sessionLabel) return false;
    if (state.courseName && state.sessionLabel) return true;
    const current = extractStudents();
    return current.length === state.students.length &&
      current.every((s, i) => s.button === state.students[i].button && s.name === state.students[i].name);
  }

  function requireCurrentPage() {
    if (!isCurrentPage()) throw new Error('Bạn đã chuyển lớp hoặc buổi học. Hãy bấm Đồng bộ lại từ LMS và kiểm tra lại.');
  }

  async function runPanelAction(action) {
    if (state.busy) return;
    const controls = [...document.querySelectorAll('#mxra-panel button, #mxra-panel select, #mxra-panel input, #mxra-panel textarea')];
    state.busy = true;
    controls.forEach(el => { el.disabled = true; });
    try {
      await action();
    } catch (e) {
      log(`❌ ${e.message}`);
    } finally {
      state.busy = false;
      controls.forEach(el => { el.disabled = false; });
    }
  }

  async function askBackend(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.data) throw new Error(response?.error || 'Không liên lạc được với tiện ích. Hãy tải lại extension và tab LMS.');
    return response.data;
  }

  function clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function readStudentCard(student) {
    if (!student._card) return;
    student.level = student._card.querySelector('[data-role="level"]').value;
    student.note = student._card.querySelector('[data-role="note"]').value.trim();
    student.tags = [...student._card.querySelectorAll('.mxra-tag input:checked')].map(x => x.value);
    student.comment = student._card.querySelector('[data-role="comment"]').value.trim();
    if (state.isCheckpoint) {
      student.checkpointAbility = Number(student._card.querySelector('[data-role="checkpoint-ability"]').value);
      student.checkpointPractice = clampNumber(student._card.querySelector('[data-role="checkpoint-practice"]').value, 0, 5);
      student.checkpointQuizCorrect = Math.round(clampNumber(student._card.querySelector('[data-role="checkpoint-quiz"]').value, 0, 10));
    }
  }

  async function generateComments() {
    const lessonText = document.querySelector('#mxra-lesson').value.trim();
    state.lessonText = lessonText;
    if (!lessonText) return log('⚠️ Chưa có nội dung buổi học. Hãy đồng bộ từ LMS hoặc nhập/dán thủ công vào ô Nội dung buổi học.');
    if (!state.students.length) return log('⚠️ Chưa tìm thấy học viên.');
    requireCurrentPage();
    if (state.mode === 'C' && (!state.courseName || !state.sessionLabel)) {
      return log('⚠️ Chưa xác định được lớp hoặc buổi học. Hãy đồng bộ lại hoặc dùng chế độ B để duyệt.');
    }

    state.students.forEach(readStudentCard);

    const payload = {
      lesson_text: lessonText,
      course_name: state.courseName,
      session_label: state.sessionLabel,
      students: state.students.map(s => ({
        id: s.id,
        attendance: s.attendance,
        level: s.level,
        tags: s.tags,
        note: s.note,
        checkpoint_ability: state.isCheckpoint ? s.checkpointAbility : null,
        checkpoint_practice: state.isCheckpoint ? s.checkpointPractice : null,
        checkpoint_quiz_correct: state.isCheckpoint ? s.checkpointQuizCorrect : null
      }))
    };

    log(`⏳ Đang tạo ${state.students.length} nhận xét...`);
    try {
      const {job_id: jobId} = await askBackend({type: 'mxra-generate-start', payload});
      let data;
      const deadline = Date.now() + 360000;
      while (Date.now() < deadline) {
        await sleep(1500);
        requireCurrentPage();
        const poll = await askBackend({type: 'mxra-generate-status', jobId});
        if (poll.status === 'done') {
          data = poll.result;
          break;
        }
      }
      if (!data) throw new Error('Đã hết thời gian chờ Gemini. Thử lại sau.');
      requireCurrentPage();
      const byId = new Map((data.comments || []).map(x => [x.id, x.comment]));
      if (byId.size !== state.students.length || state.students.some(s => !byId.get(s.id)?.trim())) {
        throw new Error('Backend trả thiếu nhận xét. Hãy thử tạo lại.');
      }
      state.mockDrafts = data.mock_mode === true;
      for (const s of state.students) {
        s.comment = byId.get(s.id) || '';
        s.savedReview = null;
        if (s._card) s._card.querySelector('[data-role="comment"]').value = s.comment;
      }
      if (state.mockDrafts) return log('🧪 Đã tạo nhận xét thử. Chế độ thử không cho lưu vào LMS.');
      log('✅ Đã tạo nhận xét. Bạn có thể sửa trực tiếp trước khi lưu.');
      if (state.mode === 'C') {
        await saveAllComments();
      }
    } catch (e) {
      console.error(e);
      log(`❌ Không tạo được nhận xét: ${e.message}`);
    }
  }

  function isVisibleControl(el) {
    if (!el || isMxra(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function hasSaveButton(root) {
    return [...root.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')]
      .some(el => isVisibleControl(el) && foldText(el.value || el.textContent) === 'luu');
  }

  function modalCandidatesFromSaveButtons() {
    const roots = new Set();
    const saveButtons = [...document.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')]
      .filter(el => isVisibleControl(el) && foldText(el.value || el.textContent) === 'luu');

    for (const btn of saveButtons) {
      let node = btn.parentElement;
      for (let i = 0; i < 14 && node && node !== document.body; i++, node = node.parentElement) {
        if (isMxra(node) || !visible(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width >= 360 && rect.height >= 220) roots.add(node);
      }
    }
    return roots;
  }

  function modalCandidateScore(el, student) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 360 || rect.height < 220) return -1;
    if (rect.width > window.innerWidth * 0.98 && rect.height > window.innerHeight * 0.98) return -1;
    if (!hasSaveButton(el)) return -1;

    const folded = foldText(el.innerText || el.textContent || '');
    let score = 0;
    score += 30;
    if (folded.includes('nhan xet hoc sinh')) score += 25;
    if (folded.includes('danh gia chung')) score += 25;
    if (folded.includes('cac tieu chi nhan xet khac')) score += 15;
    if (folded.includes('tong diem giua ky')) score += 12;
    if (folded.includes('diem nang luc')) score += 12;
    if (folded.includes('diem thuc hanh')) score += 12;
    if (folded.includes('diem trac nghiem')) score += 12;
    if (folded.includes('checkpoint')) score += 8;
    if (student?.name && folded.includes(foldText(student.name))) score += 20;

    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') score += 8;
    if (Number(style.zIndex) > 100) score += 8;
    return score;
  }

  function findVisibleModal(student = null) {
    const candidates = new Set([
      ...document.querySelectorAll([
        '[role="dialog"]',
        '.modal',
        '.modal-dialog',
        '.modal-content',
        '.ant-modal',
        '.ant-modal-content',
        '.MuiDialog-root',
        '.MuiDialog-paper',
        '.el-dialog',
        '.v-dialog',
        '.cdk-overlay-pane'
      ].join(',')),
      ...modalCandidatesFromSaveButtons()
    ]);

    return [...candidates]
      .filter(el => visible(el) && !isMxra(el))
      .map(el => ({
        el,
        score: modalCandidateScore(el, student),
        area: el.getBoundingClientRect().width * el.getBoundingClientRect().height
      }))
      .filter(x => x.score >= 35)
      .sort((a, b) => b.score - a.score || a.area - b.area)[0]?.el || null;
  }

  function modalTextFold(modal) {
    return foldText(modal?.innerText || modal?.textContent || '');
  }

  function isCheckpointModal(modal) {
    const t = modalTextFold(modal);
    return t.includes('checkpoint') || (t.includes('diem nang luc') && t.includes('diem thuc hanh'));
  }

  function toHtml(comment) {
    const esc = escapeHtml(comment);
    return esc
      .replace(/\*\*(Điểm mạnh:|Điểm cần cải thiện:|Lời khuyên:)\*\*/g, '<strong>$1</strong>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>') + '</p>';
  }

  function findTextElementByFold(modal, foldedNeedle) {
    return [...modal.querySelectorAll('label,p,div,span,strong,b,h1,h2,h3,h4,h5,h6,td,th')]
      .filter(el => !isMxra(el) && foldText(el.textContent).includes(foldedNeedle))
      .sort((a, b) => a.children.length - b.children.length || a.textContent.length - b.textContent.length)[0] || null;
  }

  function findModalScroller(modal) {
    const candidates = [modal, ...modal.querySelectorAll('div,section,form')]
      .filter(el => visible(el) && el.scrollHeight > el.clientHeight + 40);
    candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || modal;
  }

  async function scrollModalTo(modal, top) {
    const scroller = findModalScroller(modal);
    scroller.scrollTop = Math.max(0, top);
    scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
    await sleep(120);
    return scroller;
  }

  async function scrollModalToText(modal, foldedNeedle) {
    let found = findTextElementByFold(modal, foldedNeedle);
    if (found) {
      found.scrollIntoView({block: 'center'});
      await sleep(80);
      return found;
    }

    const scroller = findModalScroller(modal);
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(260, Math.floor(scroller.clientHeight * 0.65));
    for (let top = 0; top <= maxTop + step; top += step) {
      await scrollModalTo(modal, Math.min(top, maxTop));
      found = findTextElementByFold(modal, foldedNeedle);
      if (found) {
        found.scrollIntoView({block: 'center'});
        await sleep(80);
        return found;
      }
    }
    return null;
  }

  function setFieldValue(field, value) {
    field.focus();
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(field, String(value));
    else field.value = String(value);
    try {
      field.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:String(value)}));
    } catch (_) {
      field.dispatchEvent(new Event('input', {bubbles:true}));
    }
    ['change','blur'].forEach(type => field.dispatchEvent(new Event(type, {bubbles:true})));
  }

  function setRichEditorHtml(editor, html, plainText) {
    editor.focus();
    try {
      const doc = editor.ownerDocument || document;
      const view = doc.defaultView || window;
      const selection = view.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      doc.execCommand('insertHTML', false, html);
    } catch (_) {
      editor.innerHTML = html;
    }
    if (!norm(editor.innerText || editor.textContent).includes(norm(plainText).slice(0, 20))) {
      editor.innerHTML = html;
    }
    try {
      editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertHTML', data:plainText}));
    } catch (_) {
      editor.dispatchEvent(new Event('input', {bubbles:true}));
    }
    ['change','blur'].forEach(type => editor.dispatchEvent(new Event(type, {bubbles:true})));
  }

  async function setEditorValue(modal, comment) {
    const checkpoint = isCheckpointModal(modal);
    if (checkpoint) await scrollModalToText(modal, 'danh gia chung');

    const editors = [
      ...modal.querySelectorAll([
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '.ql-editor',
        '.ProseMirror',
        '.ck-content',
        '.fr-element',
        '.note-editable',
        'iframe'
      ].join(','))
    ].filter(el => visible(el) && !isMxra(el));
    const generalLabel = findTextElementByFold(modal, 'danh gia chung');
    let editor = null;
    if (generalLabel) {
      const labelRect = generalLabel.getBoundingClientRect();
      editor = editors
        .filter(el => el.getBoundingClientRect().top >= labelRect.top - 8)
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const aContent = a.getAttribute('contenteditable') === 'true' ? -1000 : 0;
          const bContent = b.getAttribute('contenteditable') === 'true' ? -1000 : 0;
          return (ar.top - labelRect.top + aContent) - (br.top - labelRect.top + bContent);
        })[0] || null;
    }
    if (!editor && checkpoint) return false;
    editor = editor ||
      editors.find(el => el.getAttribute('contenteditable') === 'true') ||
      editors.find(el => ['TEXTAREA', 'IFRAME'].includes(el.tagName)) ||
      editors[0];
    if (!editor) return false;

    editor.scrollIntoView({block: 'center'});
    await sleep(80);
    if (editor.tagName === 'IFRAME') {
      const body = editor.contentDocument?.body;
      if (!body) return false;
      setRichEditorHtml(body, toHtml(comment), comment);
      return norm(body.innerText) === norm(comment.replace(/\*\*/g, ''));
    } else if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      setFieldValue(editor, comment);
      return editor.value === comment;
    } else {
      setRichEditorHtml(editor, toHtml(comment), comment);
      return norm(editor.innerText) === norm(comment.replace(/\*\*/g, ''));
    }
  }

  function clickOption(el) {
    if (!el) return false;
    const input = el.matches?.('input') ? el : el.querySelector?.('input');
    const clickable = el.closest?.('label,button,[role="radio"],[role="checkbox"],.ant-radio-wrapper,.ant-checkbox-wrapper,.radio,.checkbox') || el;
    clickable.scrollIntoView({block:'center'});
    clickLmsElement(clickable);
    if (input) {
      ['input','change'].forEach(type => input.dispatchEvent(new Event(type, {bubbles:true})));
    } else {
      ['input','change'].forEach(type => el.dispatchEvent(new Event(type, {bubbles:true})));
    }
    return true;
  }

  function reactPropsFor(el) {
    if (!el) return null;
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactProps$') ||
      k.startsWith('__reactEventHandlers$') ||
      k.startsWith('__reactInternalInstance$')
    );
    return key ? el[key] : null;
  }

  function reactClickEvent(target, nativeEvent) {
    let defaultPrevented = false;
    let propagationStopped = false;
    return {
      ...nativeEvent,
      nativeEvent,
      target,
      currentTarget: target,
      type: 'click',
      bubbles: true,
      cancelable: true,
      defaultPrevented,
      eventPhase: 3,
      isTrusted: false,
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { propagationStopped = true; },
      isDefaultPrevented() { return defaultPrevented; },
      isPropagationStopped() { return propagationStopped; },
      persist() {}
    };
  }

  function triggerReactClick(el) {
    const button = el?.closest?.('button,a,[role="button"],label') || el;
    const candidates = [
      button,
      el,
      ...[...(button?.querySelectorAll?.('*') || [])],
      button?.parentElement
    ].filter(Boolean);
    const nativeEvent = new MouseEvent('click', {bubbles:true, cancelable:true, view:window, button:0});

    for (const target of candidates) {
      const props = reactPropsFor(target);
      if (typeof props?.onClick === 'function') {
        try {
          props.onClick(reactClickEvent(target, nativeEvent));
          return true;
        } catch (e) {
          console.debug('[MXRA] React onClick failed', e);
        }
      }
    }
    return false;
  }

  function pageBridgeClick(el) {
    if (document.documentElement.dataset.mxraBridgeReady !== '1') return Promise.resolve(false);
    const token = `mxra-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-mxra-click-token', token);
    document.documentElement.setAttribute('data-mxra-click-request', token);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener('mxra:react-click-result', onResult);
        el.removeAttribute('data-mxra-click-token');
        document.documentElement.removeAttribute('data-mxra-click-request');
        document.documentElement.removeAttribute('data-mxra-click-result');
        resolve(false);
      }, 900);
      function onResult(event) {
        const resultToken = event.detail?.token || document.documentElement.getAttribute('data-mxra-click-result');
        if (resultToken !== token) return;
        clearTimeout(timer);
        window.removeEventListener('mxra:react-click-result', onResult);
        el.removeAttribute('data-mxra-click-token');
        document.documentElement.removeAttribute('data-mxra-click-request');
        document.documentElement.removeAttribute('data-mxra-click-result');
        resolve(event.detail?.ok !== false);
      }
      window.addEventListener('mxra:react-click-result', onResult);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mxra:react-click', {detail: {token}}));
      }, 50);
    });
  }

  function pageBridgeSetCheckbox(el, checked) {
    if (document.documentElement.dataset.mxraBridgeReady !== '1') return Promise.resolve(false);
    const token = `mxra-checkbox-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-mxra-checkbox-token', token);
    document.documentElement.setAttribute('data-mxra-checkbox-request', token);
    document.documentElement.setAttribute('data-mxra-checkbox-checked', checked ? '1' : '0');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener('mxra:checkbox-set-result', onResult);
        el.removeAttribute('data-mxra-checkbox-token');
        document.documentElement.removeAttribute('data-mxra-checkbox-request');
        document.documentElement.removeAttribute('data-mxra-checkbox-checked');
        document.documentElement.removeAttribute('data-mxra-checkbox-result');
        resolve(false);
      }, 900);
      function onResult(event) {
        const resultToken = event.detail?.token || document.documentElement.getAttribute('data-mxra-checkbox-result');
        if (resultToken !== token) return;
        clearTimeout(timer);
        window.removeEventListener('mxra:checkbox-set-result', onResult);
        el.removeAttribute('data-mxra-checkbox-token');
        document.documentElement.removeAttribute('data-mxra-checkbox-request');
        document.documentElement.removeAttribute('data-mxra-checkbox-checked');
        document.documentElement.removeAttribute('data-mxra-checkbox-result');
        resolve(event.detail?.ok !== false);
      }
      window.addEventListener('mxra:checkbox-set-result', onResult);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mxra:checkbox-set', {detail: {token, checked}}));
      }, 50);
    });
  }

  function pageBridgeSetRadio(el) {
    if (document.documentElement.dataset.mxraBridgeReady !== '1') return Promise.resolve(false);
    const token = `mxra-radio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-mxra-radio-token', token);
    document.documentElement.setAttribute('data-mxra-radio-request', token);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener('mxra:radio-set-result', onResult);
        el.removeAttribute('data-mxra-radio-token');
        document.documentElement.removeAttribute('data-mxra-radio-request');
        document.documentElement.removeAttribute('data-mxra-radio-result');
        resolve(false);
      }, 900);
      function onResult(event) {
        const resultToken = event.detail?.token || document.documentElement.getAttribute('data-mxra-radio-result');
        if (resultToken !== token) return;
        clearTimeout(timer);
        window.removeEventListener('mxra:radio-set-result', onResult);
        el.removeAttribute('data-mxra-radio-token');
        document.documentElement.removeAttribute('data-mxra-radio-request');
        document.documentElement.removeAttribute('data-mxra-radio-result');
        resolve(event.detail?.ok !== false);
      }
      window.addEventListener('mxra:radio-set-result', onResult);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mxra:radio-set', {detail: {token}}));
      }, 50);
    });
  }

  function pageBridgeSetInput(el, value) {
    if (document.documentElement.dataset.mxraBridgeReady !== '1') return Promise.resolve(false);
    const token = `mxra-input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-mxra-input-token', token);
    document.documentElement.setAttribute('data-mxra-input-request', token);
    document.documentElement.setAttribute('data-mxra-input-value', String(value));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener('mxra:input-set-result', onResult);
        el.removeAttribute('data-mxra-input-token');
        document.documentElement.removeAttribute('data-mxra-input-request');
        document.documentElement.removeAttribute('data-mxra-input-value');
        document.documentElement.removeAttribute('data-mxra-input-result');
        resolve(false);
      }, 900);
      function onResult(event) {
        const resultToken = event.detail?.token || document.documentElement.getAttribute('data-mxra-input-result');
        if (resultToken !== token) return;
        clearTimeout(timer);
        window.removeEventListener('mxra:input-set-result', onResult);
        el.removeAttribute('data-mxra-input-token');
        document.documentElement.removeAttribute('data-mxra-input-request');
        document.documentElement.removeAttribute('data-mxra-input-value');
        document.documentElement.removeAttribute('data-mxra-input-result');
        resolve(event.detail?.ok !== false);
      }
      window.addEventListener('mxra:input-set-result', onResult);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mxra:input-set', {detail: {token, value}}));
      }, 50);
    });
  }

  function clickLmsElement(el) {
    if (!el) return false;
    el.scrollIntoView({block:'center', inline:'center'});
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(x, y);
    const clickTargets = [el.contains(topElement) ? topElement : el];

    for (const target of clickTargets) {
      ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        const EventCtor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        target.dispatchEvent(new EventCtor(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type.includes('down') ? 1 : 0
        }));
      });
    }
    return true;
  }

  async function tryOpenByReviewButton(button, student) {
    const attempts = [
      () => button.click(),
      () => clickLmsElement(button),
      () => triggerReactClick(button),
      () => pageBridgeClick(button),
      () => clickLmsElement(button.querySelector('span,svg,path') || button),
      () => pageBridgeClick(button.querySelector('span,svg,path') || button),
      () => {
        button.focus?.();
        button.dispatchEvent(new KeyboardEvent('keydown', {bubbles:true, cancelable:true, key:'Enter', code:'Enter'}));
        button.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true, cancelable:true, key:'Enter', code:'Enter'}));
        return true;
      }
    ];

    for (const attempt of attempts) {
      await attempt();
      for (let i = 0; i < 12; i++) {
        await sleep(150);
        const modal = findVisibleModal(student);
        if (modal) return modal;
      }
    }
    return null;
  }

  function inputRowForText(textEl) {
    let row = textEl;
    for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
      const controls = [...row.querySelectorAll('input,textarea,[role="radio"],[role="checkbox"],.ant-radio-wrapper,.ant-checkbox-wrapper')];
      if (controls.length >= 3 && norm(row.innerText).length < 700) return row;
    }
    return textEl.parentElement;
  }

  function radioOptions(row) {
    const wrappers = [...row.querySelectorAll('.ant-radio-wrapper,[role="radio"],label,.radio')]
      .filter(el => {
        if (isMxra(el)) return false;
        if (el.getAttribute('role') === 'radio') return true;
        return el.querySelectorAll('input[type="radio"]').length === 1;
      })
      .filter(el => visible(el) || visible(el.querySelector('input[type="radio"]')));
    if (wrappers.length >= 5) {
      return wrappers
        .map(el => ({el, rect: el.getBoundingClientRect()}))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map(x => x.el);
    }

    return [...row.querySelectorAll('input[type="radio"]')]
      .filter(el => !isMxra(el))
      .map(el => ({el, rect: el.getBoundingClientRect()}))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map(x => x.el);
  }

  function checkboxOptions(root) {
    const wrappers = [...root.querySelectorAll('.ant-checkbox-wrapper,[role="checkbox"],label,.checkbox')]
      .filter(el => {
        if (isMxra(el)) return false;
        if (el.getAttribute('role') === 'checkbox') return true;
        return el.querySelectorAll('input[type="checkbox"]').length === 1;
      })
      .filter(el => visible(el) || visible(el.querySelector('input[type="checkbox"]')));
    if (wrappers.length) {
      return wrappers
        .map(el => ({el, rect: el.getBoundingClientRect()}))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map(x => x.el);
    }

    return [...root.querySelectorAll('input[type="checkbox"]')]
      .filter(el => !isMxra(el))
      .map(el => ({el, rect: el.getBoundingClientRect()}))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map(x => x.el);
  }

  function optionChecked(el) {
    const input = el.matches?.('input') ? el : el.querySelector?.('input');
    if (input) return Boolean(input.checked);
    return el.getAttribute('aria-checked') === 'true' || el.classList.contains('checked') || /(^|\s)(checked|active)(\s|$)/i.test(el.className || '');
  }

  function radioInput(el) {
    return el?.matches?.('input[type="radio"]') ? el : el?.querySelector?.('input[type="radio"]') || null;
  }

  function checkboxInput(el) {
    return el?.matches?.('input[type="checkbox"]') ? el : el?.querySelector?.('input[type="checkbox"]') || null;
  }

  function setNativeChecked(input, checked) {
    if (!input) return false;
    const before = input.checked;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(input, checked);
    else input.checked = checked;
    if (input._valueTracker) input._valueTracker.setValue(String(before));
    try {
      input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:String(checked)}));
    } catch (_) {
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }
    input.dispatchEvent(new Event('change', {bubbles:true, cancelable:true}));
    return input.checked === checked;
  }

  async function setRadioState(el) {
    if (!el) return false;
    const input = radioInput(el);
    const targets = [
      input,
      input?.parentElement,
      el.closest?.('label,.MuiRadio-root,.MuiButtonBase-root,.MuiFormControlLabel-root,.ant-radio-wrapper,[role="radio"]'),
      el
    ].filter(Boolean);

    for (let attempt = 0; attempt < 5; attempt++) {
      if (optionChecked(el) || (input && input.checked)) return true;
      const target = targets[attempt % targets.length];
      clickLmsElement(target);
      await pageBridgeClick(target);
      await pageBridgeSetRadio(target);
      await sleep(180);
    }

    setNativeChecked(input, true);
    await pageBridgeSetRadio(input || el);
    await sleep(180);
    return optionChecked(el) || Boolean(input && input.checked);
  }

  async function setCheckboxState(el, shouldBeChecked) {
    if (!el) return false;
    const input = checkboxInput(el);
    const targets = [
      input,
      input?.parentElement,
      el.closest?.('label,.MuiCheckbox-root,.MuiButtonBase-root,.MuiFormControlLabel-root,.ant-checkbox-wrapper,[role="checkbox"]'),
      el
    ].filter(Boolean);

    if (optionChecked(el) === shouldBeChecked || (input && input.checked === shouldBeChecked)) return true;

    if (input) {
      setNativeChecked(input, !shouldBeChecked);
      await sleep(30);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      if (optionChecked(el) === shouldBeChecked || (input && input.checked === shouldBeChecked)) return true;
      const target = targets[attempt % targets.length];
      clickLmsElement(target);
      await pageBridgeClick(target);
      await sleep(180);
    }

    await pageBridgeSetCheckbox(input || el, shouldBeChecked);
    setNativeChecked(input, shouldBeChecked);
    await sleep(180);
    return optionChecked(el) === shouldBeChecked || Boolean(input && input.checked === shouldBeChecked);
  }

  async function setRatingNearLabel(modal, labelFold, rating) {
    const textEl = await scrollModalToText(modal, labelFold);
    if (!textEl) return false;
    const row = inputRowForText(textEl);
    const options = radioOptions(row);
    if (options.length !== 5) return false;
    const index = Math.max(0, Math.min(4, Number(rating) - 1));
    return setRadioState(options[index]);
  }

  function groupRadioInputs(radios) {
    const byName = new Map();
    const unnamed = [];
    for (const input of radios) {
      if (input.name) {
        if (!byName.has(input.name)) byName.set(input.name, []);
        byName.get(input.name).push(input);
      } else {
        unnamed.push(input);
      }
    }

    const groups = [...byName.values()].filter(group => group.length >= 5);
    unnamed
      .map(input => ({input, rect: input.getBoundingClientRect()}))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .reduce((rows, item) => {
        const last = rows[rows.length - 1];
        if (last && Math.abs(last[0].rect.top - item.rect.top) < 24) last.push(item);
        else rows.push([item]);
        return rows;
      }, [])
      .filter(row => row.length >= 5)
      .forEach(row => groups.push(row.map(item => item.input)));

    return groups.map(group => group
      .map(input => ({input, rect: input.getBoundingClientRect()}))
      .sort((a, b) => a.rect.left - b.rect.left)
      .map(item => item.input)
    );
  }

  async function setAbilityRatingsByGroups(modal, rating, expected) {
    const start = await scrollModalToText(modal, 'diem nang luc');
    const end = findTextElementByFold(modal, 'diem thuc hanh va trac nghiem') || findTextElementByFold(modal, 'diem thuc hanh');
    if (!start) return 0;
    const startTop = start.getBoundingClientRect().top;
    const endTop = end?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const radios = [...modal.querySelectorAll('input[type="radio"]')]
      .filter(input => !isMxra(input))
      .filter(input => {
        const top = input.getBoundingClientRect().top;
        return top >= startTop - 8 && top < endTop - 8;
      });
    const groups = groupRadioInputs(radios);
    if (!end || groups.length !== expected || groups.some(group => group.length !== 5)) return 0;
    const index = Math.max(0, Math.min(4, Number(rating) - 1));
    let touched = 0;
    for (const group of groups) {
      if (await setRadioState(group[index])) touched++;
    }
    return touched;
  }

  async function setNumericInputNearLabel(modal, labelFold, value) {
    const textEl = await scrollModalToText(modal, labelFold);
    if (!textEl) return false;
    const labelRect = textEl.getBoundingClientRect();
    const fields = [...modal.querySelectorAll('input')]
      .filter(el => visible(el) && !['radio', 'checkbox', 'button', 'submit', 'hidden'].includes((el.type || '').toLowerCase()))
      .map(el => ({el, rect: el.getBoundingClientRect()}))
      .filter(x => x.rect.top >= labelRect.top - 16 && x.rect.top <= labelRect.top + 90)
      .sort((a, b) => Math.abs(a.rect.top - labelRect.top) - Math.abs(b.rect.top - labelRect.top));
    if (!fields[0]) return false;
    setFieldValue(fields[0].el, value);
    await pageBridgeSetInput(fields[0].el, value);
    await sleep(100);
    return String(fields[0].el.value) === String(value);
  }

  async function setCheckpointQuiz(modal, correctCount) {
    const heading = await scrollModalToText(modal, 'diem trac nghiem') || await scrollModalToText(modal, 'checkpoint');
    const endHeading = findTextElementByFold(modal, 'cac tieu chi nhan xet khac');
    const checkboxes = checkboxOptions(modal);
    const startTop = heading?.getBoundingClientRect().top ?? 0;
    const endTop = endHeading?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const quizBoxes = checkboxes
      .filter(el => {
        const top = el.getBoundingClientRect().top;
        return top >= startTop - 8 && top < endTop - 8;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!heading || quizBoxes.length !== 10 || !Number.isInteger(correctCount) || correctCount < 0 || correctCount > 10) return false;
    const count = correctCount;
    let touched = 0;
    for (let index = 0; index < quizBoxes.length; index++) {
      const ok = await setCheckboxState(quizBoxes[index], index < count);
      if (ok) touched++;
    }
    await setNumericInputNearLabel(modal, 'diem trac nghiem', Number((count * 0.5).toFixed(1)));
    return quizBoxes.length > 0 && touched === quizBoxes.length;
  }

  async function fillCheckpointFields(modal, student) {
    await scrollModalTo(modal, 0);
    const labels = [
      'kien thuc hoc vien da duoc hoc tai lop',
      'kien thuc hoc vien tu hoc',
      'ky nang giao tiep',
      'ky nang su dung may tinh',
      'ky nang giai quyet van de',
      'tu duy sang tao',
      'tu duy may tinh',
      'thai do luyen tap ve nha',
      'thai do hoc tap tren lop'
    ];
    let touched = 0;
    for (const label of labels) {
      if (await setRatingNearLabel(modal, label, student.checkpointAbility)) touched++;
    }
    if (touched < labels.length) {
      touched = Math.max(touched, await setAbilityRatingsByGroups(modal, student.checkpointAbility, labels.length));
    }
    const practiceOk = await setNumericInputNearLabel(modal, 'diem thuc hanh', student.checkpointPractice);
    const quizOk = await setCheckpointQuiz(modal, student.checkpointQuizCorrect);
    await sleep(250);
    return {
      ok: touched >= labels.length && practiceOk && quizOk,
      checkpoint: true,
      touched,
      expected: labels.length,
      practiceOk,
      quizOk
    };
  }

  function findFreshReviewButton(student) {
    const candidates = extractStudents().filter(s => s.name === student.name && s.attendance === student.attendance);
    if (candidates.some(s => s.button === student.button)) return student.button;
    const originalMatches = state.students.filter(s => s.name === student.name && s.attendance === student.attendance);
    if (state.courseName && state.sessionLabel && student.name !== 'Học viên' && candidates.length === 1 && originalMatches.length === 1) {
      return candidates[0].button;
    }
    return null;
  }

  async function openStudentModal(student) {
    if (findVisibleModal()) throw new Error('Hãy đóng form nhận xét đang mở trước khi lưu tiếp.');
    const panel = document.querySelector('#mxra-panel');
    panel?.classList.add('mxra-saving');
    await sleep(120);

    const button = findFreshReviewButton(student);
    if (!button) {
      panel?.classList.remove('mxra-saving');
      throw new Error(`Không tìm thấy nút Nhận xét học sinh của ${student.name}`);
    }

    log(`⏳ Đang mở form Nhận xét học sinh: ${student.name}`);
    const modal = await tryOpenByReviewButton(button, student);
    if (modal) {
      panel?.classList.remove('mxra-saving');
      return modal;
    }
    panel?.classList.remove('mxra-saving');
    throw new Error(`Không mở được modal của ${student.name}`);
  }

  async function clickSave(modal) {
    const btn = [...modal.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')]
      .find(b => isVisibleControl(b) && foldText(b.value || b.textContent) === 'luu');
    if (!btn) throw new Error('Không tìm thấy nút Lưu trong modal.');
    btn.scrollIntoView({block:'center', inline:'center'});
    await sleep(120);
    if (!btn.isConnected || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      throw new Error('Nút Lưu đang bị khóa. Kiểm tra các trường bắt buộc trong form.');
    }
    btn.click();
    for (let i=0; i<70; i++) {
      await sleep(150);
      if (!visible(modal) || !document.body.contains(modal)) return;
    }
    throw new Error('LMS chưa đóng form sau khi bấm Lưu. Có thể còn trường bắt buộc chưa được tick/điền.');
  }

  async function saveAllComments() {
    if (state.mockDrafts) return log('🧪 Nhận xét thử không được lưu vào LMS. Hãy tắt chế độ thử và tạo lại.');
    requireCurrentPage();
    state.students.forEach(readStudentCard);
    const reviewKey = s => JSON.stringify([s.comment, s.checkpointAbility, s.checkpointPractice, s.checkpointQuizCorrect]);
    const todo = state.students.filter(s => s.comment && reviewKey(s) !== s.savedReview);
    if (!todo.length) return log('⚠️ Không có nhận xét mới để lưu.');

    log(`⏳ Đang lưu 0/${todo.length}...`);
    let done = 0;
    for (const s of todo) {
      try {
        requireCurrentPage();
        const modal = await openStudentModal(s);
        if (isCheckpointModal(modal) !== state.isCheckpoint) {
          throw new Error('Form LMS không khớp loại buổi trong panel. Hãy kiểm tra lại lớp, buổi và checkpoint.');
        }
        if (state.isCheckpoint) {
          const result = await fillCheckpointFields(modal, s);
          if (!result.ok) {
            throw new Error(`Không đồng bộ đủ checkpoint: năng lực ${result.touched}/${result.expected}, thực hành ${result.practiceOk ? 'OK' : 'lỗi'}, trắc nghiệm ${result.quizOk ? 'OK' : 'lỗi'}.`);
          }
        }
        const ok = await setEditorValue(modal, s.comment);
        if (!ok) throw new Error('Không tìm thấy ô nhập nhận xét.');
        await sleep(200);
        if (location.href !== state.pageUrl) throw new Error('Trang đã đổi trong lúc mở form.');
        await clickSave(modal);
        s.savedReview = reviewKey(s);
        done++;
        log(`⏳ Đang lưu ${done}/${todo.length}: ${s.name}`);
        await sleep(350);
      } catch (e) {
        console.error(e);
        log(`❌ Dừng ở ${s.name}: ${e.message}\nĐã lưu ${done}/${todo.length}.`);
        return;
      }
    }
    log(`✅ Hoàn tất: đã lưu ${done}/${todo.length} nhận xét.`);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  createUI();
})();
