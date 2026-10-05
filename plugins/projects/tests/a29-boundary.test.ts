import { describe, expect, it } from 'vitest';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { projectFixture, report } from './fake-native';
import type { Sdk, ThreadDto } from '../lib/bb';

/**
 * A29 release-path matrix (ported verbatim from the A29 review fixture).
 * Every actor that can release a cancelled assignment's reservation must
 * share one contract: delivery receipts prove delivery, never execution;
 * limited/failed lookups are unknown, not quiescence; and evidence is read
 * fresh after every await.
 *
 * Release actors covered:
 * - report() tail settle, idle/failed events, reconcile pass 1 and pass 2:
 *   GET foreground quiet + list-DTO activity (agents, commands, workflows)
 *   must all be absent before opState releases; a 503 holds; a 404 frees.
 * - Late sent/queued send receipts on a cancelled dispatch: delivery is
 *   recorded, the reservation holds until positive native end.
 * - assignment-settle {notSent}: contradicts recorded dispatch/delivery.
 * - Freshness after awaits: a newer non-null report or a dispatch landing
 *   during the quiet lookup invalidates the stale snapshot.
 * Positive controls retained: confirmed deletion, removed queue row, quiet
 * absent send, pending/busy foreground statuses.
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

for (const background of ['activeBackgroundCommandCount','activeWorkflowCount'] as const) {
  describe(`A29 native ${background}`,()=>{
    it.each(['report','idle','failed','pass1','pass2'])('%s keeps cancelled execution reserved',async(path)=>{
      const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
      x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:path==='failed'?'error':'idle'});
      nativeActivity(x,{[background]:1});
      // Assert the field is available through a real public SDK DTO, without
      // inventing fields on ThreadDto or injecting them into the GET result.
      const rows=await x.f.service.sdk.threads.list({projectId:'proj_a'});
      expect(rows.find((r:any)=>r.id===x.worker.threadId)!.activity[background]).toBe(1);
      await settleVia(x,path);
      await held(x);
    });
  });
}

describe('A29 delivery response and adjacent release actors',()=>{
  it.each(['sent','queued'])('late %s send receipt preserves cancelled execution reservation',async(delivery)=>{
    const x=await continuation();const {f,project,worker,t2}=x;
    let started!:()=>void, finish!:(value:any)=>void;
    const entered=new Promise<void>(r=>started=r);
    const response=new Promise<any>(r=>finish=r);
    f.send.mockImplementationOnce(async()=>{started();return response});
    const dispatch=f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]});
    await entered;
    await f.service.stopAssignment(project.id,'A2','cancel while send pending');
    expect(f.store.assignment(project.id,2)).toMatchObject({state:'cancelled',opState:'uncertain'});
    const t={...f.threads.get(worker.threadId!)!,status:'active' as const};
    f.threads.set(worker.threadId!,t);
    if(delivery==='sent') finish({delivery,thread:t});
    else finish({delivery,queuedMessage:{id:'late-q',content:f.send.mock.calls.at(-1)![0].input}});
    await dispatch;
    if(delivery==='queued') f.runtime.onMessageDispatched('late-q');
    expect(f.store.assignment(project.id,2)).toMatchObject({state:'cancelled',briefDelivered:true,queuedMessageId:null});
    await held(x);
  });
  it('explicit notSent cannot contradict recorded native dispatch',async()=>{
    const x=await cancelledDispatched();
    const a=x.f.store.assignment(x.project.id,2)!;
    expect(a.briefDelivered).toBe(true);expect(a.report).toBeNull();
    try { await x.f.service.settleUncertain(x.project.id,'A2',{notSent:true}); } catch {}
    expect(x.f.store.assignment(x.project.id,2)!.briefDelivered).toBe(true);
    await held(x);
  });
});

describe('A29 positive, unknown, and fresh-state controls',()=>{
  it.each(['report','pass1','pass2'])('%s holds when native lookup returns 503',async(path)=>{
    const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
    x.f.harness.sdk.stub('threads.get',async()=>{throw Object.assign(new Error('host unavailable'),{status:503})});
    await settleVia(x,path);await held(x);
  });
  it.each(['report','pass1','pass2'])('%s settles confirmed native deletion',async(path)=>{
    const x=path==='pass2'?await cancelledQueued():await cancelledDispatched();
    x.f.threads.delete(x.worker.threadId!);
    await settleVia(x,path);
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done'});
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
  it.each(['pending','starting','stopping','active'] as const)('quiet helper holds %s foreground status',async(status)=>{
    const x=await cancelledDispatched();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status});
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});await held(x);
  });
  it.each(['idle','failed'])('%s event holds queued work',async(path)=>{
    const x=await cancelledDispatched();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:path==='failed'?'error':'idle',queuedMessageCount:1});
    await settleVia(x,path);await held(x);
  });
  it('failed event holds background agent activity, then converges at quiet',async()=>{
    const x=await cancelledDispatched();
    const t={...x.f.threads.get(x.worker.threadId!)!,status:'error' as const,activeBackgroundAgentCount:1};
    x.f.threads.set(x.worker.threadId!,t);
    await x.f.runtime.onThreadFailed(t,'failed');await held(x);
    const quiet={...t,activeBackgroundAgentCount:0};x.f.threads.set(t.id,quiet);
    await x.f.runtime.onThreadFailed(quiet,'failed');
    expect(x.f.store.assignment(x.project.id,2)!.opState).toBe('done');
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
  it('unknown execution reserves a different task in the same workspace',async()=>{
    const x=await cancelledDispatched();
    x.f.harness.sdk.stub('threads.get',async()=>{throw Object.assign(new Error('host unavailable'),{status:503})});
    await x.f.service.reconcile();
    const other=x.f.task(x.project.id,'Other overlapping work');
    await expect(x.f.service.delegate(x.project.id,{route:'fresh',tasks:[other.ref]})).rejects.toThrow(/overlap|shared|writer|conflict/i);
  });
  it('fresh report during quiet lookup wins over stale thread evidence',async()=>{
    const x=await cancelledDispatched();let first=true;
    const t={...x.f.threads.get(x.worker.threadId!)!,status:'idle' as const};
    x.f.harness.sdk.stub('threads.get',async({threadId}:any)=>{
      if(first && threadId===x.worker.threadId) {
        first=false;
        // The GET was sampled quiet before the newer report's active turn.
        await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
        return t;
      }
      return x.f.threads.get(threadId)!;
    });
    await x.f.service.reconcile();await held(x);
    expect(x.f.store.assignment(x.project.id,2)!.report).not.toBeNull();
  });
  it('fresh dispatch during quiet lookup wins over stale thread evidence',async()=>{
    const x=await cancelledQueued();
    x.f.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
    x.f.harness.sdk.stub('threads.get',async({threadId}:any)=>{
      const old={...x.f.threads.get(threadId)!,status:'idle' as const};
      x.f.threads.set(threadId,{...old,status:'active'});
      x.f.runtime.onMessageDispatched('q');
      return old;
    });
    await x.f.service.reconcile();await held(x);
    expect(x.f.store.assignment(x.project.id,2)!.briefDelivered).toBe(true);
  });
  it('positively removed queued brief settles and frees its task',async()=>{
    const x=await cancelledQueued();
    x.f.queued.set(x.worker.threadId!,[]);
    x.f.runtime.onMessageCancelled('q');
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done',briefDelivered:false});
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
  it('quiet absent lost-send converges without losing historical cancellation',async()=>{
    const x=await lostSend();
    x.f.queued.set(x.worker.threadId!,[]);x.f.idle(x.worker.threadId!);
    await x.f.service.reconcile();
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done',briefDelivered:false});
    expect((await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]}))[0].state).toBe('running');
  });
});


describe('A29 report freshness after quiet lookup',()=>{
  it('a newer non-null report wins over the stale quiet snapshot',async()=>{
    const x=await cancelledDispatched();
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2',summary:'Initial result'});
    let first=true;
    x.f.harness.sdk.stub('threads.get',async({threadId}:any)=>{
      if(first && threadId===x.worker.threadId) {
        first=false;
        const earlier={...x.f.threads.get(threadId)!,status:'idle' as const};
        // GET sampled quiet; a later native turn reports while that response
        // is in flight. Both old/new ledger reports are non-null.
        x.f.threads.set(threadId,{...earlier,status:'active'});
        await x.f.service.report(threadId,{...report(),assignment:'A2',summary:'Updated result from the later active turn'});
        return earlier;
      }
      return x.f.threads.get(threadId)!;
    });
    await x.f.service.reconcile();
    expect(x.f.store.assignment(x.project.id,2)!.report?.summary).toBe('Updated result from the later active turn');
    expect(x.f.threads.get(x.worker.threadId!)!.status).toBe('active');
    await held(x);
  });
});
