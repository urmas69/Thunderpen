'use strict';

const LANGUAGES = [
  { code: 'zh-TW', label: '繁體中文 (Traditional Chinese)' },
  { code: 'zh-CN', label: '简体中文 (Simplified Chinese)' },
  { code: 'zh-HK', label: '繁體中文 - 香港' },
  { code: 'en',    label: 'English' },
  { code: 'ja',    label: '日本語 (Japanese)' },
  { code: 'ko-KR', label: '한국어 (Korean)' },
  { code: 'de',    label: 'Deutsch (German)' },
  { code: 'fr-FR', label: 'Français (French)' },
  { code: 'es',    label: 'Español (Spanish)' },
  { code: 'it',    label: 'Italiano (Italian)' },
  { code: 'ru',    label: 'Русский (Russian)' },
  { code: 'pt-BR', label: 'Português - Brasil' },
  { code: 'vi',    label: 'Tiếng Việt (Vietnamese)' },
  { code: 'th-TH', label: 'ไทย (Thai)' },
];

const TINYMCE_LANGS = browser.runtime.getURL('tinymce/js/tinymce/langs');

const select   = document.getElementById('lang-select');
const status   = document.getElementById('lang-status');
const verSpan  = document.getElementById('version');

// 顯示版本
try {
  verSpan.textContent = browser.runtime.getManifest().version;
} catch (_) {
  verSpan.textContent = '?';
}

// 檢查語系檔是否存在，標示哪些可用
async function hasLangFile(code) {
  if (code === 'en') return true;
  try {
    const r = await fetch(`${TINYMCE_LANGS}/${code}.js`, { method: 'HEAD' });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function buildOptions() {
  select.innerHTML = '';
  for (const lang of LANGUAGES) {
    const ok = await hasLangFile(lang.code);
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = ok ? lang.label : `${lang.label} (language pack not installed)`;
    opt.disabled = !ok;
    select.appendChild(opt);
  }
}

async function loadCurrent() {
  try {
    const { tinymce_lang } = await browser.storage.local.get('tinymce_lang');
    // 相容舊版底線格式 zh_TW → zh-TW
    const code = (tinymce_lang || 'en').replace(/_/g, '-');
    select.value = code;
    // 若舊值已換新，立即寫回
    if (tinymce_lang && tinymce_lang !== code) {
      await browser.storage.local.set({ tinymce_lang: code });
    }
  } catch (_) {
    select.value = 'zh-TW';
  }
}

function showStatus(msg) {
  status.textContent = msg;
  status.classList.add('visible');
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => status.classList.remove('visible'), 2500);
}

select.addEventListener('change', async () => {
  try {
    await browser.storage.local.set({ tinymce_lang: select.value });
    showStatus('✓ Saved. Applies to the next compose window.');
  } catch (e) {
    showStatus('✗ Could not save: ' + e.message);
  }
});

// ── 貼上圖片提醒開關 ──────────────────────────────────────────────────────
// 撰寫視窗的提醒對話框上有「不再提醒」按鈕，會把 paste_image_warn_off 設為
// true；這裡提供重新開啟的入口，避免關掉之後就再也打不開。
const PASTE_WARN_OFF_KEY = 'paste_image_warn_off';
const pasteWarnBtn    = document.getElementById('toggle-paste-warn');
const pasteWarnStatus = document.getElementById('paste-warn-status');

function renderPasteWarnBtn(off) {
  pasteWarnBtn.textContent = off ? 'Disabled (click to enable)' : 'Enabled (click to disable)';
}

async function loadPasteWarn() {
  try {
    const stored = await browser.storage.local.get(PASTE_WARN_OFF_KEY);
    renderPasteWarnBtn(!!stored[PASTE_WARN_OFF_KEY]);
  } catch (_) {
    renderPasteWarnBtn(false);
  }
}

pasteWarnBtn.addEventListener('click', async () => {
  try {
    const stored = await browser.storage.local.get(PASTE_WARN_OFF_KEY);
    const next = !stored[PASTE_WARN_OFF_KEY];
    await browser.storage.local.set({ [PASTE_WARN_OFF_KEY]: next });
    renderPasteWarnBtn(next);
    showPasteWarnStatus(next ? '✓ Warning disabled' : '✓ Warning enabled');
  } catch (e) {
    showPasteWarnStatus('✗ Could not save: ' + e.message);
  }
});

function showPasteWarnStatus(msg) {
  pasteWarnStatus.textContent = msg;
  pasteWarnStatus.classList.add('visible');
  clearTimeout(showPasteWarnStatus._t);
  showPasteWarnStatus._t = setTimeout(
    () => pasteWarnStatus.classList.remove('visible'), 2500);
}

// 開啟簽名檔編輯器（新視窗）
document.getElementById('open-signature-editor').addEventListener('click', async () => {
  try {
    await browser.windows.create({
      url: browser.runtime.getURL('signature/editor.html'),
      type: 'popup',
      width: 900,
      height: 680
    });
  } catch (e) {
    alert('Could not open signature editor: ' + e.message);
  }
});

(async function init() {
  await buildOptions();
  await loadCurrent();
  await loadPasteWarn();
})();
