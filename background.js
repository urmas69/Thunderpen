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

          // 轉寄／回覆時：Thunderbird 會把原信中的遠端圖片快取到本地，
          // 使 src 變成 mailbox://... 收件人無法解析。這裡讀取原信、
          // 按順序把 mailbox 圖片還原成原本的 http/https URL。
          if (details.relatedMessageId && details.body) {
            try {
              details.body = await restoreRemoteImageUrls(
                details.body, details.relatedMessageId
              );
            } catch (e) {
              console.warn('[TinyMCE] restoreRemoteImageUrls failed:', e);
            }
          }

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

messenger.compose.onBeforeSend.addListener(async (tab) => {
  const port = composePorts.get(tab.id);
  if (!port) return {};

  const cached = latestContent.get(tab.id);

  // 1. 先要求 compose script 把 toolbar 移出 body，並等待 ack
  const ackPromise = new Promise((resolve) => {
    const t = setTimeout(() => { pendingAcks.delete(tab.id); resolve(); }, 1000);
    pendingAcks.set(tab.id, () => { clearTimeout(t); resolve(); });
  });
  try { port.postMessage({ action: 'prepareForSend' }); } catch (_) {}
  await ackPromise;

  // 2. 取得乾淨內容
  const html = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingResolvers.delete(tab.id);
      resolve(cached ?? '');
    }, 3000);
    pendingResolvers.set(tab.id, (content) => {
      clearTimeout(timeout);
      resolve(content);
    });
    try { port.postMessage({ action: 'requestContent' }); }
    catch (_) { clearTimeout(timeout); pendingResolvers.delete(tab.id); resolve(cached ?? ''); }
  });

  // 診斷用：送出前最終要寫回 body 的字串裡，img 標籤實際長怎樣
  console.log('[TinyMCE BG] onBeforeSend 最終 html 裡的 <img>：',
    html.match(/<img[^>]*>/gi) || []);

  // 3. 明確呼叫 setComposeDetails 寫回 body
  try {
    await messenger.compose.setComposeDetails(tab.id, { body: html });
  } catch (e) {
    console.error('[TinyMCE BG] setComposeDetails on send failed:', e);
  }

  // 4. 同時走 return details 路徑（雙保險）
  return { details: { body: html } };
});


// ── 遠端圖片 URL 還原 ─────────────────────────────────────────────────────
// 當 compose 是 reply/forward 時，Thunderbird 會把原信的遠端圖片快取為
// mailbox:// 本地路徑，寄出後收件人無法載入。本區塊：
// 1. 讀取原始信件（messenger.messages.getFull）
// 2. 從原信 HTML 抓出所有 <img> 的原始 src（http/https）
// 3. 依「圖片出現順序」把 compose body 中的 mailbox:// 替換回原始 URL

async function restoreRemoteImageUrls(currentHtml, relatedMessageId) {
  // 先看 compose body 是否真的有 mailbox:// 圖片，沒有就不必查原信
  if (!/src=["']mailbox:/i.test(currentHtml)) return currentHtml;

  // 取原信 HTML 部分
  const full = await messenger.messages.getFull(relatedMessageId);
  const originalHtml = findFirstHtmlPart(full);
  if (!originalHtml) return currentHtml;

  const parser = new DOMParser();
  const cur = parser.parseFromString(currentHtml, 'text/html');
  const org = parser.parseFromString(originalHtml, 'text/html');

  const curImgs = Array.from(cur.querySelectorAll('img'));
  const orgImgs = Array.from(org.querySelectorAll('img'));

  const n = Math.min(curImgs.length, orgImgs.length);
  let replaced = 0;
  for (let i = 0; i < n; i++) {
    const curSrc = curImgs[i].getAttribute('src') || '';
    const orgSrc = orgImgs[i].getAttribute('src') || '';
    if (/^mailbox:/i.test(curSrc) && /^https?:/i.test(orgSrc)) {
      curImgs[i].setAttribute('src', orgSrc);
      replaced++;
    }
  }

  if (replaced === 0) return currentHtml;
  return cur.body.innerHTML;
}

/** 遞迴走訪 MessagePart 樹，找出第一個 text/html 部分的 body */
function findFirstHtmlPart(part) {
  if (!part) return null;
  const type = (part.contentType || '').toLowerCase();
  if (type === 'text/html' && part.body) return part.body;
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const html = findFirstHtmlPart(p);
      if (html) return html;
    }
  }
  return null;
}
