/**
 * page-init.js
 * 注入到「頁面環境」執行（about:blank?compose）。
 * TinyMCE 在這裡初始化；與 compose script 透過 CustomEvent 通訊。
 *
 * 由 inject.js 在注入前以字串替換 __TINYMCE_BASE__。
 */

console.log('[TinyMCE page-init] 腳本開始執行');
console.log('[TinyMCE page-init] window.tinymce 型別:', typeof window.tinymce);

(function () {
  'use strict';

  const TINYMCE_BASE = '__TINYMCE_BASE__';

  // ── 跨環境訊息橋接 ───────────────────────────────────────────────────────
  // 從 compose script 收到的事件：'kc:requestContent'
  // 送往 compose script 的事件：'kc:contentChanged', 'kc:contentResponse', 'kc:ready'
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, {
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {})
    }));
  }

  // ── 防止重複 ─────────────────────────────────────────────────────────────
  if (window.__kcInited) return;
  window.__kcInited = true;

  // ── 格式複製外掛 ──────────────────────────────────────────────────────────
  function registerFormatPainter() {
    let saved = null, painting = false;
    tinymce.PluginManager.add('kc_fp', (ed) => {
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
        tooltip: 'Copy current formatting, then select text to apply it',
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
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ── 主流程 ────────────────────────────────────────────────────────────────
  if (typeof tinymce === 'undefined') {
    console.error('[TinyMCE page-init] tinymce 全域不存在');
    return;
  }
  console.log('[TinyMCE page-init] tinymce =', typeof tinymce, 'version=', tinymce.majorVersion);

  registerFormatPainter();

  tinymce.init({
    selector: '#kc-content',
    inline: true,
    toolbar_persist: true,
    fixed_toolbar_container: '#kc-toolbar',

    plugins: [
      'advlist', 'autolink', 'lists', 'link', 'image', 'charmap',
      'anchor', 'searchreplace', 'visualblocks', 'code',
      'insertdatetime', 'media', 'table', 'wordcount', 'kc_fp'
    ],
    toolbar:
      'undo redo | kc_fp | ' +
      'bold italic underline strikethrough | ' +
      'forecolor backcolor | ' +
      'alignleft aligncenter alignright | ' +
      'bullist numlist outdent indent | ' +
      'table | image link | removeformat | code',
    menubar: 'edit view insert format tools table',
    toolbar_mode: 'wrap',

    base_url: TINYMCE_BASE,
    suffix: '.min',
    promotion: false,
    branding: false,

    images_upload_handler: function (blobInfo) {
      return new Promise(function (res) {
        const r = new FileReader();
        r.onload = function (ev) { res(ev.target.result); };
        r.readAsDataURL(blobInfo.blob());
      });
    },
    image_advtab: true,

    content_style:
      '#kc-content { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",' +
      '"Microsoft JhengHei", "PingFang TC", sans-serif; font-size: 14px;' +
      'line-height: 1.6; padding: 8px 12px; color: #1a1a1a; }' +
      'table { border-collapse: collapse; }' +
      'td, th { border: 1px solid #ccc; padding: 4px 8px; }',

    setup: function (ed) {
      ed.on('init', function () {
        // 移除 loading banner
        const b = document.getElementById('_kc_loading');
        if (b) b.remove();

        // 工具列彈出層不可被 designMode 編輯
        document.querySelectorAll('.tox-tinymce-aux, .tox-silver-sink')
          .forEach(function (el) { el.contentEditable = 'false'; });

        // 內容變更 → 通知 compose script
        const sync = debounce(function () {
          emit('kc:contentChanged', { html: ed.getContent() });
        }, 600);
        ed.on('input change keyup paste', sync);

        // compose script 要求最新內容
        document.addEventListener('kc:requestContent', function () {
          emit('kc:contentResponse', { html: ed.getContent() });
        });

        emit('kc:ready', {});
        console.log('[TinyMCE page-init] init 完成');
      });
      ed.on('LoadError', function (err) {
        console.error('[TinyMCE page-init] LoadError:', err);
      });
    }
  });

})();
