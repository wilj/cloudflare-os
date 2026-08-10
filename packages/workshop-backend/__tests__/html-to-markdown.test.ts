import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/html-to-markdown';

const md = (html: string, base?: string) => htmlToMarkdown(html, base);

describe('structure', () => {
  it('converts headings and paragraphs', async () => {
    const out = await md('<h1>Title</h1><p>First.</p><h2>Sub</h2><p>Second.</p>');
    expect(out).toBe('# Title\n\nFirst.\n\n## Sub\n\nSecond.');
  });

  it('converts unordered and ordered lists', async () => {
    expect(await md('<ul><li>a</li><li>b</li></ul>')).toContain('- a');
    const ordered = await md('<ol><li>one</li><li>two</li></ol>');
    expect(ordered).toContain('1. one');
    expect(ordered).toContain('2. two');
  });

  it('nests lists with indentation', async () => {
    const out = await md('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(out).toContain('- outer');
    expect(out).toMatch(/\n\s{2}- inner/);
  });

  it('preserves whitespace inside pre, and collapses it elsewhere', async () => {
    const pre = await md('<pre>line one\n    indented</pre>');
    expect(pre).toContain('line one\n    indented');
    expect(await md('<p>lots\n\n   of     space</p>')).toBe('lots of space');
  });

  it('marks inline code and emphasis', async () => {
    expect(await md('<p>use <code>x</code></p>')).toBe('use `x`');
    expect(await md('<p><strong>bold</strong> and <em>italic</em></p>')).toBe('**bold** and _italic_');
  });

  it('does not double-wrap code inside a pre block', async () => {
    const out = await md('<pre><code>const x = 1;</code></pre>');
    expect(out).toContain('```');
    expect(out).not.toContain('`const');
  });
});

describe('links and images', () => {
  it('resolves relative links against the page URL', async () => {
    // An agent cannot resolve a relative href itself, so a bare "/docs" is useless to it.
    const out = await md('<a href="/docs/x">doc</a>', 'https://example.com/a/b');
    expect(out).toBe('[doc](https://example.com/docs/x)');
  });

  it('leaves absolute links alone', async () => {
    expect(await md('<a href="https://other.test/p">o</a>', 'https://example.com'))
        .toBe('[o](https://other.test/p)');
  });

  it('drops javascript: hrefs and anchors with no destination', async () => {
    expect(await md('<a href="javascript:evil()">x</a>', 'https://e.com')).toBe('x');
    expect(await md('<a>plain</a>', 'https://e.com')).toBe('plain');
  });

  it('keeps images as references without fetching or describing them', async () => {
    // Upstream deliberately avoids paid image models; this keeps that property.
    expect(await md('<img src="/i.png" alt="a cat">', 'https://e.com'))
        .toBe('![a cat](https://e.com/i.png)');
  });
});

describe('noise removal', () => {
  it('drops script, style and other non-prose elements entirely', async () => {
    const out = await md(
        '<p>keep</p><script>var secret = 1;</script><style>.a{color:red}</style>' +
        '<nav>menu</nav><footer>foot</footer>');
    expect(out).toBe('keep');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('menu');
  });

  it('drops nested content inside a dropped element', async () => {
    const out = await md('<p>a</p><script><span>b</span></script><p>c</p>');
    expect(out).not.toContain('b');
    expect(out).toContain('a');
    expect(out).toContain('c');
  });
});

describe('robustness', () => {
  it('handles unclosed tags without losing the rest of the document', async () => {
    // The point of using a real parser: malformed HTML is the norm, and a regex extractor
    // produces confidently wrong output on exactly the pages worth reading.
    const out = await md('<p>one<p>two<div>three');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
  });

  it('does not glue adjacent words together across tags', async () => {
    expect(await md('<span>alpha</span> <span>beta</span>')).toBe('alpha beta');
  });

  it('returns empty string for empty or content-free input', async () => {
    expect(await md('')).toBe('');
    expect(await md('<html><head><title>t</title></head><body></body></html>')).toBe('');
  });

  it('collapses runs of blank lines', async () => {
    const out = await md('<p>a</p><div></div><div></div><p>b</p>');
    expect(out).not.toMatch(/\n{3}/);
  });

  it('works with no base URL, leaving relative links as-is', async () => {
    expect(await md('<a href="/x">y</a>')).toBe('[y](/x)');
  });

  it('converts a realistic page end to end', async () => {
    const out = await md(`
      <html><head><title>Doc</title><style>b{}</style></head>
      <body><nav>skip</nav><main>
        <h1>API</h1>
        <p>Call <code>fetch()</code> to <a href="/get">get</a> data.</p>
        <ul><li>fast</li><li>simple</li></ul>
      </main></body></html>`, 'https://api.test/docs');
    expect(out).toContain('# API');
    expect(out).toContain('`fetch()`');
    expect(out).toContain('[get](https://api.test/get)');
    expect(out).toContain('- fast');
    expect(out).not.toContain('skip');
    expect(out).not.toContain('Doc');
  });
});
