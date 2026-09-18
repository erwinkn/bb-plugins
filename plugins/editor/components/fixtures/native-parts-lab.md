# Native component lab

A trimmed fixture shaped like `apps/gpuix/docs/native-parts-lab.md`: headings,
code fences, a numbered list, images with no declared dimensions, wide tables,
and relative links. The images load asynchronously and grow the document, which
is what pushed the scrollbar-driven ResizeObserver loop.

## Run

```sh
cd apps/gpuix
bun install --frozen-lockfile
bun run lab
```

## Try the experiments

1. Drag across the source chip in the left paragraph. Use **A+**, **Inter**, and **Compact** to change the font or spacing while text is selected.
2. Select **Middle** in the table. Select a status cell. Toggle **External plugin on**.
3. Type a draft. Change the theme, then return to the draft. The value remains.
4. Select **Stream**. A deterministic source sends new text in bursts.

![Native lab with inline plugin and large table](evidence/native-parts/lab-start.png)

![Selection toolbar after a font change](evidence/native-parts/lab-font.png)

![Live row spacing at record 50,001](evidence/native-parts/lab-spacious.png)

## What the experiments show

| Test | Result |
| --- | --- |
| Inline citation | An external plugin returns a real native control. It wraps beside text and accepts clicks and keyboard activation. |
| Selection | A drag crosses text, the citation, and text after it. Copy order has no block newline around the citation. |
| Selection toolbar | Rust uses current-frame native text rectangles. Font and spacing changes place the toolbar in that same frame. |
| Clipping | Selection geometry is clipped to the scroll pane. The toolbar hides when the selection scrolls out of view. |
| Native editor | Live font changes retain focus, selection, and the draft. Typing replaces the original selected draft after the theme change. |
| Large table | The test scrolls a 100,000-row list with fewer than 1,000 retained native nodes. Only nearby rows have React nodes. |
| Streaming | The test commits 28 source deltas without a reveal queue. Table nodes and the table anchor remain unchanged. |

- [Clean install and regression checks](evidence/native-parts/clean-validation.json)
- [Native checks and geometry](evidence/native-parts/native-results.json)

```tsx
api.contribute({
  id: "my-plugin/citation",
  kind: "view",
  slot: targets.citation,
  replace: "lab.builtin/citation",
  render: ({ data }) => <Citation {...data} label="Open source" />,
});
```

| Slot | Default contribution | Data |
| --- | --- | --- |
| `lab/paragraph/citation` | `lab.builtin/citation` | `CitationData`: theme, label, title, action |
| `lab/table/cell/status` | `lab.builtin/status` | `CellData`: theme, logical index, selection, action |
| `lab/selection/toolbar` | `lab.builtin/toolbar` | model and theme |
| `lab/composer` | `lab.builtin/composer` | model and theme |

| Decision | Alternative | Confidence | Failure case |
| --- | --- | --- | --- |
| Use native flex fragments to test inline controls. | Build a full mixed-content paragraph engine first. | Medium | Complex scripts need stronger layout support. |
| Keep selected geometry in native prepaint. | Send bounds to React and position the toolbar in a later commit. | High | A custom element without geometry cannot anchor this toolbar. |
| Give the host ownership of row layout and state. | Give every cell plugin its own layout and data subscriptions. | High | A future plugin needs a wider contract. |
