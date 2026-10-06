import { describe, expect, it } from 'vitest';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { projectFixture, report } from './fake-native';
import type { Sdk, ThreadDto } from '../lib/bb';

/**
 * A33 boundary probes — two remaining bypasses of the cancelled-execution
 * settlement rule documented in a31-boundary.test.ts (single decision point
 * settleCancelledIfQuiet: positive native end + full post-await freshness).
 *
 * Boundary 1 — creation evidence before I/O: confirmCreated() must persist
 * the confirmed thread binding, briefDelivered and the cancelled uncertain
 * reservation BEFORE awaiting Stop. Otherwise the record looks
 * never-delivered during the await and assignment-settle {notSent} frees a
 * reservation while a real native thread exists.
 *
 * Boundary 2 — transport validation before shortcuts: the SDK returns
 * parsed JSON with no runtime DTO validation. GET's archivedAt/deletedAt
 * must be finite numbers or null; absent (undefined), NaN or string values
 * are unknown evidence, never a positive "ended". The same well-formedness
 * applies to list rows (rowQuiescence), retireThread and liveDescendants.
 *
 * Positive controls: refused cancelled create releases 'never', delivered
 * cancellation holds throughout the Stop await and settles on genuine idle,
 * valid archive timestamp still converges through report/pass1/pass2.
 */

async function continuation() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route:'fresh', tasks:[t1.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.acceptTask(project.id, t1.ref, {});
  f.idle(d.threadId!);
  const worker=f.store.workers(project.id)[0]!;
  return {f,project,worker,t2:f.task(project.id,'Next')};
}
async function cancelledDispatched() {
  const x=await continuation(); const {f,project,worker,t2}=x;
  f.queueSend('q');
  await f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]});
  const input=f.send.mock.calls.at(-1)![0].input;
  f.queued.set(worker.threadId!,[{id:'q',content:input}]);
  f.harness.sdk.stub('threads.queuedMessages.delete',async()=>{throw new Error('offline')});
  await f.service.stopAssignment(project.id,'A2','cancel');
  f.queued.set(worker.threadId!,[]);
  f.threads.set(worker.threadId!,{...f.threads.get(worker.threadId!)!,status:'active'});
  f.runtime.onMessageDispatched('q');
  expect(f.store.assignment(project.id,2)).toMatchObject({state:'cancelled',opState:'uncertain',briefDelivered:true,queuedMessageId:null});
  return {...x,input};
}
async function lostSend() {
  const x=await continuation();
  x.f.send.mockImplementationOnce(async(args:any)=>{
    x.f.queued.set(x.worker.threadId!,[{id:'lost-q',content:args.input}]);
    throw new Error('lost response');
  });
  await x.f.service.delegate(x.project.id,{route:'continue',worker:x.worker.ref,tasks:[x.t2.ref]});
  await x.f.service.stopAssignment(x.project.id,'A2','cancel');
  return x;
}
const held=(x:any)=>expect(x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]})).rejects.toThrow();


