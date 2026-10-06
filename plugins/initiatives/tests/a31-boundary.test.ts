import { describe, expect, it } from 'vitest';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { projectFixture, report } from './fake-native';
import type { Sdk, ThreadDto } from '../lib/bb';

/**
 * Cancelled-execution release matrix (A31). Every write that frees a
 * cancelled assignment's task/workspace reservation maps to ONE rule:
 * delivery receipts, Stop acknowledgments and queue removals are
 * observations, never execution end; incomplete or unreadable native
 * evidence is unknown and holds; evidence is re-read after every await.
 *
 * ONE decision point: settleCancelledIfQuiet writes opState done +
 * releaseCancelledTasks only when executionEvidence/rowQuiescence returns
 * "ended" (complete valid list row: known status, queuedWork, and finite
 * agent/command/workflow counts — or a confirmed 404/archive/delete) AND
 * the full post-await freshness comparison still matches (state, opState,
 * threadId, queuedMessageId, briefDelivered, cancelRequested, report by
 * value). Callers:
 * - report() tail, reconcile pass 1 (queued/history/absent), pass 2.
 * - settleCancelledExecutions (idle/failed events): event DTO is only an
 *   early-out; the fresher list row's own status and activity decide, and
 *   per-candidate release delegates to the same settle + freshness path.
 *
 * Other reservation writes, and why they are not bypasses:
 * - stopAssignment: delivered/created work goes opState uncertain BEFORE a
 *   best-effort Stop; tasks stay blocked. Planned only when never delivered
 *   (successful queue delete, no thread, no delivery proof).
 * - confirmCreated on a cancelled op: best-effort Stop, opState uncertain,
 *   then the common settle attempt. A refused create releases "never"
 *   (definite refusal proves nothing was created); a refused send preserves
 *   uncertainty — the error is attributed to the op that threw.
 * - onMessageCancelled: clears the queue receipt; releases "never" only
 *   when no report/dispatch evidence exists, else the common rule settles.
 * - onThreadArchived: archive/delete is positive native end; releases.
 * - assignment-settle {notSent}: explicit settle that rejects recorded
 *   report/delivery/receipt evidence.
 * Positive controls: quiet/gone convergence through all five settle paths,
 * genuinely-never-delivered release, second-page list discovery.
 */

async function continuation() {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id);
  const [d] = await f.service.delegate(project.id, { route:'fresh', tasks:[t1.ref] });
  await f.service.report(d.threadId!, report());
  await f.service.closeTask(project.id, t1.ref, "done");
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
// T136: a held reservation is the cancelled operation staying unsettled; new work on its
// task is then warned about (never refused), so the stored state is the check.
const held=(x:any)=>expect(['pending','uncertain']).toContain(x.f.store.assignment(x.project.id,2)!.opState);


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


// T136: a replacement writer is warned, never refused, while cancelled native execution
// still holds the task: the cancelled operation stays unsettled and the warning names it.
const expectHeld = async (x: any) => {
  const cancelled = x.f.store.assignments(x.project.id).filter((a: any) => a.taskNums.includes(x.t2.num) && (a.state === 'cancelled' || a.cancelRequested)).at(-1)!;
  expect(['pending','uncertain'], 'cancelled native execution must stay unsettled').toContain(cancelled.opState);
  const [replacement] = await x.f.service.delegate(x.project.id, {route:'fresh', tasks:[x.t2.ref]});
  expect(replacement.warnings?.join(' ')).toMatch(new RegExp(`${x.t2.ref} is also with W${cancelled.workerNum} \\(${cancelled.ref}`));
};
const finishEvent = async (x:any, path:string, event:ThreadDto) => path === 'idle'
  ? x.f.runtime.onThreadIdle(event) : x.f.runtime.onThreadFailed(event, 'earlier failed turn');

