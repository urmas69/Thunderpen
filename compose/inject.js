/**
 * inject.js  —  Compose Script
 *
 * 執行環境：about:blank?compose 的 content script 隔離世界。
 * 策略：用 eval 把 TinyMCE 程式碼跑在自己的環境（不依賴頁面 script 注入）。
 */

'use strict';

(async function () {

  const TINYMCE_BASE = browser.runtime.getURL('tinymce/js/tinymce');
  const SYNC_DEBOUNCE_MS = 600;

  // 防重入：只用 window flag，不用 DOM 檢查（DOM 可能有舊草稿殘留的 #kc-toolbar）
  if (window.__kcInjectStarted) {
    return;
  }
  window.__kcInjectStarted = true;

  // 立刻深度清除舊草稿可能殘留的 TinyMCE UI 元素
  const cleanStaleUI = () => {
    if (!document.body) return;
    // 1. 移除所有 tox 系 class 元素（不論深度）
    document.body.querySelectorAll(
      '#kc-toolbar, [data-kc-ui], ' +
      '[class*="tox-"], [class^="tox-"], .tox'
    ).forEach(el => el.remove());

    // 2. 把舊的 #kc-content unwrap（保留其內容，移除外層 div）
    document.body.querySelectorAll('#kc-content').forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      el.remove();
    });
  };
  cleanStaleUI();

  // 載入中橫幅
  const loading = document.createElement('div');
  loading.id = '_kc_loading';
  loading.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
    'background:#1565C0;color:#fff;padding:4px 8px;font:12px sans-serif;';
  loading.contentEditable = 'false';
  loading.textContent = '[TinyMCE] Loading...';
  (document.body || document.documentElement).appendChild(loading);

  // ── 等待 Thunderbird 內建的內嵌圖片非同步載入完成 ────────────────────────────
  // 轉寄/重新開啟含內嵌圖片（cid: 參照）的信件時，Thunderbird 會先放一個過渡態
  // 的 <img class="loading-internal" src="mailbox://.../part=...">，等背景讀取
  // 完該分段的實際資料後才「原地」更新同一個節點。若我們在這個非同步流程完成
  // 前就接手 DOM（我們自己搬移節點、或 TinyMCE 初始化時重新解析/重建內容），
  // Thunderbird 原本要更新的節點就會失去參照，圖片會永遠卡在載入中／消失。
  // 因此先等畫面上已無 loading 中的圖片，才繼續往下建置編輯器。
  function waitForImagesToSettle(root, timeoutMs) {
    return new Promise((resolve) => {
      const stillLoading = () => !!root.querySelector('img[class*="loading"]');
      if (!stillLoading()) { resolve(); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const obs = new MutationObserver(() => { if (!stillLoading()) finish(); });
      obs.observe(root, { attributes: true, attributeFilter: ['class', 'src'], subtree: true, childList: true });
      const timer = setTimeout(finish, timeoutMs);
    });
  }
  if (document.body) {
await waitForImagesToSettle(document.body, 8000);
}

  // 註：曾嘗試在這裡把 blob: 圖片自己 fetch 轉成 data: URI（base64），實測
  // content script 連同一份文件裡、Thunderbird 自己建立的 blob 都讀不到
  // （fetch 會丟 NetworkError）——這是 WebExtension content script 天生跑在
  // 獨立權限世界的限制，不是可以修的地方，因此移除了這段，不留無效的程式碼。

  // ── 記錄圖片最終的樣子，之後一律交還 Thunderbird 自己處理 ────────────────────
  // 走到這裡，圖片應該已經穩定成 mailbox://（尚未被 Thunderbird 解析，例如
  // 參照來源信件時）或 data:/blob: URI（已被 Thunderbird 自己解析）。把這個
  // 當下的樣子記下來；之後不管畫面上這個節點在編輯過程中被改成什麼樣子，只
  // 要是我們要把內容交回去給 Thunderbird（例如送出前），一律換回這裡記下的
  // 版本——圖片完全交給 Thunderbird 自己的資料，我們只處理文字/格式。
  const pristineImageHTML = new Map();
  if (document.body) {
    Array.from(document.body.querySelectorAll('img')).forEach((img, i) => {
      const markerId = 'kc-img-' + i;
      img.setAttribute('data-kc-img-id', markerId);
      pristineImageHTML.set(markerId, img.outerHTML);
    });
  }

await new Promise(r => setTimeout(r, 100));

  // ── 建立 DOM 骨架 ─────────────────────────────────────────────────────────
  // toolbar 直接放在 body 內，並標上 data-kc-ui 標記，
  // 儲存草稿時由 onAfterSave 清理。
  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'kc-toolbar';
  toolbarEl.setAttribute('data-kc-ui', '1');
  toolbarEl.contentEditable = 'false';
  toolbarEl.style.cssText =
    'flex:0 0 auto;min-height:44px;' +
    'background:#f9f9f9;border-bottom:1px solid #e0e0e0;';

  const contentEl = document.createElement('div');
  contentEl.id = 'kc-content';

  // 過濾掉舊草稿可能殘留的 TinyMCE UI 元素（防止重新載入時 toolbar HTML 被當內容）
  const isUiNode = (n) => {
    if (n.nodeType !== 1) return false;
    if (n.id === '_kc_loading' || n.id === 'kc-toolbar') return true;
    if (n.hasAttribute && n.hasAttribute('data-kc-ui')) return true;
    if (n.classList && (
      n.classList.contains('tox') ||
      n.classList.contains('tox-tinymce') ||
      n.classList.contains('tox-tinymce-inline') ||
      n.classList.contains('tox-tinymce-aux') ||
      n.classList.contains('tox-silver-sink')
    )) return true;
    return false;
  };
  const kids = Array.from(document.body.childNodes).filter(n => !isUiNode(n));
  // 移除原本 body 內所有殘留 UI 元素
  Array.from(document.body.childNodes).filter(isUiNode).forEach(n => n.remove());

  // 關鍵順序：先把（此時還是空的）toolbarEl／contentEl 接上 document.body，
  // 再把既有節點搬進 contentEl —— 而不是相反過來。
  // 原因：contentEl 在被接上文件之前是一個「游離」的節點（不屬於 document
  // 樹）。若在它還游離時就呼叫 contentEl.appendChild(kid)，kid 會先被整個
  // 從 document 上拔掉、暫時「斷開」，之後才隨 contentEl 一起被接回 document。
  // 這個瞬間的斷開會讓 Gecko 認定圖片資源需要重新載入一次；重新載入時走的
  // 管道權限較低，遇到 mailbox://（尤其是參照「草稿自己」郵件分段時）會被
  // moz-nullprincipal 安全性限制擋下，導致內嵌圖片消失（實測：停用外掛、
  // 改用原生編輯器走相同流程完全正常，可確認問題出在這裡而非 Thunderbird
  // 本身）。先把 contentEl 接上文件，kid 搬移全程都留在同一份 attached 的
  // document 樹內，就不會觸發這次多餘的重新載入。
  document.body.appendChild(toolbarEl);
  document.body.appendChild(contentEl);
  kids.forEach(n => contentEl.appendChild(n));

  // 標記遠端圖片，避免 Thunderbird 送出/存草稿時把 http(s) 圖片下載並轉存為
  // 附件（此時 src 會被改寫成 mailbox://.../part=... 的本機附件路徑）。
  // moz-do-not-send="true" 是 Thunderbird 專用屬性，代表「保留原網址、不要
  // 內嵌成附件」，效果等同勾選插入圖片對話框中取消「附加此圖片」。
  const markRemoteImages = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/^https?:\/\//i.test(src) && !img.hasAttribute('moz-do-not-send')) {
        img.setAttribute('moz-do-not-send', 'true');
      }
    });
  };
  markRemoteImages(contentEl);

  // 把（可能已被 Thunderbird 自己解析成 data:/blob: 的）圖片節點換回最原始的
  // 版本，交還內容給 Thunderbird 時一律使用這個原始版本，而不是畫面上目前
  // 顯示的版本。用 data-kc-img-id 這個標記屬性配對——即使 TinyMCE 在過程中
  // 把節點整個重建過，只要序列化出來的字串裡這個屬性值還在（img 的
  // extended_valid_elements 已允許 data-*），就能正確配對回去。
  const restorePristineImages = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('img[data-kc-img-id]').forEach((img) => {
      const id = img.getAttribute('data-kc-img-id');
      const original = pristineImageHTML.get(id);
      if (!original) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = original;
      const originalImg = tmp.firstElementChild;
      if (originalImg) img.replaceWith(originalImg);
    });
  };

  // 若原始信件內容為空（或僅有空白），插入一個 <p><br></p> 作為起始段落，
  // 否則 TinyMCE inline 在空 div 上無法定位游標，導致使用者無法輸入。
  const hasMeaningfulContent = Array.from(contentEl.childNodes).some(n => {
    if (n.nodeType === 1) return true;                       // 任何元素節點
    if (n.nodeType === 3) return n.nodeValue.trim() !== '';  // 非空白文字
    return false;
  });
  if (!hasMeaningfulContent) {
    contentEl.innerHTML = '<p><br></p>';
  }

  // toolbar 與 contentEl 已在上面接上 body（見上方順序說明），這裡只需要套
  // flex 直欄佈局（這個版面在 Thunderbird 撰寫視窗中經測試可正常顯示）。
  // body 內含 toolbar 的問題交由 onBeforeSend 與 prepareForSend 處理：送出前
  // 才從 DOM 移除 toolbar，避免被序列化進郵件。

  // 記下 body 原本的 style，使用者若選擇停用編輯器時可原樣還原
  const originalBodyStyle = document.body.getAttribute('style');

  Object.assign(document.body.style, {
    margin: '0', padding: '0', height: '100%',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden', boxSizing: 'border-box'
  });
  Object.assign(contentEl.style, {
    flex: '1 1 auto', minHeight: '0', overflowY: 'auto', padding: '8px 12px'
  });

  // 防止 Thunderbird 把整個 body 設為可編輯時，backspace 連續刪除導致工具列被吃掉
  document.body.contentEditable = 'false';

  // 安全網：toolbar 被移除就還原到 body 首位（但 _kc_sending 期間允許移除）
  let _kc_sending = false;
  // 使用者主動停用編輯器後，所有 UI 還原／按鍵攔截邏輯都要停手（見 disableEditor）
  let editorDisabled = false;
  // 收集所有 MutationObserver，停用編輯器時一併中斷
  const observers = [];

  const toolbarGuard = new MutationObserver(() => {
    if (_kc_sending || editorDisabled) return;
    if (!document.body.contains(toolbarEl)) {
      document.body.insertBefore(toolbarEl, document.body.firstChild);
    }
  });
  toolbarGuard.observe(document.body, { childList: true });
  observers.push(toolbarGuard);
  // 暴露給後面 prepareForSend 使用
  window.__kc_setSending = (v) => { _kc_sending = v; };

  // ── Selection / Backspace 邊界防護 ────────────────────────────────────────
  // 目標：確保游標永遠停在 contentEl 內部，Backspace/Delete 絕不會跨越邊界
  // 進到工具列，並且不會刪除 contentEl 這個容器本身。

  // 判斷 range 是否完全在 contentEl 內
  const rangeInContent = (range) =>
    contentEl.contains(range.startContainer) &&
    contentEl.contains(range.endContainer);

  // 判斷 caret 是否在 contentEl 的最開頭（連 offset 0 都算）
  const caretAtStart = (range) => {
    if (!range.collapsed) return false;
    if (range.startOffset !== 0) return false;
    // 走訪祖先鏈直到 contentEl，每層都必須是父節點的第一個子
    let n = range.startContainer;
    while (n && n !== contentEl) {
      if (n.previousSibling) return false;
      n = n.parentNode;
    }
    return n === contentEl;
  };

  document.addEventListener('keydown', (e) => {
    if (editorDisabled) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    // 選擇範圍任一端點在 contentEl 外 → 阻擋
    if (!rangeInContent(range)) {
      e.preventDefault();
      e.stopPropagation();
      focusContentStart();
      return;
    }

    // Backspace 且 caret 在最開頭 → 阻擋（否則會 merge 到 previousSibling = toolbar）
    if (e.key === 'Backspace' && caretAtStart(range)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }, true);

  // 把游標塞到 contentEl 的第一個文字位置
  function focusContentStart() {
    try {
      let target = contentEl.firstChild;
      // 若 contentEl 沒有子節點，補一個 <p><br></p>
      if (!target) {
        contentEl.innerHTML = '<p><br></p>';
        target = contentEl.firstChild;
      }
      const range = document.createRange();
      range.setStart(target, 0);
      range.collapse(true);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (typeof contentEl.focus === 'function') contentEl.focus();
    } catch (_) {}
  }

  // 註：v1.1.1 曾加入 selectionchange 自動抓回游標，但在送出流程中會與
  // prepareForSend 的 DOM 操作衝突導致無法發送。已移除。
  // Backspace 邊界保護（上方 keydown listener）已足以防止游標跑進工具列。

  // ── 強制 standards mode（about:blank 預設為 quirks）──────────────────────
  if (document.compatMode !== 'CSS1Compat') {
    try {
      Object.defineProperty(document, 'compatMode', {
        configurable: true,
        get: () => 'CSS1Compat'
      });
    } catch (_) {}
  }

  // ── 載入 TinyMCE ───────────────────────────────────────────────────────────
  // 註：在 about:blank?compose 的 content-script 隔離世界中，<script src> 注入
  // moz-extension:// 受 CSP 限制無法執行；必須以 fetch + indirect eval 載入。
  // 這是 Thunderbird/Firefox 對該頁面 CSP 的已知限制，亦為審核時可說明之原因。
  let tmce;
  try {
    const resp = await fetch(TINYMCE_BASE + '/tinymce.min.js');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const code = await resp.text();

    // indirect eval — 跑在 global scope，TinyMCE 才能正確掛上 window.tinymce
    (0, eval)(code);

    tmce = (typeof tinymce !== 'undefined') ? tinymce : window.tinymce;
    if (!tmce) throw new Error('tinymce 未定義');

    // 攔截內部 ScriptLoader，讓 plugin / theme / model / icon / lang 也走 fetch+eval
    const origLoadScript = tmce.ScriptLoader && tmce.ScriptLoader.loadScript;
    if (tmce.ScriptLoader && origLoadScript) {
      tmce.ScriptLoader.loadScript = function (url) {
        return fetch(url)
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.text();
          })
          .then(c => { (0, eval)(c); });
      };
    } else {
      console.warn('[TinyMCE Composer] 找不到 ScriptLoader.loadScript，plugin 可能載入失敗');
    }
  } catch (e) {
    console.error('[TinyMCE Composer] 載入 TinyMCE 失敗:', e);
    loading.textContent = '[TinyMCE] Load failed: ' + e.message;
    loading.style.background = '#c62828';
    return;
  }

  // ── 格式複製外掛 ──────────────────────────────────────────────────────────
  (function registerFormatPainter() {
    let saved = null, painting = false;
    tmce.PluginManager.add('kc_fp', (ed) => {
      function cap() {
        const n = ed.selection.getNode(), cs = ed.getWin().getComputedStyle(n);
        return {
          bold: ed.formatter.match('bold'), italic: ed.formatter.match('italic'),
          underline: ed.formatter.match('underline'), strike: ed.formatter.match('strikethrough'),
          fg: n.style.color || cs.color, bg: n.style.backgroundColor || cs.backgroundColor,
          fs: n.style.fontSize || cs.fontSize, ff: n.style.fontFamily || cs.fontFamily,
        };
      }
      function applyF(f) {
        const t = (n, v) => v ? ed.formatter.apply(n) : ed.formatter.remove(n);
        t('bold', f.bold); t('italic', f.italic);
        t('underline', f.underline); t('strikethrough', f.strike);
        const ok = v => v && !v.includes('rgba(0, 0, 0, 0)') && v !== 'transparent';
        if (ok(f.fg)) ed.formatter.apply('forecolor',   { value: f.fg });
        if (ok(f.bg)) ed.formatter.apply('hilitecolor', { value: f.bg });
        if (f.fs) ed.formatter.apply('fontsize', { value: f.fs });
        if (f.ff) ed.formatter.apply('fontname',  { value: f.ff });
      }
      ed.ui.registry.addToggleButton('kc_fp', {
        text: 'Format Painter',
        tooltip: 'Copy formatting, then select the target text to apply it',
        onSetup: api => {
          const upd = () => api.setActive(painting);
          ed.on('SelectionChange NodeChange', upd);
          return () => ed.off('SelectionChange NodeChange', upd);
        },
        onAction: () => {
          if (!painting) {
            saved = cap(); painting = true;
            ed.getContainer().style.cursor = 'crosshair';
          } else {
            if (saved && !ed.selection.isCollapsed()) applyF(saved);
            saved = null; painting = false;
            ed.getContainer().style.cursor = '';
          }
        }
      });
      ed.on('mouseup', () => {
        if (painting && saved && !ed.selection.isCollapsed()) {
          setTimeout(() => {
            applyF(saved); saved = null; painting = false;
            ed.getContainer().style.cursor = '';
          }, 20);
        }
      });
    });
  })();

  // ── 連線 background ──────────────────────────────────────────────────────
  const port = browser.runtime.connect({ name: 'compose-editor' });

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ── 從附加元件設定頁讀取語系設定 ──────────────────────────────────────────
  // 設定 UI 位於 options/options.html，由附加元件管理員開啟。
  let currentLang = 'en';
  try {
    const stored = await browser.storage.local.get('tinymce_lang');
    if (stored.tinymce_lang) currentLang = stored.tinymce_lang;
    // 相容舊版底線格式 zh_TW → zh-TW
    currentLang = currentLang.replace(/_/g, '-');
  } catch (_) {}

  // 確認語系檔存在；不存在則退回英文
  const langFileUrl = TINYMCE_BASE + '/langs/' + currentLang + '.js';
  let langOk = false;
  try {
    const r = await fetch(langFileUrl, { method: 'HEAD' });
    langOk = r.ok;
  } catch (_) {}
  if (!langOk && currentLang !== 'en') {
    console.warn('[TinyMCE Composer] 找不到語系檔', currentLang, '，使用英文');
    currentLang = 'en';
  }

  // ── 貼上圖片提醒的設定 ────────────────────────────────────────────────────
  // Thunderbird 撰寫視窗處理貼上的圖片時，有可能只留下暫時性的 blob: 網址；
  // 這種網址一旦被存進草稿或寄出的信件就再也解析不回來（破圖且無法修復，
  // 機制詳見專案根目錄 THUNDERBIRD_BUG_REPORT_DRAFT.md）。這不是外掛能修的
  // 部分，因此改為偵測到貼上圖片時提醒使用者，並提供「停用編輯器、改用
  // Thunderbird 原生編輯器」這個出口。
  const PASTE_WARN_OFF_KEY = 'paste_image_warn_off';
  let pasteWarnOff = false;
  try {
    const stored = await browser.storage.local.get(PASTE_WARN_OFF_KEY);
    pasteWarnOff = !!stored[PASTE_WARN_OFF_KEY];
  } catch (_) {}

  // ── 停用編輯器：把內容原地交還 Thunderbird 原生編輯器 ─────────────────────
  // 只在本撰寫視窗生效；已輸入的內容全部保留，重新開啟撰寫視窗會再次啟用。
  function disableEditor() {
    if (editorDisabled) return;
    editorDisabled = true;
    console.log('[TinyMCE inject] 使用者停用編輯器，內容交還 Thunderbird 原生編輯器');

    // 1. 停掉所有會把 UI 塞回 DOM 的 observer
    observers.forEach((o) => { try { o.disconnect(); } catch (_) {} });

    // 2. 拆掉 TinyMCE 本體（inline 模式下 remove() 不會重寫目標元素的 innerHTML，
    //    因此不會觸發圖片重新載入）
    try { tmce.remove(); } catch (e) {
      console.warn('[TinyMCE inject] tmce.remove() 失敗:', e);
    }

    // 3. 清掉所有殘留的外掛 UI（工具列、彈出層、提醒對話框）
    try {
      document.querySelectorAll(
        '#kc-toolbar, [data-kc-ui], .tox, [class*="tox-"], [class^="tox-"]'
      ).forEach((n) => n.remove());
    } catch (_) {}

    // 4. 把 #kc-content 的子節點原地攤回 body，再移除容器。
    //    刻意逐一搬移節點而不用 innerHTML 重建 —— 原因同上方「先接上文件再搬
    //    節點」的說明：重建會讓 Gecko 重新載入圖片資源，內嵌圖片可能因此消失。
    const contentParent = contentEl.parentNode;
    if (contentParent) {
      while (contentEl.firstChild) {
        contentParent.insertBefore(contentEl.firstChild, contentEl);
      }
      contentEl.remove();
    }

    // 5. 還原 body：把編輯權交回 Thunderbird，並移除我們的 flex 版面。
    //    inject.css 以 !important 鎖住 html/body 的 overflow/height，只能同樣用
    //    行內 !important 蓋回去，否則原生編輯器內容超過一頁時無法捲動。
    document.body.removeAttribute('contenteditable');
    if (originalBodyStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', originalBodyStyle);
    [document.documentElement, document.body].forEach((el) => {
      el.style.setProperty('overflow', 'auto', 'important');
      el.style.setProperty('height', 'auto', 'important');
    });

    // 6. 斷開與 background 的連線：onBeforeSend 便不再介入，存草稿／送出
    //    完全走 Thunderbird 原生流程。
    try { port.disconnect(); } catch (_) {}

    // 7. 游標放回內文開頭，使用者可以直接繼續打字
    try {
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.collapse(true);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (typeof document.body.focus === 'function') document.body.focus();
    } catch (_) {}
  }

  // ── 共用的對話框 ──────────────────────────────────────────────────────────
  // 注意：一律用 <button>，不用 checkbox —— 撰寫視窗本身是可編輯文件，
  // checkbox 之類表單控制項的點擊會被編輯器攔掉，button 則實測可用
  // （TinyMCE 工具列本身就是 button）。
  // buttons: [{ label, primary?, onClick? }]，按下任何一顆都會先關閉對話框。
  let kcDialog = null;
  function openDialog(bodyHtml, buttons) {
    if (kcDialog) return;   // 同時只顯示一個

    kcDialog = document.createElement('div');
    kcDialog.id = 'kc-dialog';
    kcDialog.setAttribute('data-kc-ui', '1');
    kcDialog.contentEditable = 'false';
    kcDialog.innerHTML =
      '<div class="kc-dlg-card">' + bodyHtml +
        '<div class="kc-dlg-actions">' +
          buttons.map((b, i) =>
            '<button type="button" data-kc-btn="' + i + '"' +
            (b.primary ? ' class="kc-dlg-primary"' : '') + '>' +
            b.label + '</button>'
          ).join('') +
        '</div>' +
      '</div>';

    const close = () => {
      if (!kcDialog) return;
      kcDialog.remove();
      kcDialog = null;
    };

    buttons.forEach((b, i) => {
      kcDialog.querySelector('[data-kc-btn="' + i + '"]')
        .addEventListener('click', () => {
          close();
          if (b.onClick) b.onClick();
        });
    });

    document.body.appendChild(kcDialog);
  }

  // 停用編輯器前的確認（工具列「關閉編輯器」按鈕用）
  function confirmDisableEditor() {
    if (editorDisabled) return;
    openDialog(
      '<h2>Close TinyMCE editor?</h2>' +
      '<p>The toolbar will disappear. Continue editing with the built-in Thunderbird editor.</p>' +
      '<p class="kc-dlg-note">This affects only the current compose window. All existing content is preserved; ' +
      'TinyMCE will be restored in the next compose window.</p>',
      [
        { label: 'Cancel' },
        { label: 'Close Editor', primary: true, onClick: disableEditor }
      ]
    );
  }

  // 偵測到貼上圖片時的提醒
  function showPasteImageWarning() {
    if (editorDisabled || pasteWarnOff) return;
    openDialog(
      '<h2 class="kc-dlg-warn">⚠ Pasted image detected</h2>' +
      '<p>When images are pasted into this editor, Thunderbird may keep only temporary URLs ' +
      '(blob:). Such images may break irreversibly after saving a draft or sending.</p>' +
      '<p>Use one of these alternatives:</p>' +
      '<ul>' +
        '<li>Attach the image using Thunderbird&#39;s attachment feature.</li>' +
        '<li>Close this editor and paste the image in Thunderbird&#39;s built-in editor.</li>' +
      '</ul>' +
      '<p class="kc-dlg-note">Closing affects only this compose window. The toolbar will disappear; ' +
      'your content stays intact and TinyMCE returns in the next compose window.</p>',
      [
        {
          label: 'Do not warn again',
          onClick: async () => {
            pasteWarnOff = true;
            try {
              await browser.storage.local.set({ [PASTE_WARN_OFF_KEY]: true });
            } catch (_) {}
          }
        },
        { label: 'Continue using editor' },
        { label: 'Close Editor', primary: true, onClick: disableEditor }
      ]
    );
  }


  // Apply one mail-friendly typography to pasted and outgoing HTML.
  // Retain structure and emphasis, never fonts/sizes/colors from pasted documents.
  const MAIL_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;';
  function normalizeMailHtml(html, forPaste = false) {
    const doc = new DOMParser().parseFromString(
      '<div id="kc-normalize-root">' + html + '</div>', 'text/html');
    const root = doc.getElementById('kc-normalize-root');
    if (!root) return html;
    const discarded = new Set(['SCRIPT','STYLE','META','LINK','IFRAME','OBJECT',
      'EMBED','FORM','INPUT','BUTTON','TEXTAREA','SELECT','SVG']);
    const semantic = new Set(['A','B','STRONG','I','EM','U','S','BR','P','DIV',
      'UL','OL','LI','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','BLOCKQUOTE',
      'IMG','CODE','PRE','HR']);
    function walk(parent) {
      for (const node of Array.from(parent.children)) {
        if (discarded.has(node.tagName)) { node.remove(); continue; }
        walk(node);
        if (/^H[1-6]$/.test(node.tagName)) {
          const p = doc.createElement('p');
          const strong = doc.createElement('strong');
          while (node.firstChild) strong.appendChild(node.firstChild);
          p.appendChild(strong);
          node.replaceWith(p);
          // The newly created paragraph will get its default style below.
          p.setAttribute('style', 'margin:0 0 12px 0;');
          continue;
        }
        if (node.tagName === 'FONT' || node.tagName === 'SPAN' ||
            (forPaste && !semantic.has(node.tagName))) {
          node.replaceWith(...Array.from(node.childNodes));
          continue;
        }
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase(), value = attr.value.trim();
          const allowed =
            (node.tagName === 'A' && (name === 'title' ||
              (name === 'href' && /^(https?:|mailto:|#)/i.test(value)))) ||
            (node.tagName === 'IMG' &&
              ['src','alt','title','width','height','data-kc-img-id','moz-do-not-send'].includes(name) &&
              (name !== 'src' || /^(https?:|cid:|data:image\/|blob:|mailbox:|imap:)/i.test(value))) ||
            (['TD','TH'].includes(node.tagName) && ['colspan','rowspan'].includes(name)) ||
            (['TABLE','TD','TH'].includes(node.tagName) && name === 'width') ||
            (['OL','LI'].includes(node.tagName) && ['start','value'].includes(name));
          if (!allowed) node.removeAttribute(attr.name);
        }
        if (node.tagName === 'P') node.setAttribute('style', 'margin:0 0 12px 0;');
        if (node.tagName === 'UL' || node.tagName === 'OL')
          node.setAttribute('style', 'margin:0 0 12px 0;padding-left:24px;');
        if (node.tagName === 'LI') node.setAttribute('style', 'margin:0 0 4px 0;');
        if (node.tagName === 'TABLE')
          node.setAttribute('style', 'border-collapse:collapse;margin:0 0 12px 0;');
        if (node.tagName === 'TD' || node.tagName === 'TH')
          node.setAttribute('style', 'padding:4px 8px;border:1px solid #cccccc;');
        if (node.tagName === 'CODE' || node.tagName === 'PRE')
          node.setAttribute('style', 'font-family:Arial,Helvetica,sans-serif;font-size:14px;');
      }
    }
    walk(root);
    if (forPaste) return root.innerHTML;
    const wrapper = doc.createElement('div');
    wrapper.setAttribute('style', MAIL_STYLE);
    while (root.firstChild) wrapper.appendChild(root.firstChild);
    root.appendChild(wrapper);
    return root.innerHTML;
  }

  // ── 初始化 TinyMCE ────────────────────────────────────────────────────────
  tmce.init({
    selector: '#kc-content',
    inline: true,
    toolbar_persist: true,
    fixed_toolbar_container: '#kc-toolbar',

    plugins: [
      'advlist', 'autolink', 'lists', 'link', 'charmap',
      'anchor', 'searchreplace', 'visualblocks', 'code',
      'insertdatetime', 'table', 'wordcount', 'kc_fp'
    ],
    toolbar:
      'undo redo | kc_fp | ' +
      'bold italic underline strikethrough | ' +
      'forecolor backcolor | ' +
      'alignleft aligncenter alignright | ' +
      'bullist numlist outdent indent | ' +
      'table | link | removeformat | code | kc_off',
    menubar: 'edit view insert format tools table',
    toolbar_mode: 'wrap',

    base_url: TINYMCE_BASE,
    suffix: '.min',
    license_key: 'gpl',
    promotion: false,
    branding: false,
    language: currentLang === 'en' ? undefined : currentLang,
    language_url: currentLang === 'en' ? undefined :
                  TINYMCE_BASE + '/langs/' + currentLang + '.js',

    object_resizing: 'table',

    // 保留 URL 原樣（尤其是轉寄信件時的遠端圖片絕對 URL）：
    // - convert_urls:false      關閉 TinyMCE 的 URL 相對/絕對轉換
    // - relative_urls:false     不強制改為相對路徑
    // - remove_script_host:false 不移除 http:// 或 https:// 前綴
    // - allow_html_in_named_anchor:true 保留錨點內 HTML
    convert_urls: false,
    relative_urls: false,
    remove_script_host: false,
    // 允許最寬鬆的元素/屬性通過（保留原信件所有 img 及其屬性）
    valid_elements: '*[*]',
    valid_children: '+body[style],+*[*]',
    extended_valid_elements: 'img[src|alt|title|width|height|style|border|hspace|vspace|align|class|id|data-*|srcset|loading|referrerpolicy]',

    // 右鍵選單：移除 tableprops（表格屬性）、cellprops（儲存格屬性）、
    // tablerowprops（行屬性）。row 子選單預設含 tablerowprops，必須展開明列。
    contextmenu:
      'link mergecells splitcell | ' +
      'tableinsertrowbefore tableinsertrowafter tabledeleterow | ' +
      'column | deletetable',

    content_style:
      '#kc-content { font-family:Arial,Helvetica,sans-serif;font-size:14px;' +
      'line-height:1.5;padding:8px 12px;color:#222222; }' +
      '#kc-content p { margin:0 0 12px 0; }' +
      '#kc-content ul, #kc-content ol { margin:0 0 12px 0;padding-left:24px; }' +
      'table { border-collapse:collapse; }' +
      'td, th { border:1px solid #ccc;padding:4px 8px; }',

    setup(ed) {
      // 工具列上的「關閉編輯器」出口：不必等到貼上圖片才有辦法退回原生編輯器
      ed.ui.registry.addButton('kc_off', {
        text: 'Close Editor',
        tooltip: 'Close TinyMCE and use the built-in Thunderbird editor in this compose window',
        onAction: confirmDisableEditor
      });

      ed.on('init', () => {
        const b = document.getElementById('_kc_loading');
        if (b) b.remove();


        // 標記 TinyMCE UI 元素為非編輯區
        const markUI = (el) => {
          if (el && el.nodeType === 1 &&
              (el.classList?.contains('tox-tinymce-aux') ||
               el.classList?.contains('tox-silver-sink'))) {
            el.setAttribute('data-kc-ui', '1');
            el.contentEditable = 'false';
          }
        };
        document.querySelectorAll('.tox-tinymce-aux, .tox-silver-sink').forEach(markUI);
        const uiGuard = new MutationObserver((muts) => {
          for (const m of muts) m.addedNodes.forEach((n) => markUI(n));
        });
        uiGuard.observe(document.body, { childList: true });
        observers.push(uiGuard);

        // ─── 偵測「貼上圖片」動作 ───────────────────────────────────────────
        // 兩層偵測，涵蓋不同來源：
        // 1. 原生 paste 事件的 clipboardData：截圖、複製圖片檔案。
        // 2. TinyMCE PastePreProcess：從網頁／其他信件複製整段含 <img> 的 HTML。
        const clipboardHasImage = (dt) => {
          if (!dt) return false;
          if (dt.files &&
              Array.from(dt.files).some((f) => /^image\//i.test(f.type))) return true;
          if (dt.items &&
              Array.from(dt.items).some(
                (it) => it.kind === 'file' && /^image\//i.test(it.type))) return true;
          try {
            if (/<img[\s>]/i.test(dt.getData('text/html') || '')) return true;
          } catch (_) {}
          return false;
        };
        document.addEventListener('paste', (e) => {
          if (editorDisabled) return;
          if (clipboardHasImage(e.clipboardData)) showPasteImageWarning();
        }, true);
        ed.on('PastePreProcess', (e) => {
          if (/<img[\s>]/i.test(e.content || '')) showPasteImageWarning();
          e.content = normalizeMailHtml(e.content || '', true);
        });

        // ─── 修正：表格 picker 視覺同步 ─────────────────────────────────────
        // TinyMCE 7 picker 的內部狀態能更新，但 Alloy 視覺綁定在 Thunderbird
        // 撰寫視窗環境下不會同步到 DOM。這裡接管視覺更新。
        const COLS = 10;
        function updatePickerVisual(cell) {
          const parent = cell.parentElement;
          if (!parent || !parent.classList.contains('tox-insert-table-picker')) return;
          const cells = Array.from(parent.children);
          const idx = cells.indexOf(cell);
          if (idx < 0) return;
          const row = Math.floor(idx / COLS);
          const col = idx % COLS;
          cells.forEach((c, i) => {
            const r = Math.floor(i / COLS), x = i % COLS;
            c.classList.toggle('tox-insert-table-picker__selected', r <= row && x <= col);
          });
          let label = parent.parentElement?.querySelector?.('.tox-insert-table-picker__label')
                   || document.querySelector('.tox-insert-table-picker__label');
          if (label) label.textContent = (col + 1) + 'x' + (row + 1);
        }
        document.addEventListener('mousemove', (e) => {
          if (editorDisabled) return;
          const t = e.target;
          if (!t || t.nodeType !== 1) return;
          if (t.parentElement?.classList?.contains('tox-insert-table-picker')) {
            updatePickerVisual(t);
            return;
          }
          const cell = t.closest?.('.tox-insert-table-picker > *');
          if (cell) updatePickerVisual(cell);
        }, true);

        // 取得乾淨的編輯器內容：用 DOM 解析後濾掉所有 UI 殘留節點
        const cleanContent = () => {
          const raw = ed.getContent();
// 用 DOMParser 解析，移除任何含 UI class / data-kc-ui 標記的節點
          const doc = new DOMParser().parseFromString(
            '<div>' + raw + '</div>', 'text/html'
          );
          const root = doc.body.firstChild;
          if (root) {
            root.querySelectorAll(
              '#kc-toolbar, [data-kc-ui], ' +
              '.tox, [class*="tox-"], [class^="tox-"]'
            ).forEach(n => n.remove());
            restorePristineImages(root);
            markRemoteImages(root);
return normalizeMailHtml(root.innerHTML);
          }
          return raw;
        };

        const sync = debounce(() => {
          if (editorDisabled) return;   // 已停用：port 已斷線，不再回報內容
          port.postMessage({ action: 'syncContent', html: cleanContent() });
        }, SYNC_DEBOUNCE_MS);
        ed.on('input change keyup paste', sync);

        port.onMessage.addListener(msg => {
          if (msg.action === 'requestContent') {
port.postMessage({ action: 'content', html: cleanContent() });
          } else if (msg.action === 'prepareForSend') {
// 1. 停掉 MutationObserver 還原邏輯
            window.__kc_setSending?.(true);
            // 2. 從整個 document 徹底移除所有 UI 元素（不能只搬到 html，
            //    因為 Thunderbird 序列化的是整份 HTML 不只 body）
            try {
              document.querySelectorAll(
                '#kc-toolbar, [data-kc-ui], .tox, .tox-tinymce, ' +
                '.tox-tinymce-inline, .tox-tinymce-aux, .tox-silver-sink'
              ).forEach(n => n.remove());
            } catch (_) {}
            // 3. 回應 ack
            port.postMessage({ action: 'prepareForSendAck' });
          }
        });
      });
      ed.on('LoadError', err => {
        console.error('[TinyMCE Composer] LoadError:', err);
      });
    }
  });

})().catch(err => {
  console.error('[TinyMCE Composer] 主流程錯誤:', err);
});
