import {describe, expect, test} from "bun:test";
import {marked} from "marked";
import {protectMath, restoreMath} from "./math-markdown.ts";

function parse(value) {
  const {source, fragments} = protectMath(value);
  return {html: restoreMath(marked.parse(source), fragments), fragments};
}

describe("math markdown boundary", () => {
  test("preserves inline and display TeX delimiters through Markdown", () => {
    const {html, fragments} = parse("Inline \\(x^2 + y^2\\) and $z^2$.\n\n$$\\int_0^1 x\\,dx$$\n\n\\[\\frac{a}{b}\\]");
    expect(fragments).toHaveLength(4);
    expect(html).toContain("\\(x^2 + y^2\\)");
    expect(html).toContain("$z^2$");
    expect(html).toContain("$$\\int_0^1 x\\,dx$$");
    expect(html).toContain("\\[\\frac{a}{b}\\]");
    expect(html.match(/class="math-fragment"/g)).toHaveLength(4);
  });

  test("does not treat escaped dollars as math", () => {
    const {fragments} = protectMath("Price: \\$5");
    expect(fragments).toHaveLength(0);
  });

  test("keeps TeX-looking code as code for MathJax skip tags", () => {
    const {html} = parse("`$not_math$` and $math$");
    expect(html).toContain("<code>$not_math$</code>");
    expect(html).toContain("and <span");
    expect(html).toContain(">$math$</span>");
    expect(html.match(/class="math-fragment"/g)).toHaveLength(1);
  });

  test("escapes HTML embedded inside a math fragment", () => {
    const {html} = parse("$x <img src=x onerror=alert(1)> y$");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
