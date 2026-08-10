// HTML → Markdown, without the Workers AI binding.
//
// `webFetch` delegates document conversion to `env.WORKERS_AI.toMarkdown()`. A deployment with no
// Workers AI binding has no such utility, and the call fails on the single most common case an
// agent hits — an ordinary web page. This covers HTML specifically; the binary formats
// (PDF, DOCX, XLSX, ODT, Numbers) genuinely need a document converter and are reported as
// unsupported rather than returned as garbage.
//
// Built on HTMLRewriter, which workerd provides natively. That matters more than it might seem:
// real-world HTML is malformed constantly, and a regex-based extractor produces plausible-looking
// wrong output on exactly the pages worth reading. HTMLRewriter is a real streaming parser.

// Elements whose contents are never prose.
const DROPPED = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
  "head", "nav", "footer", "form", "button", "select", "textarea",
]);

// Block-level elements that should be separated by a blank line.
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "aside", "table", "tr",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "br",
]);

type Frame = { tag: string; listIndex?: number; ordered?: boolean };

class MarkdownCollector {
  #out: string[] = [];
  #stack: Frame[] = [];
  #dropDepth = 0;
  #linkHref: string | null = null;
  #baseUrl: URL | null;

  constructor(baseUrl: URL | null) {
    this.#baseUrl = baseUrl;
  }

