import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true, cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
installTestPluginRuntime();
const { AudioSettings, MicLevelMeter, PromptEditor } = await import("./settings-sections.tsx");
after(() => dom.window.close());

test("a microphone test stopped before permission resolves releases the late stream", async () => {
  let resolve!: (stream: MediaStream) => void;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => new Promise<MediaStream>(done => { resolve = done; }),
  } });
  let stops = 0;
  const slot = renderSlot({ component: MicLevelMeter }, { deviceId: "", active: true });
  slot.lifecycle.unmount();
  await act(async () => {
    resolve({ getTracks: () => [{ stop() { stops++; } }] } as unknown as MediaStream);
    await Promise.resolve();
  });
  assert.equal(stops, 1);
});

test("restoring the full default requires Save before changing instructions", async () => {
  const saves: unknown[]=[];
  const slot=renderSlot({component:PromptEditor},{},{rpc:{getPrompt:()=>({content:"Current",defaultContent:"Default",versions:[],proposal:null}),setPrompt:(args:unknown)=>{saves.push(args);return {ok:true};}}});
  try {const ui=within(slot.container);await ui.findByDisplayValue("Current");fireEvent.click(await ui.findByRole("button",{name:"Restore default"}));
    assert.equal(saves.length,0);assert.equal((ui.getByRole("textbox",{name:"Live prompt"}) as HTMLTextAreaElement).value,"Default");
    fireEvent.click(ui.getByRole("button",{name:"Save"}));await act(async()=>{await Promise.resolve();});
    assert.deepEqual(saves,[{role:"aide",content:"Default",source:"user",note:"edited in settings"}]);
  } finally {slot.lifecycle.unmount();}
});

test("prompt opens for editing and stays open after save and cancel", async () => {
  const saves: unknown[] = [];
  let content = "Current";
  const slot = renderSlot({ component: PromptEditor }, {}, { rpc: {
    getPrompt: () => ({ content, defaultContent: "Default", versions: [], proposal: null }),
    setPrompt: (args: unknown) => { saves.push(args); content = (args as {content:string}).content; return { ok: true }; },
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    const editor = ui.getByRole("textbox", { name: "Live prompt" }) as HTMLTextAreaElement;
    assert.equal(editor.value, "Current");
    assert.equal(ui.queryByRole("button", { name: "Preview" }), null);
    assert.equal(ui.queryByRole("button", { name: "Edit" }), null);
    fireEvent.change(editor, { target: { value: "Updated" } });
    fireEvent.click(ui.getByRole("button", { name: "Save" }));
    await act(async () => { await Promise.resolve(); });
    assert.equal(saves.length, 1);
    assert.equal(editor.value, "Updated");
    fireEvent.change(editor, { target: { value: "Discard this" } });
    fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    assert.equal(editor.value, "Updated");
    fireEvent.click(ui.getByRole("button", { name: "Restore default" }));
    await act(async () => { await Promise.resolve(); });
    assert.equal(editor.value, "Default");
  } finally { slot.lifecycle.unmount(); }
});

test("audio settings retain the microphone controls without a speaker setting", async () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    enumerateDevices: async () => [
      { deviceId: "mic", kind: "audioinput", label: "Test microphone" },
      { deviceId: "default", kind: "audiooutput", label: "Default - Test speaker" },
    ],
  } });
  const slot = renderSlot({ component: AudioSettings }, {});
  try {
    const ui = within(slot.container);
    await ui.findByRole("option", { name: "Test microphone" });
    assert.equal(ui.getAllByRole("combobox").length, 1);
    assert.ok(ui.getByRole("button", { name: "Test microphone" }));
    assert.equal(ui.queryByText("Speaker"), null);
    assert.equal(ui.queryByText("Test speaker"), null);
  } finally { slot.lifecycle.unmount(); }
});


