// Compile-only API probe. No BB registration or filesystem writes.
import { CodeView, EditProvider } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { parseDiffFromFile, type CodeViewItem } from '@pierre/diffs';
const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
  new Editor(type, options, key);
const fileDiff = parseDiffFromFile(
  { name: 'example.ts', contents: 'const value = 1;\n' },
  { name: 'example.ts', contents: 'const value = 2;\n' },
);
const items: CodeViewItem<undefined>[] = [{ id: 'example', type: 'diff', fileDiff, edit: true }];
export function Probe() {
  return <EditProvider createEditor={createEditor}>
    <CodeView items={items} options={{ diffStyle: 'split' }}
      getEditStateKey={item => `probe:${item.id}`}
      onItemEditChange={(event, item) => console.log(item.id, event.file.contents)}
      onItemEditComplete={() => 'accept'} />
  </EditProvider>;
}