// All activity fields below belong to the installed SDK 0.4.87 list DTO.
// Thread GET and idle/failed event DTOs expose only activeBackgroundAgentCount.
type NativeListRow = Awaited<ReturnType<Sdk['threads']['list']>>[number];
function listRow(t: ThreadDto, extra: Partial<NativeListRow['activity']> = {}): NativeListRow {
  return {
    ...t,
    activity: { activeBackgroundAgentCount: t.activeBackgroundAgentCount,
      activeBackgroundCommandCount: 0, activeWorkflowCount: 0,
      activeGoalCount: 0, activePlanModeCount: 0, ...extra },
    environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
    environmentName: null, environmentPath: null, environmentProviderId: null,
    environmentWorkspaceDisplayKind: 'unmanaged-worktree', hasPendingInteraction: false,
    pinSortKey: null, queuedWork: t.queuedMessageCount ? 'waiting' : 'none', updatedAt: 1,
  };
}
function nativeActivity(x: any, extra: Partial<NativeListRow['activity']>) {
  x.f.harness.sdk.stub('threads.list', async (args: any = {}) => [...x.f.threads.values()]
    .filter((t: any) => !args.parentThreadId || t.parentThreadId === args.parentThreadId)
    .map((t: any) => listRow(t, t.id === x.worker.threadId ? extra : {})));
}
async function cancelledQueued() {
  const x=await continuation(); const {f,project,worker,t2}=x;
  f.queueSend('q');
  await f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]});
  const input=f.send.mock.calls.at(-1)![0].input;
  f.queued.set(worker.threadId!,[{id:'q',content:input}]);
  f.harness.sdk.stub('threads.queuedMessages.delete',async()=>{throw new Error('offline')});
  await f.service.stopAssignment(project.id,'A2','cancel');
  return {...x,input};
}
async function settleVia(x: any, path: string) {
  const {f,worker}=x;
  const t=f.threads.get(worker.threadId)!;
  if(path==='report') await f.service.report(worker.threadId,{...report(),assignment:'A2'});
  else if(path==='idle') await f.runtime.onThreadIdle(t);
  else if(path==='failed') await f.runtime.onThreadFailed(t,'provider ended');
  else {
    if(path==='pass2') {
      let lists=0;
      f.harness.sdk.stub('threads.queuedMessages.list',async()=>{
        // First pass finds the row and cannot delete it. The second pass
        // observes dispatch has removed it, without a plugin notice.
        if(++lists===1) return [{id:'q',content:x.input}];
        return [];
      });
    }
    await f.service.reconcile();
  }
}


const expectHeld = async (x: any) => {
  // Save the actual consequence: whether a replacement writer was allowed.
  let replacement: unknown; let rejected = false;
  try { replacement = await x.f.service.delegate(x.project.id, {route:'fresh', tasks:[x.t2.ref]}); }
  catch { rejected = true; }
  expect(rejected, 'cancelled native execution must reserve its task; actual replacement: '+JSON.stringify(replacement)).toBe(true);
};
const finishEvent = async (x:any, path:string, event:ThreadDto) => path === 'idle'
  ? x.f.runtime.onThreadIdle(event) : x.f.runtime.onThreadFailed(event, 'earlier failed turn');

// Each native response is sampled at a different time. Newer list status
// supersedes the idle/error foreground event while the event handler awaits.

describe('A33 partial GET cannot bypass shared list evidence',()=>{
  for (const path of ['report','pass1','pass2']) {
    it.each(['missing archivedAt','missing deletedAt','NaN archivedAt','string deletedAt'])(`${path} holds for %s`,async(kind)=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'active'});
      x.f.harness.sdk.stub('threads.get',async({threadId}:any)=>{
        const row:any={...x.f.threads.get(threadId)!};
        if(threadId===x.worker.threadId) {
          if(kind==='missing archivedAt') delete row.archivedAt;
          if(kind==='missing deletedAt') delete row.deletedAt;
          if(kind==='NaN archivedAt') row.archivedAt=NaN;
          if(kind==='string deletedAt') row.deletedAt='not-a-timestamp';
        }
        return row;
      });
      await settleVia(x,path);await expectHeld(x);
    });
  }
});