test("prompt updates refresh a clean editor but preserve unsaved edits", async () => {
  let content = "Current";
  const slot = renderSlot({ component: PromptEditor }, {}, { rpc: {
    getPrompt: () => ({ content, defaultContent: "Default", versions: [], proposal: null }),
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    const editor = ui.getByRole("textbox", { name: "Live prompt" }) as HTMLTextAreaElement;
    content = "Remote update";
    await slot.behavior.emitRealtime("prompt-changed", null);
    assert.equal(editor.value, content);
    fireEvent.change(editor, { target: { value: "Unsaved draft" } });
    content = "Another update";
    await slot.behavior.emitRealtime("prompt-changed", null);
    assert.equal(editor.value, "Unsaved draft");
    fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    assert.equal(editor.value, content);
  } finally { slot.lifecycle.unmount(); }
});

test("behavior settings keep the prompt and drop the legacy plugin-command and tool catalogue controls", async () => {
  const { BehaviorSettings } = await import("./settings-sections.tsx");
  const slot = renderSlot({ component: BehaviorSettings }, {}, { rpc: {
    getPrompt: () => ({ content: "Current", defaultContent: "Default", versions: [], proposal: null }),
  } });
  try {
    const ui = within(slot.container);
    await act(async () => { await Promise.resolve(); });
    assert.ok(ui.getByRole("textbox", { name: "Live prompt" }));
    assert.equal(ui.queryByRole("combobox"), null, "no plugin exposure picker");
    assert.equal(ui.queryByRole("button", { name: /built-in tools/i }), null);
    assert.equal(slot.inspection.rpcCalls.some(call => call.method === "getTools" || call.method === "listPlugins"), false);
  } finally { slot.lifecycle.unmount(); }
});

test("worker prompt save failures retain the draft and enforce the role length limit",async()=>{
  const slot=renderSlot({component:PromptEditor},{role:"worker"},{rpc:{getPrompt:()=>({content:"Original",defaultContent:"Default",proposal:null,versions:[]}),setPrompt:()=>{throw Error("Save unavailable");}}});
  try {
    const ui=within(slot.container);const editor=await ui.findByRole("textbox",{name:"Worker prompt"}) as HTMLTextAreaElement;
    await act(async()=>{await Promise.resolve();});
    fireEvent.change(editor,{target:{value:"Keep this draft"}});fireEvent.click(ui.getByRole("button",{name:"Save"}));await ui.findByRole("alert");assert.equal(editor.value,"Keep this draft");
    fireEvent.change(editor,{target:{value:"a".repeat(32001)}});assert.equal((ui.getByRole("button",{name:"Save"}) as HTMLButtonElement).disabled,true);
  } finally {slot.lifecycle.unmount();}
});


test("prompt version history previews earlier words and requires Save to restore them",async()=>{
  const saves:unknown[]=[];const slot=renderSlot({component:PromptEditor},{role:"worker"},{rpc:{getPrompt:()=>({content:"Current worker",defaultContent:"Full worker default",versions:[{id:1,ts:1000,source:"user",note:"Earlier",content:"Earlier worker"}],proposal:null}),setPrompt:(input:unknown)=>{saves.push(input);return {ok:true};}}});
  const ui=within(slot.container);try{
    await ui.findByDisplayValue("Current worker");const details=ui.getByText("Version history").closest("details")!;details.open=true;
    fireEvent.change(ui.getByRole("combobox",{name:"Worker prompt version"}),{target:{value:"1"}});
    assert.match(ui.getByLabelText("Worker prompt history").textContent!,/Earlier worker/);assert.equal(saves.length,0);
    fireEvent.click(ui.getByRole("button",{name:"Use this version"}));assert.equal((ui.getByRole("textbox",{name:"Worker prompt"}) as HTMLTextAreaElement).value,"Earlier worker");assert.equal(saves.length,0);
    assert.match(slot.container.textContent!,/newly launched workers/);
  }finally{slot.lifecycle.unmount();}
});

test("coordinator prompt history is collapsed in settings and has no editing controls",async()=>{
  const {BehaviorSettings}=await import("./settings-sections.tsx");
  const slot=renderSlot({component:BehaviorSettings},{},{rpc:{getPrompt:(input:unknown)=>({content:`${(input as any).role} words`,defaultContent:"Default",versions:[{id:1,ts:1,source:"user",note:null,content:"Historical coordinator words"}],proposal:null})}});
  const ui=within(slot.container);try{
    await ui.findByDisplayValue("aide words");assert.equal(ui.queryByLabelText("Coordinator prompt history section"),null);
    const history=ui.getByText("Previous prompts").closest("details")!;assert.equal(history.open,false);history.open=true;
    fireEvent(history,new dom.window.Event("toggle"));const section=await ui.findByRole("region",{name:"Coordinator prompt history section"});
    await within(section).findByRole("combobox",{name:"Coordinator prompt version"});assert.equal(within(section).queryByRole("textbox"),null);assert.equal(within(section).queryByRole("button",{name:"Save"}),null);
    const previous=await ui.findByRole("region",{name:"Previous live prompt history section"});
    assert.equal(within(previous).queryByRole("textbox"),null);assert.equal(within(previous).queryByRole("button",{name:"Save"}),null);
    assert.equal(slot.inspection.rpcCalls.some(call=>call.method==="setPrompt"),false);
  }finally{slot.lifecycle.unmount();}
});

for(const width of [390,1200])test(`prompt controls retain width constraints at ${width}px`,async()=>{
  const slot=renderSlot({component:PromptEditor},{role:"worker"},{rpc:{getPrompt:()=>({content:"a".repeat(10000),defaultContent:"Default",versions:[],proposal:null})}});slot.container.style.width=`${width}px`;
  try{const ui=within(slot.container);const editor=await ui.findByRole("textbox",{name:"Worker prompt"});assert.ok(editor.classList.contains("min-w-0"));assert.ok(editor.classList.contains("w-full"));
    assert.ok(ui.getByRole("button",{name:"Save"}).parentElement!.classList.contains("flex-wrap"));assert.equal(slot.container.querySelector("pre")!.classList.contains("whitespace-pre-wrap"),true);
  }finally{slot.lifecycle.unmount();}
});