// Each native response is sampled at a different time. Newer list status
// supersedes the idle/error foreground event while the event handler awaits.
describe('A31 event observations',()=>{
  for (const path of ['idle','failed']) {
    it.each(['active','pending','starting','stopping'] as const)(`${path} checks fresher list status %s`, async(status)=>{
      const x=await cancelledDispatched();
      const event={...x.f.threads.get(x.worker.threadId!)!,status:path==='idle'?'idle' as const:'error' as const};
      x.f.threads.set(event.id,{...event,status});
      await finishEvent(x,path,event);
      await expectHeld(x);
    });
    it(`${path} compares an updated non-null report after list await`,async()=>{
      const x=await cancelledDispatched();
      await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2',summary:'Old report'});
      const event=x.f.idle(x.worker.threadId!); let first=true;
      x.f.harness.sdk.stub('threads.list',async()=>{
        const sampled=[...x.f.threads.values()].map(t=>listRow(t));
        if(first){
          first=false;
          x.f.threads.set(event.id,{...event,status:'active'});
          await x.f.service.report(event.id,{...report(),assignment:'A2',summary:'Updated report during list await'});
        }
        return sampled;
      });
      await finishEvent(x,path,event);
      expect(x.f.store.assignment(x.project.id,2)!.report!.summary).toBe('Updated report during list await');
      await expectHeld(x);
    });
  }
});

// Missing numbers must stay unknown: JS sum(undefined,0,0) is NaN, not zero.
describe('A31 incomplete evidence',()=>{
  for(const path of ['report','idle','failed','pass1','pass2']){
    it.each(['empty activity','missing command count','missing workflow count'])(`${path}: %s holds`,async(kind)=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.idle(x.worker.threadId!);
      x.f.harness.sdk.stub('threads.list',async()=>[...x.f.threads.values()].map(t=>{
        const row:any=listRow(t);
        if(t.id===x.worker.threadId){
          if(kind==='empty activity') row.activity={};
          else if(kind==='missing command count') delete row.activity.activeBackgroundCommandCount;
          else delete row.activity.activeWorkflowCount;
        }
        return row;
      }));
      await settleVia(x,path);await expectHeld(x);
    });
    it.each(['missing row','missing activity','list throws'])(`${path}: %s remains unknown`,async(kind)=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.idle(x.worker.threadId!);
      x.f.harness.sdk.stub('threads.list',async()=>{
        if(kind==='list throws')throw new Error('native list unavailable');
        if(kind==='missing row')return [];
        return [...x.f.threads.values()].map(t=>{const row:any=listRow(t);delete row.activity;return row;});
      });
      await settleVia(x,path);await expectHeld(x);
    });
  }
});

describe('A31 freshness at final quiet observation',()=>{
  it.each(['report','pass1','pass2'])('%s updated non-null report during list await holds',async(path)=>{
    const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
    // Preserve the queue receipt for pass 2; initial report is already durable.
    x.f.store.updateAssignment(x.project.id,2,{report:report()});
    x.f.idle(x.worker.threadId!);let first=true;
    x.f.harness.sdk.stub('threads.list',async()=>{
      const sampled=[...x.f.threads.values()].map(t=>listRow(t));
      if(first){
        first=false;
        x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'active'});
        await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2',summary:'Updated after list sample'});
      }
      return sampled;
    });
    await settleVia(x,path);await expectHeld(x);
  });
});

describe('A31 remaining release actors',()=>{
  it('late fresh create receipt holds after Stop accepts but native foreground is still active',async()=>{
    const {f,project}=await projectFixture();const t2=f.task(project.id);
    let entered!:()=>void, finish!:(v:any)=>void;
    const started=new Promise<void>(r=>entered=r);const response=new Promise<any>(r=>finish=r);
    f.spawn.mockImplementationOnce(async()=>{entered();return response});
    const dispatch=f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]});
    await started;await f.service.stopAssignment(project.id,'A1','cancel before receipt');
    const thread=makeThreadResponse({id:'late-created',projectId:'proj_a',environmentId:'env_a',parentThreadId:'coordinator',status:'active'});
    f.threads.set(thread.id,thread);finish(thread);await dispatch;
    expect(f.stop).toHaveBeenCalledWith({threadId:thread.id});
    expect(f.store.assignment(project.id,1)!.state).toBe('cancelled');
    await expectHeld({f,project,t2});
  });
  it('late definite send rejection preserves cancellation and report-backed execution',async()=>{
    const x=await continuation();const {f,project,worker,t2}=x;
    let entered!:()=>void, fail!:(v:any)=>void;
    const started=new Promise<void>(r=>entered=r);const response=new Promise<any>((_,r)=>fail=r);
    f.send.mockImplementationOnce(async()=>{entered();return response});
    const dispatch=f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]}).catch(e=>e);
    await started;await f.service.stopAssignment(project.id,'A2','cancel while sending');
    f.threads.set(worker.threadId!,{...f.threads.get(worker.threadId!)!,status:'active'});
    await f.service.report(worker.threadId!,{...report(),assignment:'A2'});
    fail(Object.assign(new Error('rejected continuation'),{status:409}));await dispatch;
    await expectHeld(x);
  });
  it('queue cancellation after a report holds until already-proven execution ends',async()=>{
    const x=await cancelledQueued();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'active'});
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({opState:'uncertain',queuedMessageId:'q',briefDelivered:true});
    x.f.queued.set(x.worker.threadId!,[]);x.f.runtime.onMessageCancelled('q');
    await expectHeld(x);
  });
  it('cancelling an ordinary delivered turn does not treat Stop acknowledgment as quiet',async()=>{
    const x=await continuation();
    await x.f.service.delegate(x.project.id,{route:'continue',worker:x.worker.ref,tasks:[x.t2.ref]});
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'active'});
    await x.f.service.stopAssignment(x.project.id,'A2','cancel running work');
    await expectHeld(x);
  });
});

