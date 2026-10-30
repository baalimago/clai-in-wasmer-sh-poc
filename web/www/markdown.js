// The agent's markdown as HTML for the page. What it writes is not trusted: raw HTML shows as
// text, images as their description, and only http(s) links leave the page. A link to a file
// of the notebook (file:///home/user/notebook/meetings/…, or meetings/… itself) opens it in
// the app instead: its `data-note` is the path under the notebook.
import { Marked } from "../node_modules/marked/lib/marked.esm.js";

const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// The path under the notebook that `href` names, if it names one.
export function notePath(href) {
  const path = decodeURI(href.replace(/^file:\/\//, ""));
  const at = path.search(/(^|\/)meetings\//);
  if (at < 0) return null;
  return path.slice(path[at] === "/" ? at + 1 : at);
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(text),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const note = notePath(href);
      if (note) return `<a href="#" data-note="${escape(note)}">${text}</a>`;
      if (/^https?:\/\//i.test(href)) return `<a href="${escape(href)}" target="_blank" rel="noopener">${text}</a>`;
      return text;
    },
  },
});

export const renderMarkdown = (text) => marked.parse(text, { async: false });
