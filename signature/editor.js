/**
 * signature/editor.js
 *
 * 簽名檔編輯器：
 *  - 讀取 Thunderbird 各帳號/身分（accounts.list + identities）
 *  - 用 TinyMCE 編輯 HTML 簽名
 *  - 儲存回 identity.signature (HTML)
 */

'use strict';

const TINYMCE_BASE = '../tinymce/js/tinymce';

const identitySelect = document.getElementById('identity-select');
const statusEl       = document.getElementById('status');
const btnSave        = document.getElementById('btn-save');
const btnCancel      = document.getElementById('btn-cancel');

let editor = null;
let identities = [];           // [{id, label, signature}]
let currentIdentityId = null;
let dirty = false;             // 是否有未儲存變更

// ── 工具 ──────────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.classList.remove('ok', 'err');
  if (type) statusEl.classList.add(type);
  if (type === 'ok') {
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('ok');
    }, 2500);
  }
}

// ── 讀取所有帳號的所有身分 ────────────────────────────────────────────────

async function loadIdentities() {
  identities = [];
  identitySelect.innerHTML = '';

  const accounts = await messenger.accounts.list();
  for (const acc of accounts) {
    // 只列出 imap/pop3/local 這類帶 identity 的帳號
    if (!acc.identities || acc.identities.length === 0) continue;
    for (const idn of acc.identities) {
      identities.push({
        id: idn.id,
        accountName: acc.name,
        label: idn.name || idn.email || idn.id,
        email: idn.email || '',
        signature: idn.signature || '',
        signatureIsPlainText: idn.signatureIsPlainText ?? false,
      });
    }
  }

  for (const it of identities) {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = `${it.accountName} — ${it.label}` +
                      (it.email ? ` <${it.email}>` : '');
    identitySelect.appendChild(opt);
  }

  if (identities.length === 0) {
    showStatus('No editable identities found', 'err');
    btnSave.disabled = true;
  } else {
    identitySelect.value = identities[0].id;
    currentIdentityId = identities[0].id;
  }
}

// ── TinyMCE 初始化 ────────────────────────────────────────────────────────

function initEditor() {
  return new Promise((resolve, reject) => {
    tinymce.init({
      selector: '#editor-area',
      base_url: TINYMCE_BASE,
      suffix: '.min',
      license_key: 'gpl',
      promotion: false,
      branding: false,
      menubar: 'edit view insert format table',
      plugins: [
        'advlist', 'autolink', 'lists', 'link', 'charmap',
        'anchor', 'searchreplace', 'visualblocks', 'code',
        'insertdatetime', 'table', 'wordcount'
      ],
      toolbar:
        'undo redo | bold italic underline strikethrough | ' +
        'forecolor backcolor | ' +
        'alignleft aligncenter alignright | ' +
        'bullist numlist outdent indent | ' +
        'table | link | removeformat | code',
      toolbar_mode: 'wrap',
      height: '100%',
      contextmenu: 'link mergecells splitcell | ' +
                   'tableinsertrowbefore tableinsertrowafter tabledeleterow | ' +
                   'column | deletetable',
      object_resizing: 'table',
      content_style:
        'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",' +
        '"Microsoft JhengHei", "PingFang TC", sans-serif; font-size: 14px;' +
        'line-height: 1.6; margin: 12px; color: #1a1a1a; }' +
        'table { border-collapse: collapse; }' +
        'td, th { border: 1px solid #ccc; padding: 4px 8px; }',
      setup(ed) {
        ed.on('init', () => {
          editor = ed;
          resolve(ed);
        });
        ed.on('LoadError', reject);
        ed.on('input change keyup paste', () => { dirty = true; });
      }
    });
  });
}

// ── 切換身分：載入該身分的簽名到編輯器 ───────────────────────────────────

async function loadSignatureIntoEditor(identityId) {
  const it = identities.find(x => x.id === identityId);
  if (!it || !editor) return;

  // 若簽名為純文字，轉為 <pre> 顯示避免格式跑掉
  let html = it.signature || '';
  if (it.signatureIsPlainText && html) {
    const escaped = html
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = '<pre>' + escaped + '</pre>';
  }

  editor.setContent(html);
  dirty = false;
  currentIdentityId = identityId;
  showStatus(`Loaded: ${it.accountName} — ${it.label}`);
}

// ── 儲存 ──────────────────────────────────────────────────────────────────

async function saveSignature() {
  if (!editor || !currentIdentityId) return;
  const html = editor.getContent();
  try {
    await messenger.identities.update(currentIdentityId, {
      signature: html,
      signatureIsPlainText: false,
    });
    // 同步本地暫存
    const it = identities.find(x => x.id === currentIdentityId);
    if (it) {
      it.signature = html;
      it.signatureIsPlainText = false;
    }
    dirty = false;
    showStatus('✓ Saved', 'ok');
  } catch (e) {
    console.error('[Signature] 儲存失敗:', e);
    showStatus('✗ Save failed: ' + e.message, 'err');
  }
}

// ── 事件 ──────────────────────────────────────────────────────────────────

identitySelect.addEventListener('change', async (e) => {
  const nextId = e.target.value;
  if (dirty) {
    const ok = confirm('The signature has unsaved changes. Discard them and switch identity?');
    if (!ok) {
      identitySelect.value = currentIdentityId;
      return;
    }
  }
  await loadSignatureIntoEditor(nextId);
});

btnSave.addEventListener('click', saveSignature);

btnCancel.addEventListener('click', async () => {
  if (dirty) {
    const ok = confirm('The signature has unsaved changes. Discard them and close?');
    if (!ok) return;
  }
  const win = await browser.windows.getCurrent();
  browser.windows.remove(win.id);
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── 初始化流程 ────────────────────────────────────────────────────────────

(async function main() {
  try {
    await loadIdentities();
    await initEditor();
    if (currentIdentityId) {
      await loadSignatureIntoEditor(currentIdentityId);
    }
  } catch (e) {
    console.error('[Signature] 初始化失敗:', e);
    showStatus('Initialization failed: ' + e.message, 'err');
  }
})();
