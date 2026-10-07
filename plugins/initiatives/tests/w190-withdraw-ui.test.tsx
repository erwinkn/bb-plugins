// @vitest-environment jsdom
import {expect,it,vi} from "vitest";
import {fireEvent,waitFor} from "@testing-library/react";
import {installTestPluginRuntime,loadPluginApp,renderSlot} from "@get-bb/plugin-sdk/testing/app";
import {memoryStore} from "./helpers";
import {buildOverview} from "../lib/overview";

// W190 (recheck2): Withdraw shows why a replacement could not be withdrawn.
installTestPluginRuntime();
const app=await loadPluginApp(()=>import("../app"));
it("the dashboard displays the reason an in-flight withdrawal was refused",async()=>{
 const {store,db}=memoryStore();
 store.createProject({id:"p1",name:"Review fixture",objective:"Review",memberProjectIds:["repo"],coordinatorThreadId:"coordinator"});
 const o=buildOverview(store,"p1",new Map(),Date.now());db.close();
 o.project.coordinatorHandover={state:"pending",reason:"Restart",requestedBy:"user",profile:null,environment:null,detail:null,requestedAt:Date.now()} as any;
 o.project.coordinatorStart={state:"pending",threadId:null,reason:"Restart",createdAt:Date.now(),checkoutPending:false} as any;
 const note="The replacement spawn is already in flight and cannot be withdrawn. Its outcome will be recorded and reconciled; inspect the Initiative before retrying.";
 const command=vi.fn().mockResolvedValue({state:"pending",detail:null,note});
 const slot=renderSlot(app.navPanels[0],{subPath:"p1"},{rpc:{list:()=>[],inventory:()=>[],overview:()=>o,command}});
 try{
  fireEvent.click(await slot.findByRole("button",{name:"Withdraw"}));
  await waitFor(()=>expect(command).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect((slot.getByRole("button",{name:"Withdraw"}) as HTMLButtonElement).disabled).toBe(false));
  expect(slot.getByRole("alert").textContent).toBe(note);
 }finally{slot.unmount();}
});
