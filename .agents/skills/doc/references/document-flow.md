# Document flow

HTML is canonical. Use an offline single file with inline CSS, JavaScript,
fonts, images, and SVG. Write conclusion-first content, logical headings,
accessible tables, useful alt text, and print CSS. Use the bundled template as
a starting point rather than an instruction to retain its sample content.

Before delivery, run:

```text
node .agents/skills/doc/scripts/assert-self-contained.mjs path/to/output.html
```

The gate inspects actual resource-bearing HTML attributes and CSS resource
syntax. It intentionally does not reject an `https://` string in prose, a code
example, or an inline script. Fix a reported dependency by embedding it,
removing it, or replacing it with an offline equivalent.

For an explicitly requested PDF:

```text
node .agents/skills/doc/scripts/html2pdf.mjs input.html output.pdf
```

If it prints `skipped`, deliver the verified HTML and the setup guidance. To
enable conversion, point `CODEX_NODE_MODULES` at the directory containing a
Playwright installation and, when Playwright has no browser, set
`PDF_BROWSER` to an Edge or Chrome executable. No network download is attempted
by the converter.
