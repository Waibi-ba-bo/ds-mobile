/**
 * 极简 Markdown 渲染器：只覆盖聊天里常见的语法。
 * 先转义 HTML，再把代码块/行内代码抽成占位符，最后回填，避免 XSS。
 */

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

export function renderMarkdown(source) {
  if (!source) return "";

  const text = String(source).replace(/\r\n?/g, "\n");
  const blocks = [];
  const stash = (html) => {
    blocks.push(html);
    return `\u0000${blocks.length - 1}\u0000`;
  };

  // 1. 围栏代码块（未闭合时把剩余内容都当作代码，流式输出更友好）
  const withoutFences = text.replace(
    /```([a-zA-Z0-9_+#.-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g,
    (_match, lang, code) => {
      const language = lang || "code";
      const body = escapeHtml(code.replace(/\n$/, ""));
      return stash(
        `<div class="code-block"><div class="code-head"><span>${escapeHtml(language)}</span>` +
          `<button class="copy-code" type="button">复制</button></div>` +
          `<pre><code class="language-${escapeHtml(language)}">${body}</code></pre></div>`
      );
    }
  );

  // 2. 转义剩余文本
  const escaped = escapeHtml(withoutFences);

  const inline = (value) =>
    value
      .replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${code}</code>`))
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, label, url) =>
          `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
      )
      .replace(
        /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (_m, prefix, url) =>
          `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      );

  const lines = escaped.split("\n");
  const out = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:[-*_])\s*(?:[-*_]\s*){2,}$/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (/^\s*(?:&gt;|>)\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*(?:&gt;|>)\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const item = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        items.push(`<li>${inline(item[1])}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d{1,3}[.)]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const item = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        items.push(`<li>${inline(item[1])}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();

  return out.join("").replace(/\u0000(\d+)\u0000/g, (_m, index) => blocks[Number(index)]);
}
