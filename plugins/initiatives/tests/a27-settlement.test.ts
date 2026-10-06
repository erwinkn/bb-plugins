import { describe, expect, it } from 'vitest';
import { makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { projectFixture, report } from './fake-native';
import { currentProjectThreads, projectStatus, selectedProject } from '../../sidebar/lib/project-mode-status';

/**
 * A27 settlement boundaries. Failed premise under review: "absence in a
 * bounded observation — or a foreground idle — proves cancelled native work
 * cannot execute." It is false: history/queue pages are bounded, snapshots
 * race, idle describes only the foreground turn, and transport errors are
 * not a missing thread.
 *
 * Release paths covered below (positive vs unknown evidence):
 * - report() tail settle: threads.get error -> unknown, hold; quiet -> release.
 * - idle/failed event: foreground terminal + queued/background work -> hold.
 * - reconcile pass 1 (opState pending/uncertain): marker absent in bounded
 *   snapshots + runnable/unknown thread -> hold; ended -> release.
 * - reconcile pass 2 (stored receipt): re-read after every native await;
 *   dispatch landing mid-await wins over the limited page.
 * Positive releases retained: positive queue delete/removal, archive,
 * explicit settle, quiet thread after dispatch.
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

describe('A27 execution-settlement boundaries',()=>{
  it('holds a cancelled report when native thread lookup returns 503',async()=>{
    const x=await cancelledDispatched();
    x.f.harness.sdk.stub('threads.get',async()=>{throw Object.assign(new Error('host unavailable'),{status:503})});
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    expect(x.f.store.assignment(x.project.id,2)!.state).toBe('cancelled');
    await held(x);
  });
  it('holds a cancelled report while an idle native thread has a background agent',async()=>{
    const x=await cancelledDispatched();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'idle',activeBackgroundAgentCount:1});
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    await held(x);
  });
  it('holds on native idle while a background agent still executes',async()=>{
    const x=await cancelledDispatched();
    const thread={...x.f.threads.get(x.worker.threadId!)!,status:'idle' as const,activeBackgroundAgentCount:1};
    x.f.threads.set(x.worker.threadId!,thread);
    await x.f.runtime.onThreadIdle(thread);
    await held(x);
  });
  it('holds a late report while its lost-receipt brief remains queued',async()=>{
    const x=await lostSend();
    x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'idle',queuedMessageCount:1});
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    expect(x.f.queued.get(x.worker.threadId!)).toHaveLength(1);
    await held(x);
  });
  it('holds when dispatch lands between the history snapshot and queue lookup',async()=>{
    const x=await lostSend();
    const input=x.f.queued.get(x.worker.threadId!)![0]!.content;
    let promptRecorded=false;
    x.f.harness.sdk.stub('threads.promptHistory',async()=>promptRecorded?[{input}]:[]);
    x.f.harness.sdk.stub('threads.queuedMessages.list',async()=>{
      promptRecorded=true;
      x.f.queued.set(x.worker.threadId!,[]);
      x.f.threads.set(x.worker.threadId!,{...x.f.threads.get(x.worker.threadId!)!,status:'active'});
      x.f.runtime.onMessageDispatched('lost-q'); // No stored receipt can match this event.
      return [];
    });
    await x.f.service.reconcile();
    expect(promptRecorded).toBe(true);
    await held(x);
  });
  it('holds known delivery after its marker falls outside the bounded history page',async()=>{
    const x=await cancelledDispatched();
    // Already-recorded positive delivery must dominate a history page with no marker.
    x.f.harness.sdk.stub('threads.promptHistory',async()=>Array.from({length:50},(_,i)=>({input:`Later native prompt ${i}`})));
    await x.f.service.reconcile();
    expect(x.f.threads.get(x.worker.threadId!)!.status).toBe('active');
    expect(x.f.store.assignment(x.project.id,2)!.briefDelivered).toBe(true);
    await held(x);
  });
  it('does not discard dispatch evidence arriving during the cancelled queue-loop history await',async()=>{
    const x=await continuation();const {f,project,worker,t2}=x;
    f.queueSend('q');
    await f.service.delegate(project.id,{route:'continue',worker:worker.ref,tasks:[t2.ref]});
    f.queued.set(worker.threadId!,[{id:'q',content:f.send.mock.calls.at(-1)![0].input}]);
    f.harness.sdk.stub('threads.queuedMessages.delete',async()=>{throw new Error('offline')});
    await f.service.stopAssignment(project.id,'A2','cancel');
    let reads=0;
    f.harness.sdk.stub('threads.promptHistory',async()=>{
      if(++reads===1)return []; // Uncertain-operation pass finds the row, deletion fails.
      f.queued.set(worker.threadId!,[]);
      f.threads.set(worker.threadId!,{...f.threads.get(worker.threadId!)!,status:'active'});
      f.runtime.onMessageDispatched('q');
      return Array.from({length:20},(_,i)=>({input:`Later native prompt ${i}`})); // Delayed native dispatch notice wins over the limited page.
    });
    let lists=0;
    f.harness.sdk.stub('threads.queuedMessages.list',async()=>{
      if(++lists===1)return f.queued.get(worker.threadId!)!;
      // Native dispatch has removed the row, but its plugin event is delayed.
      f.queued.set(worker.threadId!,[]);
      f.threads.set(worker.threadId!,{...f.threads.get(worker.threadId!)!,status:'active'});
      return [];
    });
    await f.service.reconcile();
    expect(reads).toBe(2);
    expect(f.store.assignment(project.id,2)!.briefDelivered).toBe(true);
    await held(x);
  });
  it('control: report on an active thread holds, then positive idle frees the task',async()=>{
    const x=await cancelledDispatched();
    x.f.harness.sdk.stub('threads.promptHistory',async()=>[{input:x.input}]);
    await x.f.service.report(x.worker.threadId!,{...report(),assignment:'A2'});
    await x.f.service.reconcile();
    await held(x);
    x.f.idle(x.worker.threadId!);
    await x.f.runtime.onThreadIdle(x.f.threads.get(x.worker.threadId!)!);
    const d=await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]});
    expect(d[0]!.state).toBe('running');
  });
  it('control: quiet sweep frees a dispatched cancellation when native execution ended',async()=>{
    const x=await cancelledDispatched();
    x.f.harness.sdk.stub('threads.promptHistory',async()=>[{input:x.input}]);
    x.f.idle(x.worker.threadId!);
    await x.f.service.reconcile();
    expect(x.f.store.assignment(x.project.id,2)).toMatchObject({state:'cancelled',opState:'done'});
    const d=await x.f.service.delegate(x.project.id,{route:'fresh',tasks:[x.t2.ref]});
    expect(d[0]!.state).toBe('running');
  });
  it('control: usage request obeys the native 100-row cap',async()=>{
    const {f}=await projectFixture();
    let args:any;
    f.harness.sdk.stub('threads.events.list',async(a:any)=>{args=a;return []});
    await f.runtime.sampleUsage(f.store.membership('coordinator')!,'coordinator');
    expect(Number(args.limit)).toBeGreaterThan(0);
    expect(Number(args.limit)*args.types.length).toBeLessThanOrEqual(100);
    expect(f.store.usage('coordinator')).toBeNull();
  });
});

const asSidebar=(t:any)=>({...t,isArchived:t.archivedAt!==null,isUnread:false,isPinned:false,hasPendingInteraction:false,indicator:t.status==='active'?'runtime':'none',activity:{},updatedAt:100});
const flatten=(rows:any[]):string[]=>rows.flatMap(r=>[r.thread.id,...flatten(r.children)]);
describe('A27 association guard controls',()=>{
  it('control: foreign adhoc membership blocks coordinator replacement',async()=>{
    const {f,project}=await projectFixture();
    const child=await f.spawn({projectId:'proj_a',parentThreadId:'coordinator'});
    f.service.associateNativeChild(child);f.idle(child.id);
    f.threads.set('coordinator-b',makeThreadResponse({id:'coordinator-b',projectId:'proj_a',environmentId:'env_a'}));
    const {project:other}=await f.service.createProject({name:'Other',objective:'other',memberProjectIds:['proj_a'],coordinator:{kind:'adopt',threadId:'coordinator-b'}});
    await expect(f.service.replaceCoordinator(other.id,{reason:'steal',adoptThreadId:child.id})).rejects.toThrow(/already belongs/);
    expect(f.store.membership(child.id)?.project.id).toBe(project.id);
  });
  it.each(['work','review'] as const)('control: same-project adhoc cannot upgrade a native %s fork into coordinator',async(role)=>{
    const {f,project}=await projectFixture();const t=f.task(project.id);
    if(role==='review') { const [implementation]=await f.service.delegate(project.id,{route:'fresh',tasks:[t.ref]}); await f.service.report(implementation.threadId!,report()); f.idle(implementation.threadId!); }
    const [d]=await f.service.delegate(project.id,role==='review'?{route:'fresh',role,reviewOf:[t.ref]}:{route:'fresh',role,tasks:[t.ref]});
    const child=await f.spawn({projectId:'proj_a',parentThreadId:'coordinator'});
    f.threads.set(child.id,{...child,sourceThreadId:d.threadId});
    f.service.associateNativeChild(child);f.idle(child.id);
    await expect(f.service.replaceCoordinator(project.id,{reason:'promote fork',adoptThreadId:child.id})).rejects.toThrow(/immutable/);
    expect(f.store.membership(child.id)?.kind).toBe('adhoc');
  });
  it('control: nested selection survives coordinator replacement with history intact',async()=>{
    const {f,project}=await projectFixture();
    const child=await f.spawn({projectId:'proj_a',parentThreadId:'coordinator'});
    const nested=await f.spawn({projectId:'proj_a',parentThreadId:child.id});
    await f.runtime.sweep();
    f.threads.set('next',makeThreadResponse({id:'next',projectId:'proj_a',environmentId:'env_a'}));
    await f.service.replaceCoordinator(project.id,{reason:'replace',adoptThreadId:'next'});
    expect(f.store.membership('coordinator')?.former).toBe(true);
    expect(f.store.membership(nested.id)?.project.id).toBe(project.id);
    expect(selectedProject(f.tree().projects,[...f.threads.values()].map(asSidebar),nested.id,'proj_a')?.id).toBe(project.id);
  });
  it.each(['archived','missing','deleted'] as const)('control: %s associated thread is hidden without exporting active state',async(mode)=>{
    const {f,project}=await projectFixture();const child=await f.spawn({projectId:'proj_a',parentThreadId:'coordinator'});
    await f.runtime.sweep();
    if(mode==='archived')f.threads.set(child.id,{...child,archivedAt:1});
    else if(mode==='deleted')f.threads.set(child.id,{...child,deletedAt:1,archivedAt:1});
    else f.threads.delete(child.id);
    const visible=[...f.threads.values()].filter(t=>t.archivedAt===null&&t.deletedAt===null).map(asSidebar);
    const p=f.tree().projects[0]!;
    expect(flatten(currentProjectThreads(p,visible,[],'updated','descending'))).not.toContain(child.id);
    expect(projectStatus(p,visible,[])).toBe('done');
    expect(p.nodes.find(n=>n.threadId===child.id)!.state).toBe('member');
    expect(f.store.projectThreads(project.id)).toHaveLength(1);
  });
});
