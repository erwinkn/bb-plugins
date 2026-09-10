import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { defaultWorkerSettings, namedSettingsFromLegacy, type NamedWorkerSettings as Settings } from "./worker-profiles.ts";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost",pretendToBeVisual:true});
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
const {installTestPluginRuntime,renderSlot}=await import("@get-bb/plugin-sdk/testing/app");
const {fireEvent,within,waitFor}=await import("@testing-library/react");installTestPluginRuntime();
const {WorkerSettings}=await import("./worker-settings.tsx");after(()=>dom.window.close());
const catalog={hostId:"desktop",hosts:[{id:"desktop",name:"Desktop"},{id:"studio",name:"Studio"}],providers:[{id:"codex",displayName:"Codex",available:true,serviceTiers:[{id:"fast",label:"Fast"}]},{id:"other",displayName:"Other",available:true,serviceTiers:[]}],models:[{providerId:"codex",id:"strong",model:"strong",displayName:"Strong",isDefault:true,reasoningLevels:[{id:"high",label:"High"},{id:"xhigh",label:"Extra high"}],defaultReasoningLevel:"high"},{providerId:"other",id:"other-model",model:"other-model",displayName:"Other model",isDefault:true,reasoningLevels:[],defaultReasoningLevel:null}]};


function fixture() {
  let settings=namedSettingsFromLegacy(defaultWorkerSettings());let fail=false;const saves:any[]=[];const previews:string[]=[];
  const slot=renderSlot({component:WorkerSettings},{},{rpc:{getWorkerSettings:()=>settings,
    listWorkerProviders:(input:unknown)=>{const hostId=(input as any).hostId ?? "desktop";previews.push(hostId);return {...catalog,hostId};},
    setWorkerSettings:(input:unknown)=>{if(fail)throw Error("Save unavailable");const value=input as {settings:Settings;hostId:string};saves.push(value);settings=value.settings;return settings;},
  }});
  return {slot,ui:within(slot.container),saves,previews,get settings(){return settings;},fail:()=>fail=true};
}

test("named profiles can be added, renamed, selected as default, and deleted after choosing another default",async()=>{
  const h=fixture();try{
    await h.ui.findByRole("textbox",{name:"implement name"});
    assert.equal((h.ui.getByRole("button",{name:"Delete implement"}) as HTMLButtonElement).disabled,true);
    fireEvent.click(h.ui.getByRole("button",{name:"Add profile"}));
    fireEvent.change(h.ui.getByRole("textbox",{name:"profile-1 name"}),{target:{value:"audit"}});
    fireEvent.change(h.ui.getByRole("textbox",{name:"audit instructions"}),{target:{value:"Check changes and cite evidence."}});
    fireEvent.change(h.ui.getByRole("combobox",{name:"Default profile"}),{target:{value:"audit"}});
    assert.equal((h.ui.getByRole("button",{name:"Delete audit"}) as HTMLButtonElement).disabled,true);
    fireEvent.click(h.ui.getByRole("button",{name:"Delete implement"}));
    assert.equal(h.ui.queryByRole("textbox",{name:"implement name"}),null);assert.equal(h.saves.length,0,"edits stay local until Save");
    fireEvent.click(h.ui.getByRole("button",{name:"Save profiles"}));await h.ui.findByText("Profiles saved");
    assert.equal(h.settings.defaultProfile,"audit");assert.equal(h.settings.profiles.find(p=>p.name==="audit")!.instructions,"Check changes and cite evidence.");assert.equal(h.saves[0].hostId,"desktop");
    fireEvent.change(h.ui.getByRole("textbox",{name:"audit name"}),{target:{value:"final-audit"}});
    assert.equal((h.ui.getByRole("combobox",{name:"Default profile"}) as HTMLSelectElement).value,"final-audit","renaming the default preserves its selection");
  }finally{h.slot.lifecycle.unmount();}
});

