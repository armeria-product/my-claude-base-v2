---
name: doc
description: Create reader-facing, self-contained HTML documents and slide decks, with optional PDF or editable PPTX derivatives. Use for reports, guides, comparisons, summaries, and presentations; not internal task records.
---

# Doc

Create reader-facing deliverables as offline, self-contained HTML. HTML is the
source of truth; generate a PDF or editable PPTX only when the user explicitly
asks for it. Do not use this skill for `tasks/`, plans, commits, or other
internal working records.

Use the native `document-author` role for substantial documents. Keep the
output in the user-approved project or deliverable directory, not in this
skill folder.

## Document flow

Start from [the HTML template](assets/doc.template.html) when it fits the
deliverable. Keep CSS, fonts, SVG, scripts, and other required resources in
the HTML itself. Before delivery, run the independent self-containment gate:

```text
node .agents/skills/doc/scripts/assert-self-contained.mjs path/to/document.html
```

It rejects real remote resource attributes, CSS imports, and CSS URLs while
allowing inline scripts and ordinary URL text or code examples. Read
[document flow](references/document-flow.md) for output, accessibility, and
PDF guidance.

## PDF, only on request

Run `html2pdf.mjs` only after the HTML gate passes and the user asks for PDF:

```text
node .agents/skills/doc/scripts/html2pdf.mjs input.html output.pdf
```

PDF conversion is fail-open. If an installed Playwright runtime or browser is
unavailable, it leaves the HTML untouched, returns success with a clear
`skipped` result, and prints the exact `CODEX_NODE_MODULES` / `PDF_BROWSER`
setup path. Do not claim a PDF was created when it was skipped.

## Decks and editable PPTX

Use [the deck template](assets/doc.pptx.template.html) as the canonical deck
bundle. Extract sections, edit one 1920 by 1080 `<section>` per slide, then
pack a self-contained `.deck.html`:

```text
node .agents/skills/doc/scripts/deckpack.mjs --extract .agents/skills/doc/assets/doc.pptx.template.html work.slides.html
node .agents/skills/doc/scripts/deckpack.mjs --pack work.slides.html output.deck.html
```

Run the same self-containment gate on the packed deck. When the user explicitly
requests an editable PPTX, read [PPTX conversion](references/pptx.md) and run
`html2pptx.mjs`. That conversion is fail-loud: missing Playwright, PptxGenJS,
or a browser is an actionable error, never a pretend PPTX.
