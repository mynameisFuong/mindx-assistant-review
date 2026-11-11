const API = 'http://127.0.0.1:8787';
const LMS = 'https://lms.mindx.edu.vn';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.origin !== LMS || sender.frameId !== 0) return;
  const {type, payload, jobId} = message || {};
  const summary = type === 'mxra-summary-start';
  const start = type === 'mxra-generate-start' || summary;
  if (!start && (type !== 'mxra-generate-status' || !/^[a-f0-9]{32}$/.test(jobId))) return;
  const url = start ? `${API}/${summary ? 'summary' : 'generate'}/jobs` : `${API}/generate/jobs/${jobId}`;

  (async () => {
    let res;
    try {
      res = await fetch(url, {
        ...(start ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)} : {}),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
        cache: 'no-store'
      });
    } catch (_) {
      respond({error: 'Không kết nối được backend tại 127.0.0.1:8787. Hãy chạy start-review.cmd.'});
      return;
    }
    const data = await res.json().catch(() => null);
    if (res.ok && data) respond({data});
    else if (res.status === 404 && start) respond({error: 'Backend đang chạy bản cũ hoặc sai dịch vụ. Hãy khởi động lại bằng start-review.cmd.'});
    else respond({error: typeof data?.detail === 'string' ? data.detail : `Backend trả lỗi HTTP ${res.status}.`});
  })().catch(() => respond({error: 'Không đọc được phản hồi từ backend.'}));
  return true;
});