// Stop can take time, refuse, or acknowledge while the native host still runs.
// A known create receipt must be durable before this await, so explicit
// never-delivered recovery cannot contradict the already-confirmed creation.
it('A33 cancelled creation records execution before awaiting Stop',async()=>{
  const {f,project}=await projectFixture();const t2=f.task(project.id);
  let entered!:()=>void, finish!:(v:any)=>void;
  const started=new Promise<void>(r=>entered=r);const response=new Promise<any>(r=>finish=r);
  let stopEntered!:()=>void, stopFinish!:(v:any)=>void;
  const stopping=new Promise<void>(r=>stopEntered=r);const stopped=new Promise<any>(r=>stopFinish=r);
  f.spawn.mockImplementationOnce(async()=>{entered();return response});
  const dispatch=f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]});
  await started;await f.service.stopAssignment(project.id,'A1','cancel before receipt');
  f.stop.mockImplementationOnce(async()=>{stopEntered();return stopped});
  const thread=makeThreadResponse({id:'late-created',projectId:'proj_a',environmentId:'env_a',parentThreadId:'coordinator',status:'active'});
  f.threads.set(thread.id,thread);finish(thread);await stopping;
  let settleRejected=false;
  try{await f.service.settleUncertain(project.id,'A1',{notSent:true})}catch{settleRejected=true}
  let replacement:unknown; let held=false;
  try{replacement=await f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]})}catch{held=true}
  stopFinish({});await dispatch;
  expect({settleRejected,held,replacement},'known creation must forbid never-sent settlement while Stop is pending').toMatchObject({settleRejected:true,held:true});
});

// For list DTOs, malformed fields should be unknown even though GET is quiet.
describe('A33 valid list boundary controls',()=>{
  for (const path of ['report','idle','failed','pass1','pass2']) {
    it.each(['missing archivedAt','unknown status','missing queuedWork','NaN command count','negative agent count'])(`${path} holds for %s`,async(kind)=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.idle(x.worker.threadId!);
      x.f.harness.sdk.stub('threads.list',async()=>[...x.f.threads.values()].map(t=>{
        const row:any=listRow(t);
        if(t.id===x.worker.threadId) {
          if(kind==='missing archivedAt') delete row.archivedAt;
          if(kind==='unknown status') row.status='unknown';
          if(kind==='missing queuedWork') delete row.queuedWork;
          if(kind==='NaN command count') row.activity.activeBackgroundCommandCount=NaN;
          if(kind==='negative agent count') row.activity.activeBackgroundAgentCount=-1;
        }
        return row;
      }));
      await settleVia(x,path);await expectHeld(x);
    });
  }
});

describe('A33 cancellation convergence controls',()=>{
  it('a refused cancelled creation is never delivered and can release',async()=>{
    const {f,project}=await projectFixture();const t2=f.task(project.id);
    let entered!:()=>void, refuse!:(v:any)=>void;
    const started=new Promise<void>(r=>entered=r);const response=new Promise<any>((_,r)=>refuse=r);
    f.spawn.mockImplementationOnce(async()=>{entered();return response});
    const dispatch=f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]}).catch(e=>e);
    await started;await f.service.stopAssignment(project.id,'A1','cancel before receipt');
    refuse(Object.assign(new Error('Creation refused'),{status:409}));await dispatch;
    expect(f.store.assignment(project.id,1)).toMatchObject({state:'cancelled',opState:'failed',briefDelivered:false,threadId:null});
    expect((await f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]}))[0].state).toBe('running');
  });
  it('ordinary delivered cancellation holds throughout the Stop await',async()=>{
    const x=await continuation(); const {f,project,worker,t2}=x;
    await f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]});
    f.threads.set(worker.threadId!,{...f.threads.get(worker.threadId!)!,status:'active'});
    let entered!:()=>void, finish!:(v:any)=>void;
    const started=new Promise<void>(r=>entered=r);const response=new Promise<any>(r=>finish=r);
    f.stop.mockImplementationOnce(async()=>{entered();return response});
    const cancel=f.service.stopAssignment(project.id,'A2','cancel running');
    await started;
    expect(f.store.assignment(project.id,2)).toMatchObject({opState:'uncertain',cancelRequested:true,briefDelivered:true});
    await expectHeld(x);
    finish({});await cancel;await expectHeld(x);
    await f.runtime.onThreadIdle(f.idle(worker.threadId!));
    expect((await f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]}))[0].state).toBe('running');
  });
  it.each(['report','pass1','pass2'])('%s valid native archive releases',async(path)=>{
    const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,archivedAt:Date.now()});
    await settleVia(x,path);
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done'});
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
});
