/**
 * background.js
 * 管理 compose scripts 的注入、與各撰寫視窗的連線、以及儲存/送出前的內容同步。
 */

'use strict';

// tabId -> Port 對應表
const composePorts = new Map();
// tabId -> 最新 HTML 內容（連續同步用）
const latestContent = new Map();

// ── 註冊 Compose Scripts ────────────────────────────────────────────────────

let _composeRegistration = null;

(async function () {
  try {
    // 先 unregister 舊的（防止重複註冊堆疊）
    if (_composeRegistration && _composeRegistration.unregister) {
      try { await _composeRegistration.unregister(); } catch (_) {}
    }
    _composeRegistration = await messenger.composeScripts.register({
      js:  [{ file: 'compose/inject.js'  }],
      css: [{ file: 'compose/inject.css' }]
    });
  } catch (e) {
    console.error('[TinyMCE BG] composeScripts 註冊失敗:', e);
  }
})();

// ── Port 連線管理 ────────────────────────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'compose-editor') return;

  const tab = port.sender?.tab;
  if (!tab) return;

  const tabId = tab.id;
  composePorts.set(tabId, port);

  port.onDisconnect.addListener(() => {
    composePorts.delete(tabId);
    latestContent.delete(tabId);
  });

  port.onMessage.addListener(async (msg) => {
    switch (msg.action) {
      // Compose script 要求取得初始內文
      case 'getComposeDetails': {
        try {
          const details = await messenger.compose.getComposeDetails(tabId);

          // Do not restore original remote image URLs: this can reintroduce tracking pixels.
          port.postMessage({ action: 'composeDetails', details });
        } catch (e) {
          console.error('[TinyMCE] getComposeDetails failed:', e);
          port.postMessage({ action: 'composeDetails', details: { body: '', isPlainText: false } });
        }
        break;
      }

      // Compose script 定期推送最新 HTML — 只快取，不立刻 setComposeDetails
      // （setComposeDetails 會觸發 Thunderbird 重繪 body，導致 TinyMCE DOM 被清掉）
      case 'syncContent': {
        latestContent.set(tabId, msg.html);
        break;
      }

      // Save Draft 等 Thunderbird 內部路徑可能直接讀 body.innerHTML，
      // 這時 compose script 主動推送並要求即時 setComposeDetails
      case 'flushContent': {
        latestContent.set(tabId, msg.html);
        try {
          await messenger.compose.setComposeDetails(tabId, { body: msg.html });
        } catch (_) {}
        break;
      }

      // Compose script 回應 requestContent（送出前最後確認）
      case 'content': {
        const resolver = pendingResolvers.get(tabId);
        if (resolver) {
          pendingResolvers.delete(tabId);
          resolver(msg.html);
        }
        break;
      }

      // Compose script 回應 prepareForSend 已完成
      case 'prepareForSendAck': {
        const ack = pendingAcks.get(tabId);
        if (ack) {
          pendingAcks.delete(tabId);
          ack();
        }
        break;
      }
    }
  });
});

// ── 送出前同步 ───────────────────────────────────────────────────────────────

/** tabId -> resolve function，用於等待 compose script 回傳內容 */
const pendingResolvers = new Map();

/** tabId -> ack resolver */
const pendingAcks = new Map();

// Never send cached, empty or potentially stale HTML if the editor fails to respond.
// Fetch content BEFORE removing the toolbar so a failed request leaves the editor usable.
messenger.compose.onBeforeSend.addListener(async (tab) => {
  const port = composePorts.get(tab.id);
  if (!port) return {}; // The user may have switched back to Thunderbird's native editor.

  let html;
  try {
    html = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResolvers.delete(tab.id);
        reject(new Error('Editor did not return its latest content within 3 seconds'));
      }, 3000);
      pendingResolvers.set(tab.id, (content) => {
        clearTimeout(timeout);
        resolve(content);
      });
      try { port.postMessage({ action: 'requestContent' }); }
      catch (error) {
        clearTimeout(timeout);
        pendingResolvers.delete(tab.id);
        reject(error);
      }
    });
    if (typeof html !== 'string') throw new Error('Editor returned invalid HTML content');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingAcks.delete(tab.id);
        reject(new Error('Editor did not acknowledge send preparation'));
      }, 1000);
      pendingAcks.set(tab.id, () => {
        clearTimeout(timeout);
        resolve();
      });
      try { port.postMessage({ action: 'prepareForSend' }); }
      catch (error) {
        clearTimeout(timeout);
        pendingAcks.delete(tab.id);
        reject(error);
      }
    });

    await messenger.compose.setComposeDetails(tab.id, { body: html });
    return { details: { body: html } };
  } catch (error) {
    console.error('[Thunderpen] Send cancelled: editor synchronization failed:', error);
    return { cancel: true };
  }
});