  get dropping() { return this.#dropDepth > 0; }

  enterDropped() { this.#dropDepth++; }
  exitDropped() { if (this.#dropDepth > 0) this.#dropDepth--; }

  push(tag: string, attrs: { href?: string | null; src?: string | null; alt?: string | null }) {
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        this.#break(2);
        this.#out.push("#".repeat(Number(tag[1])) + " ");
        break;
      case "ul": case "ol":
        this.#break(this.#listDepth() > 0 ? 1 : 2);
        this.#stack.push({ tag, listIndex: 0, ordered: tag === "ol" });
        return;
      case "li": {
        this.#break(1);
        const list = [...this.#stack].reverse().find(f => f.tag === "ul" || f.tag === "ol");
        const indent = "  ".repeat(Math.max(0, this.#listDepth() - 1));
        if (list?.ordered) {
          list.listIndex = (list.listIndex ?? 0) + 1;
          this.#out.push(`${indent}${list.listIndex}. `);
        } else {
          this.#out.push(`${indent}- `);
        }
        break;
      }
      case "blockquote": this.#break(2); this.#out.push("> "); break;
      case "pre": this.#break(2); this.#out.push("```\n"); break;
      case "code": if (!this.#inside("pre")) this.#out.push("`"); break;
      case "strong": case "b": this.#out.push("**"); break;
      case "em": case "i": this.#out.push("_"); break;
      case "hr": this.#break(2); this.#out.push("---"); this.#break(2); break;
      case "br": this.#out.push("\n"); break;
      case "a":
        // Only treat it as a link if it goes somewhere; bare anchors are noise.
        this.#linkHref = this.#resolve(attrs.href ?? null);
        if (this.#linkHref) this.#out.push("[");
        break;
      case "img": {
        const src = this.#resolve(attrs.src ?? null);
        const alt = (attrs.alt ?? "").trim();
        // Images are kept as a reference, never fetched or described — the upstream path
        // deliberately avoids paid image models, and this keeps that property.
        if (src) this.#out.push(`![${alt}](${src})`);
        else if (alt) this.#out.push(`![${alt}]`);
        break;
      }
      default:
        if (BLOCK.has(tag)) this.#break(2);
    }
    this.#stack.push({ tag });
  }

  pop(tag: string) {
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        this.#break(2); break;
      case "ul": case "ol": this.#break(2); break;
      case "li": break;
      case "pre": this.#break(1); this.#out.push("```"); this.#break(2); break;
      case "code": if (!this.#inside("pre", 1)) this.#out.push("`"); break;
      case "strong": case "b": this.#out.push("**"); break;
      case "em": case "i": this.#out.push("_"); break;
      case "a":
        if (this.#linkHref) {
          this.#out.push(`](${this.#linkHref})`);
          this.#linkHref = null;
        }
        break;
      case "p": case "blockquote": case "table": this.#break(2); break;
      case "td": case "th": this.#out.push(" | "); break;
      case "tr": this.#break(1); break;
      default:
        if (BLOCK.has(tag)) this.#break(1);
    }
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      if (this.#stack[i].tag === tag) { this.#stack.splice(i, 1); break; }
    }
  }

  text(chunk: string) {
    if (this.dropping) return;
    // HTMLRewriter emits a zero-length chunk to mark the end of each text node. Treating it as
    // whitespace would insert a space before every closing marker — "`fetch() `" rather than
    // "`fetch()`".
    if (chunk === "") return;

    // Inside <pre>, whitespace is content.
    if (this.#inside("pre")) { this.#out.push(chunk); return; }

    const value = chunk.replace(/\s+/g, " ");
    // Whitespace between tags is a word separator and must survive, or "alpha</span> <span>beta"
    // becomes "alphabeta". Emit at most one space, and only where one is not already present —
    // a blanket collapse in toString() cannot be used, because it would also eat list indentation
    // and the contents of <pre>.
    if (value === " ") {
      const last = this.#out[this.#out.length - 1];
      if (last !== undefined && !/\s$/.test(last)) this.#out.push(" ");
      return;
    }
    this.#out.push(value);
  }

  toString(): string {
    return this.#out.join("")
        .replace(/[ \t]+\n/g, "\n")      // trailing spaces
        .replace(/\n{3,}/g, "\n\n")      // at most one blank line
        .replace(/^\s+|\s+$/g, "");      // trim
  }

  #break(count: number) {
    const text = this.#out.join("");
    if (text === "") return;
    const existing = /\n*$/.exec(text)![0].length;
    if (existing < count) this.#out.push("\n".repeat(count - existing));
  }

  #inside(tag: string, skipLast = 0): boolean {
    const stack = skipLast ? this.#stack.slice(0, -skipLast) : this.#stack;
    return stack.some(f => f.tag === tag);
  }

  #listDepth(): number {
    return this.#stack.filter(f => f.tag === "ul" || f.tag === "ol").length;
  }

  // Relative links are useless to an agent that cannot resolve them, so make them absolute
  // against the page's own URL — the same thing toMarkdown's `hostname` option does.
  #resolve(href: string | null): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    if (trimmed === "" || trimmed.startsWith("javascript:")) return null;
    if (!this.#baseUrl) return trimmed;
    try {
      return new URL(trimmed, this.#baseUrl).toString();
    } catch {
      return trimmed;
    }
  }
}

export async function htmlToMarkdown(html: string, baseUrl?: URL | string): Promise<string> {
  const base = baseUrl === undefined ? null
      : (typeof baseUrl === "string" ? safeUrl(baseUrl) : baseUrl);
  const collector = new MarkdownCollector(base);

  const rewriter = new HTMLRewriter()
      .on("*", {
        element(element) {
          const tag = element.tagName.toLowerCase();
          if (DROPPED.has(tag)) {
            collector.enterDropped();
            element.onEndTag(() => collector.exitDropped());
            return;
          }
          if (collector.dropping) return;
          collector.push(tag, {
            href: element.getAttribute("href"),
            src: element.getAttribute("src"),
            alt: element.getAttribute("alt"),
          });
          // Void elements never get an end tag; popping them here would be wrong.
          if (!VOID.has(tag)) {
            element.onEndTag(() => collector.pop(tag));
          }
        },
      })
      // Text is handled at the document level, not per element. An element-scoped text handler
      // only sees text *inside* a matched element, so whitespace between siblings is never
      // delivered and "alpha</span> <span>beta" collapses to "alphabeta". The document handler
      // receives every text node, interleaved with the element handlers in document order.
      .onDocument({
        text(chunk) {
          collector.text(chunk.text);
        },
      });

  // The rewriter is only being used as a parser; the transformed output is discarded.
  await rewriter.transform(new Response(html)).arrayBuffer();
  return collector.toString();
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "area", "col"]);

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