describe('A31 additional convergence and actor controls',()=>{
  it('cancelled create is not marked refused when only the subsequent Stop gets a 409',async()=>{
    const {f,project}=await projectFixture();const t2=f.task(project.id);
    let entered!:()=>void, finish!:(v:any)=>void;
    const started=new Promise<void>(r=>entered=r);const response=new Promise<any>(r=>finish=r);
    f.spawn.mockImplementationOnce(async()=>{entered();return response});
    const dispatch=f.service.delegate(project.id,{route:'fresh',tasks:[t2.ref]}).catch(e=>e);
    await started;await f.service.stopAssignment(project.id,'A1','cancel before receipt');
    const thread=makeThreadResponse({id:'created-despite-cancel',projectId:'proj_a',environmentId:'env_a',parentThreadId:'coordinator',status:'active'});
    f.threads.set(thread.id,thread);
    f.stop.mockRejectedValueOnce(Object.assign(new Error('Stop conflicts with another native operation'),{status:409}));
    finish(thread);await dispatch;
    await expectHeld({f,project,t2});
  });
  for(const path of ['report','idle','failed','pass1','pass2']) {
    it(`${path} command/workflow activity holds then genuinely quiet work converges`,async()=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.idle(x.worker.threadId!);nativeActivity(x,{activeBackgroundCommandCount:1,activeWorkflowCount:1});
      await settleVia(x,path);await expectHeld(x);
      nativeActivity(x,{});
      if(path==='report')await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2',summary:'Final revised report'});
      else await settleVia(x,path);
      expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done'});
      expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
    });
    it(`${path} pagination can find a quiet row on the second 200-row page`,async()=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.idle(x.worker.threadId!);const offsets:number[]=[];
      const dummy=listRow(makeThreadResponse({id:'unrelated'}));
      x.f.harness.sdk.stub('threads.list',async(args:any)=>{
        expect(args).toMatchObject({includeHidden:true,limit:200});offsets.push(args.offset);
        return args.offset===0 ? Array.from({length:200},(_,i)=>({...dummy,id:'unrelated-'+i})) : [listRow(x.f.threads.get(x.worker.threadId!)!)];
      });
      await settleVia(x,path);
      expect(offsets).toEqual([0,200]);
      expect(x.f.store.assignment(x.project.id,2)!.opState).toBe('done');
    });
  }
  it.each(['queued','report'])('notSent rejects contradictory %s evidence',async(kind)=>{
    const x=await cancelledQueued();
    if(kind==='report')await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    await expect(x.f.service.settleUncertain(x.project.id,'A2',{notSent:true})).rejects.toThrow();
    await expectHeld(x);
  });
  it('notSent releases a genuinely never-delivered cancellation',async()=>{
    const x=await lostSend();x.f.queued.set(x.worker.threadId!,[]);
    await x.f.service.settleUncertain(x.project.id,'A2',{notSent:true});
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'failed',briefDelivered:false});
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
  it.each(['report','pass1','pass2'])('%s newer queue receipt after list sample holds',async(path)=>{
    const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
    x.f.idle(x.worker.threadId!);let first=true;
    x.f.harness.sdk.stub('threads.list',async()=>{
      const sampled=[...x.f.threads.values()].map(t=>listRow(t));
      if(first){first=false;x.f.store.updateAssignment(x.project.id,2,{queuedMessageId:'new-receipt'});}
      return sampled;
    });
    x.f.harness.sdk.stub('threads.queuedMessages.list',async()=>[{id:'new-receipt',content:[]}]);
    await settleVia(x,path);await expectHeld(x);
  });
});
