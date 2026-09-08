import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { defaultWorkerSettings, type WorkerSettings as Settings } from "./worker-profiles.ts";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost",pretendToBeVisual:true});
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
const {installTestPluginRuntime,renderSlot}=await import("@get-bb/plugin-sdk/testing/app");
const {fireEvent,within,waitFor}=await import("@testing-library/react");installTestPluginRuntime();
const {WorkerSettings}=await import("./worker-settings.tsx");after(()=>dom.window.close());
const catalog={hostId:"desktop",hosts:[{id:"desktop",name:"Desktop"},{id:"studio",name:"Studio"}],providers:[{id:"codex",displayName:"Codex",available:true,serviceTiers:[{id:"fast",label:"Fast"}]},{id:"other",displayName:"Other",available:true,serviceTiers:[]}],models:[{providerId:"codex",id:"strong",model:"strong",displayName:"Strong",isDefault:true,reasoningLevels:[{id:"high",label:"High"},{id:"xhigh",label:"Extra high"}],defaultReasoningLevel:"high"},{providerId:"other",id:"other-model",model:"other-model",displayName:"Other model",isDefault:true,reasoningLevels:[],defaultReasoningLevel:null}]};

test("worker settings save roles independently and retain the old value after a failed save",async()=>{
  let settings=defaultWorkerSettings();let fail=false;const previews:string[]=[];
  const slot=renderSlot({component:WorkerSettings},{},{rpc:{
    getWorkerSettings:()=>settings,listWorkerProviders:(input:unknown)=>{const host=(input as {hostId?:string}).hostId ?? "desktop";previews.push(host);return {...catalog,hostId:host};},
    setWorkerSettings:(value:unknown)=>{if(fail)throw new Error("Save unavailable");settings=value as Settings;return settings;},
  }});const ui=within(slot.container);
  try {
    fireEvent.click(ui.getByText("Role-specific models"));
    await ui.findByRole("option",{name:"Desktop"});
    const ready=()=>waitFor(()=>assert.equal(ui.getByRole("combobox",{name:"Review model"}).closest("fieldset")?.disabled,false));await ready();
    fireEvent.change(ui.getByRole("combobox",{name:"Review model"}),{target:{value:"strong"}});await waitFor(()=>assert.equal(settings.profiles.review.model,"strong"));await ready();
    assert.equal(settings.profiles.implement.model,null);
    fireEvent.change(ui.getByRole("combobox",{name:"Review reasoning effort"}),{target:{value:"xhigh"}});await waitFor(()=>assert.equal(settings.profiles.review.reasoningLevel,"xhigh"));await ready();
    fail=true;fireEvent.change(ui.getByRole("combobox",{name:"Review provider"}),{target:{value:"other"}});await ui.findByRole("alert");await ready();
    assert.equal((ui.getByRole("combobox",{name:"Review provider"}) as HTMLSelectElement).value,"codex");assert.equal(settings.profiles.review.model,"strong");
    fail=false;fireEvent.change(ui.getByRole("combobox",{name:"Review provider"}),{target:{value:"other"}});await waitFor(()=>assert.equal(settings.profiles.review.providerId,"other"));await ready();
    assert.deepEqual(settings.profiles.review,{providerId:"other",model:null,reasoningLevel:null,serviceTier:"default"});
    fireEvent.change(ui.getByRole("combobox",{name:"Worker catalog machine"}),{target:{value:"studio"}});await waitFor(()=>assert.equal(previews.at(-1),"studio"));
    assert.equal(settings.profiles.investigate.providerId,"codex");
    assert.match(slot.container.textContent ?? "",/not read-only sandboxes/);
  } finally {slot.lifecycle.unmount();}
});

test("unavailable configured models remain visible instead of silently choosing a replacement",async()=>{
  const settings=defaultWorkerSettings();settings.profiles.implement.model="missing-model";
  const slot=renderSlot({component:WorkerSettings},{},{rpc:{getWorkerSettings:()=>settings,listWorkerProviders:()=>catalog}});const ui=within(slot.container);
  try {
    fireEvent.click(ui.getByText("Role-specific models"));
    await ui.findByRole("option",{name:"missing-model (unavailable)"});
    assert.equal((ui.getByRole("combobox",{name:"Implementation model"}) as HTMLSelectElement).value,"missing-model");
  } finally {slot.lifecycle.unmount();}
});

test("default worker changes update inherited roles and preserve a role-specific choice",async()=>{
  let settings=defaultWorkerSettings();settings.profiles.review.model="custom-review";
  const slot=renderSlot({component:WorkerSettings},{},{rpc:{getWorkerSettings:()=>settings,listWorkerProviders:()=>catalog,setWorkerSettings:(value:unknown)=>{settings=value as Settings;return settings;}}});
  const ui=within(slot.container);
  try {
    fireEvent.click(ui.getByText("Role-specific models"));
    await ui.findByRole("option",{name:"custom-review (unavailable)"});
    await waitFor(()=>assert.equal(ui.getByRole("combobox",{name:"Default worker model"}).closest("fieldset")?.disabled,false));
    fireEvent.change(ui.getByRole("combobox",{name:"Default worker model"}),{target:{value:"strong"}});
    await waitFor(()=>assert.equal(settings.defaultProfile?.model,"strong"));
    assert.equal(settings.profiles.implement.model,"strong");assert.equal(settings.profiles.investigate.model,"strong");assert.equal(settings.profiles.plan.model,"strong");assert.equal(settings.profiles.review.model,"custom-review");
  } finally {slot.lifecycle.unmount();}
});
