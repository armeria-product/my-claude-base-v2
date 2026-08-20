# Editable PPTX conversion

An editable PPTX is a requested derivative, not a replacement for the
self-contained deck HTML. First extract and edit the slides, pack the deck,
and run the self-containment gate. Then run:

```text
node .agents/skills/doc/scripts/html2pptx.mjs output.deck.html output.pptx
```

The converter uses a local Playwright runtime to measure the deck and
PptxGenJS to preserve slide backgrounds and create editable native text. It
blocks unexpected network requests. Complex component layout can be
approximated, so report material visual differences rather than calling the
PPTX pixel-identical to its HTML source. It fails loudly if dependencies or a
browser are unavailable.

Setup is explicit and local: set `CODEX_NODE_MODULES` to a directory where
`playwright` (or `playwright-core`) and `pptxgenjs` resolve, and set
`PPTX_BROWSER` to an Edge or Chrome executable when Playwright has no bundled
browser. Re-run the command after setup; never substitute screenshots for an
editable PPTX without saying so.
