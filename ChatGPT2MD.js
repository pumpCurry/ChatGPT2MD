javascript:void (async () => {
  'use strict';

  const EXPORT_VERSION = '1.3.0-leading-footnotes';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const thread =
    document.querySelector('#thread') ||
    document.querySelector('main') ||
    document.body;

  const scroller = document.scrollingElement || document.documentElement;

  const pad2 = (n) => String(n).padStart(2, '0');

  function sanitizeFilename(name) {
    const s = String(name || '').trim() || 'chatgpt';
    return s
      .replace(/[\\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
  }

  function makeFilename() {
    const title = sanitizeFilename(
      (document.title || 'chatgpt').replace(/^ChatGPT\s*[-–—]\s*/i, '')
    );
    const now = new Date();
    const stamp =
      now.getFullYear() +
      '-' +
      pad2(now.getMonth() + 1) +
      '-' +
      pad2(now.getDate()) +
      '_' +
      pad2(now.getHours()) +
      pad2(now.getMinutes()) +
      pad2(now.getSeconds());
    return stamp + '_' + title + '.md';
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  // ざっくりUI内の “もっと見る” を開く（存在すれば）
  function clickExpandButtons() {
    const patterns = [
      /Show more/i, /Expand/i, /Continue/i,
      /続きを読む/, /もっと見る/, /さらに表示/, /生成を続ける/
    ];
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').trim();
      if (!t) continue;
      if (patterns.some((re) => re.test(t))) {
        try { b.click(); } catch (_) {}
      }
    }
  }

  /**
   * 仮想化対策：上/下に動かして turn が安定するまで待つ
   * ※ 重すぎる環境では回数を減らしてください
   */
  async function ensureTurnsLoaded(maxCycles = 20) {
    let stable = 0;
    let last = 0;
    for (let i = 0; i < maxCycles && stable < 3; i++) {
      scroller.scrollTop = 0;
      await sleep(200);
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(200);
      const count = thread.querySelectorAll('article[data-testid^="conversation-turn-"]').length;
      if (count === last) stable++;
      else stable = 0;
      last = count;
    }
  }

  function textOf(el) {
    return (el && (el.innerText || el.textContent) ? (el.innerText || el.textContent) : '')
      .replace(/\r\n/g, '\n');
  }

  function collapseWs(s) {
    return String(s || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  function mdEscapeInline(s) {
    return String(s || '').replace(/`/g, '\\`');
  }

  function codeFence(code, lang) {
    const c = String(code || '').replace(/\n+$/g, '');
    const l = (lang || '').trim();
    return '```' + l + '\n' + c + '\n```';
  }

  // ---- HTML -> Markdown（簡易）----
  function nodeToMd(node, ctx) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue || '';
      if (ctx.inCode) return t;
      return mdEscapeInline(t);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const renderChildren = (childCtx = ctx) => {
      let out = '';
      for (const ch of Array.from(node.childNodes)) out += nodeToMd(ch, childCtx);
      return out;
    };

    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n---\n';

    if (tag === 'code') {
      const parent = node.parentElement ? node.parentElement.tagName.toLowerCase() : '';
      if (parent === 'pre') return '';
      const inner = textOf(node);
      if (inner.includes('`')) return '``' + inner + '``';
      return '`' + inner + '`';
    }

    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const label = renderChildren(ctx).trim() || href;
      if (!href) return label;
      return '[' + label + '](' + href.replace(/\)/g, '\\)') + ')';
    }

    if (tag === 'strong' || tag === 'b') return '**' + renderChildren(ctx).trim() + '**';
    if (tag === 'em' || tag === 'i') return '*' + renderChildren(ctx).trim() + '*';
    if (tag === 'del' || tag === 's') return '~~' + renderChildren(ctx).trim() + '~~';

    if (tag === 'pre') {
      const codeEl = node.querySelector('code');
      const code = textOf(codeEl || node);
      const lang =
        codeEl
          ? (codeEl.getAttribute('class') || '').match(/language-([a-z0-9_+-]+)/i)?.[1]
          : '';
      return '\n' + codeFence(code, lang || '') + '\n\n';
    }

    if (tag.match(/^h[1-6]$/)) {
      const level = Number(tag.slice(1));
      const txt = collapseWs(textOf(node)).trim();
      return '\n' + '#'.repeat(level) + ' ' + txt + '\n\n';
    }

    if (tag === 'p') {
      const txt = collapseWs(renderChildren({ ...ctx, inParagraph: true })).trim();
      if (!txt) return '';
      return txt + '\n\n';
    }

    if (tag === 'blockquote') {
      const inner = collapseWs(renderChildren(ctx)).trim();
      if (!inner) return '';
      const lines = inner.split('\n').map((l) => '> ' + l).join('\n');
      return '\n' + lines + '\n\n';
    }

    // list（簡易）
    if (tag === 'ul' || tag === 'ol') {
      const isOl = tag === 'ol';
      let idx = 1;
      let out = '\n';
      for (const li of Array.from(node.children)) {
        if (li.tagName?.toLowerCase() !== 'li') continue;
        const body = collapseWs(renderChildren.call(li, { ...ctx, inListItem: true })).trim();
        const mark = isOl ? `${idx++}. ` : `- `;
        out += mark + body.replace(/\n/g, '\n  ') + '\n';
      }
      return out + '\n';
    }

    // その他は子供をそのまま
    return renderChildren(ctx);
  }

  function htmlToMarkdown(rootEl) {
    if (!rootEl) return '';
    const md = nodeToMd(rootEl, { inCode: false });
    return collapseWs(md).trim();
  }

  // ---- leading 抽出（思考時間＋学習/ツール活動を分ける）----
  const RE_THINK = /(思考時間|Thought for)\s*[:：]?\s*\d+\s*[smh]/i;

  function extractLeadingObjects(article) {
    // 以前のDOM例に合わせ、min-h-6 っぽい領域から拾う
    const header =
      article.querySelector('.relative.my-1.min-h-6') ||
      article.querySelector('[class*="min-h-6"]') ||
      null;
    if (!header) return [];

    const candidates = Array.from(
      header.querySelectorAll('.min-w-0.truncate, .truncate')
    );

    const items = [];
    for (const el of candidates) {
      const visible = (el.innerText || el.textContent || '').trim();
      if (!visible) continue;

      // 省略されてない全文が取れるなら優先
      const title = (el.getAttribute('title') || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const full = (title && title.length > visible.length) ? title :
                   (aria && aria.length > visible.length) ? aria :
                   visible;

      // 「ChatGPT:」「あなた:」などは除外
      if (/^(you|あなた|chatgpt)\s*:?\s*$/i.test(visible)) continue;

      items.push({ visible, full });
    }

    // 重複排除（full基準）
    const seen = new Set();
    return items.filter((it) => {
      const k = it.full;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function splitLeading(items) {
    const think = items.find((it) => RE_THINK.test(it.visible) || RE_THINK.test(it.full)) || null;
    const others = items.filter((it) => it !== think);
    return { think, others };
  }

  // ---- 会話日時メタ（あれば）----
  function extractConversationMetaFromNextData() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;
    let json = null;
    try { json = JSON.parse(script.textContent || 'null'); } catch (_) { return null; }
    if (!json) return null;

    // よくある場所を先に当てに行く
    const pp = json?.props?.pageProps;
    const directCandidates = [
      pp?.conversation,
      pp?.thread,
      pp?.serverResponse?.conversation,
      pp?.serverResponse?.thread
    ].filter(Boolean);

    const KEYSET = new Set([
      'create_time', 'update_time',
      'created_at', 'updated_at',
      'createdAt', 'updatedAt'
    ]);

    const normalizeTime = (v) => {
      // ISO文字列
      if (typeof v === 'string') {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
        return null;
      }
      // 秒 or ミリ秒っぽい数値
      if (typeof v === 'number') {
        const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
        if (!ms) return null;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
      return null;
    };

    const pickFromObj = (obj) => {
      const out = {};
      for (const k of KEYSET) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
          const iso = normalizeTime(obj[k]);
          if (iso) out[k] = iso;
        }
      }
      return Object.keys(out).length ? out : null;
    };

    for (const cand of directCandidates) {
      const got = pickFromObj(cand);
      if (got) return got;
    }

    // 無ければ浅めに探索（重くしない）
    const queue = [{ v: json, depth: 0 }];
    const visited = new Set();
    let steps = 0;
    while (queue.length && steps < 15000) {
      steps++;
      const { v, depth } = queue.shift();
      if (!v || typeof v !== 'object') continue;
      if (visited.has(v)) continue;
      visited.add(v);

      const got = pickFromObj(v);
      if (got) return got;

      if (depth >= 8) continue;
      for (const key of Object.keys(v)) {
        const child = v[key];
        if (child && typeof child === 'object') queue.push({ v: child, depth: depth + 1 });
      }
    }

    return null;
  }

  // ---- 実行 ----
  clickExpandButtons();
  await ensureTurnsLoaded();
  clickExpandButtons();

  const articles = Array.from(thread.querySelectorAll('article[data-testid^="conversation-turn-"]'));

  // 末尾に積む脚注ブロック
  const leadingFootnotes = []; // { id, turnId, lines[] }

  let userCount = 0;
  let assistantCount = 0;
  let skipped = 0;

  const blocks = [];

  let turnIndex = 0;
  for (const article of articles) {
    turnIndex++;

    // role
    const role =
      article.getAttribute('data-turn') ||
      article.querySelector('div[data-message-author-role]')?.getAttribute('data-message-author-role') ||
      'unknown';

    const turnId = `turn-${turnIndex}`;

    // content-visibility 対策（assistantが空になることがある）
    if (role === 'assistant') {
      try {
        article.style.contentVisibility = 'visible';
        article.style.contain = 'none';
        article.style.containIntrinsicSize = 'none';
      } catch (_) {}
    }

    // message root（複数があるケースに備えるが、基本1つ）
    const msgEls = Array.from(article.querySelectorAll('div[data-message-author-role]'));
    if (!msgEls.length) { skipped++; continue; }

    const parts = [];

    for (const msgEl of msgEls) {
      const r = msgEl.getAttribute('data-message-author-role') || role;

      if (r === 'user') {
        const txtRoot = msgEl.querySelector('.whitespace-pre-wrap') || msgEl;
        let txt = collapseWs(textOf(txtRoot)).trim();
        if (!txt) {
          txtRoot.scrollIntoView({ block: 'center' });
          await sleep(50);
          txt = collapseWs(textOf(txtRoot)).trim();
        }
        if (txt) parts.push(txt);
      } else if (r === 'assistant') {
        const mdRoot = msgEl.querySelector('.markdown') || msgEl.querySelector('[data-testid="message-content"]') || msgEl;
        let md = htmlToMarkdown(mdRoot);
        if (!md) {
          mdRoot.scrollIntoView({ block: 'center' });
          await sleep(50);
          md = htmlToMarkdown(mdRoot);
        }
        if (!md) {
          // 最終フォールバック
          md = collapseWs(textOf(mdRoot)).trim();
        }
        if (md) parts.push(md);
      } else {
        const txt = collapseWs(textOf(msgEl)).trim();
        if (txt) parts.push(txt);
      }
    }

    const body = parts.join('\n\n---\n\n').trim();
    if (!body) { skipped++; continue; }

    const who = role === 'user' ? 'あなた' : role === 'assistant' ? 'ChatGPT' : role;

    // leading の処理（assistantのみ）
    let leadBlock = '';
    if (role === 'assistant') {
      const leadItems = extractLeadingObjects(article);
      const { think, others } = splitLeading(leadItems);

      // “思考時間”表示（あれば）
      if (think) {
        // others があれば脚注に積んでリンク作成
        if (others.length) {
          const footId = `leading-${leadingFootnotes.length + 1}`;
          leadingFootnotes.push({
            id: footId,
            turnId,
            lines: others.map((x) => x.full || x.visible).filter(Boolean)
          });
          leadBlock += `> [leading] ${think.visible} [details](#${footId})\n\n`;
        } else {
          leadBlock += `> [leading] ${think.visible}\n\n`;
        }
      } else if (others.length) {
        // 思考時間が無いが leading がある場合は、最初の行にリンク
        const footId = `leading-${leadingFootnotes.length + 1}`;
        leadingFootnotes.push({
          id: footId,
          turnId,
          lines: others.map((x) => x.full || x.visible).filter(Boolean)
        });
        leadBlock += `> [leading] [details](#${footId})\n\n`;
      }
    }

    if (role === 'user') userCount++;
    if (role === 'assistant') assistantCount++;

    blocks.push(
      `## ${who}\n` +
      `<a id="${turnId}"></a>\n\n` +
      leadBlock +
      body +
      `\n`
    );
  }

  const meta = extractConversationMetaFromNextData();

  const headerLines = [
    '# ChatGPT Conversation Export',
    '',
    `- Exporter: ${EXPORT_VERSION}`,
    `- Exported at: ${new Date().toISOString()}`,
    `- URL: ${location.href}`,
    `- Turns in DOM: ${articles.length} (user:${userCount}, assistant:${assistantCount}, skipped:${skipped})`
  ];

  if (meta) {
    // 会話日時っぽいものがあれば付与
    for (const [k, v] of Object.entries(meta)) {
      headerLines.push(`- Meta: ${k} = ${v}`);
    }
  }

  headerLines.push('', '---', '');

  let out = headerLines.join('\n') + blocks.join('\n---\n\n');

  // 末尾に leading 脚注ブロックを並べる
  if (leadingFootnotes.length) {
    out += '\n\n---\n\n';
    out += '## Leading details\n\n';
    for (const f of leadingFootnotes) {
      out += `<a id="${f.id}"></a>\n`;
      out += `### ${f.id}\n\n`;
      out += f.lines.map((l) => `- ${l}`).join('\n') + '\n\n';
      out += `[back](#${f.turnId})\n\n`;
    }
  }

  const filename = makeFilename();
  downloadText(filename, out);

  alert(
    `Saved: ${filename}\n` +
    `(user:${userCount} assistant:${assistantCount} skipped:${skipped} leadingBlocks:${leadingFootnotes.length})\n\n` +
    `※ leading が見つからない場合：そのターンに leading 表示が無い/DOMが変わった可能性があります`
  );
})();