test("profile permission modes save independently, including the project/BB default", async () => {
  const h = fixture(); try {
    const select = await h.ui.findByRole("combobox", { name: "review permission mode" }) as HTMLSelectElement;
    assert.equal(select.value, "accept-edits");
    assert.deepEqual(Array.from(select.options, option => option.value), ["inherit", "accept-edits", "auto", "full"]);
    assert.equal(h.ui.getAllByText(/Full access bypasses BB's sandbox/).length, 4);
    fireEvent.change(select, { target: { value: "full" } });
    fireEvent.change(h.ui.getByRole("combobox", { name: "implement permission mode" }), { target: { value: "auto" } });
    assert.equal(h.saves.length, 0);
    fireEvent.click(h.ui.getByRole("button", { name: "Save profiles" })); await h.ui.findByText("Profiles saved");
    assert.deepEqual(h.settings.profiles.map(p => p.permissionMode), ["accept-edits", "accept-edits", "auto", "full"]);
  } finally { h.slot.lifecycle.unmount(); }
});

test("profile model edits are independent and failed saves preserve the complete draft",async()=>{
  const h=fixture();try{
    await h.ui.findByRole("textbox",{name:"review name"});
    fireEvent.change(h.ui.getByRole("combobox",{name:"review model"}),{target:{value:"strong"}});
    fireEvent.change(h.ui.getByRole("combobox",{name:"review reasoning level"}),{target:{value:"xhigh"}});
    fireEvent.click(h.ui.getByRole("checkbox",{name:"review Fast"}));
    fireEvent.click(h.ui.getByRole("button",{name:"Save profiles"}));await h.ui.findByText("Profiles saved");
    assert.equal(h.settings.profiles.find(p=>p.name==="review")!.reasoningLevel,"xhigh");assert.equal(h.settings.profiles.find(p=>p.name==="implement")!.model,null);
    h.fail();fireEvent.change(h.ui.getByRole("combobox",{name:"review provider"}),{target:{value:"other"}});
    fireEvent.click(h.ui.getByRole("button",{name:"Save profiles"}));await h.ui.findByRole("alert");
    assert.equal((h.ui.getByRole("combobox",{name:"review provider"}) as HTMLSelectElement).value,"other");assert.equal(h.settings.profiles.find(p=>p.name==="review")!.providerId,"codex");
    fireEvent.click(h.ui.getByRole("button",{name:"Cancel"}));assert.equal((h.ui.getByRole("combobox",{name:"review provider"}) as HTMLSelectElement).value,"codex");
  }finally{h.slot.lifecycle.unmount();}
});

test("machine preview retains unsaved names and duplicate names cannot be saved",async()=>{
  const h=fixture();try{
    await h.ui.findByRole("textbox",{name:"review name"});
    fireEvent.change(h.ui.getByRole("textbox",{name:"review name"}),{target:{value:"custom-review"}});
    fireEvent.change(h.ui.getByRole("combobox",{name:"Worker catalog machine"}),{target:{value:"studio"}});
    await waitFor(()=>assert.equal(h.previews.at(-1),"studio"));assert.ok(h.ui.getByRole("textbox",{name:"custom-review name"}));
    fireEvent.change(h.ui.getByRole("textbox",{name:"custom-review name"}),{target:{value:"plan"}});
    assert.equal((h.ui.getByRole("button",{name:"Save profiles"}) as HTMLButtonElement).disabled,true);assert.match(h.ui.getByRole("alert").textContent!,/unique/);
  }finally{h.slot.lifecycle.unmount();}
});

test("unavailable configured choices remain visible and cannot be selected as a replacement",async()=>{
  const settings=namedSettingsFromLegacy(defaultWorkerSettings());settings.profiles.find(p=>p.name==="implement")!.model="missing-model";
  const slot=renderSlot({component:WorkerSettings},{},{rpc:{getWorkerSettings:()=>settings,listWorkerProviders:()=>catalog}});const ui=within(slot.container);
  try {const option=await ui.findByRole("option",{name:"missing-model (unavailable)"}) as HTMLOptionElement;assert.equal(option.disabled,true);assert.equal((ui.getByRole("combobox",{name:"implement model"}) as HTMLSelectElement).value,"missing-model");}
  finally{slot.lifecycle.unmount();}
});

for(const width of [390,1200]) test(`worker profile form retains width constraints at ${width}px`,async()=>{
  const h=fixture();h.slot.container.style.width=`${width}px`;
  try{await h.ui.findByRole("textbox",{name:"review name"});
    const root=h.ui.getByLabelText("Worker profiles");assert.ok(root.classList.contains("@container"));
    for(const field of root.querySelectorAll("fieldset,input:not([type=checkbox]),select,textarea"))assert.ok(field.classList.contains("min-w-0"));
    assert.ok(root.querySelector(".grid")!.classList.contains("@lg:grid-cols-2"));
    assert.equal(h.ui.queryByRole("button",{name:"Save profiles"})?.hasAttribute("title"),false);
  }finally{h.slot.lifecycle.unmount();}
});
