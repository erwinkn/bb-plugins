import test from "node:test";
import assert from "node:assert/strict";
import {
  InputController,
  EFFECT_QUIET_MS,
  FINAL_TRANSCRIPT_MS,
} from "./input-controller.ts";
function fixture() {
  let now = 0;
  const sent: any[] = [],
    interruptions: any[] = [],
    finals: any[] = [],
    repairs: string[] = [],
    drafts: any[] = [];
  let view = {
    threadId: "build" as string | null,
    projectId: "app" as string | null,
    onNewThreadScreen: false,
  };
  const input = new InputController({
    now: () => now,
    view: () => view,
    send: (event) => {
      sent.push(event);
      return true;
    },
    changed: () => {},
    interrupt: (item) => interruptions.push({ ...item }),
    draft: (item) => drafts.push({ ...item }),
    final: (item, late) => finals.push({ ...item, late }),
    repair: (text) => repairs.push(text),
    log: () => {},
  });
  const advance = (ms: number) => {
    now += ms;
    input.sample(0);
  };
  const words = (id: string, text: string) => {
    input.sample(0.02);
    now += 150;
    input.sample(0.02);
    input.delta(id, text);
    advance(300);
    advance(800);
    input.committed(id);
  };
  return {
    input,
    sent,
    interruptions,
    finals,
    repairs,
    drafts,
    words,
    advance,
    setView: (id: string) => {
      view = { ...view, threadId: id };
    },
  };
}
test("noise and phantom text without sustained microphone activity neither interrupt nor authorize", () => {
  const f = fixture();
  f.input.sample(0.1);
  f.advance(300);
  f.input.delta("noise", "Thank you.");
  f.advance(6000);
  assert.equal(f.interruptions.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.input.snapshot(), null);
  assert.equal(f.repairs.length, 0);
});
test("any recognised word with audio evidence interrupts once; partial words never authorize work", () => {
  const f = fixture();
  f.words("a", "Way");
  f.input.delta("a", " I want to inspect logs");
  assert.equal(f.interruptions.length, 1);
  assert.equal(f.input.snapshot(), null);
  assert.equal(
    f.sent.filter((e) => e.type === "input_audio_buffer.commit").length,
    1,
  );
  f.input.completed("a", "Wait, I want to inspect logs.");
  assert.equal(f.input.snapshot()?.text, "Wait, I want to inspect logs.");
});
test("navigation can use finals while work waits for two seconds after the final", async () => {
  const f = fixture();
  f.words("a", "Open Build");
  f.input.completed("a", "Open Build.");
  assert.ok(await f.input.waitFor(f.input.version, false));
  let accepted = false;
  const work = f.input.waitFor(f.input.version, true).then((value) => {
    accepted = !!value;
  });
  f.advance(EFFECT_QUIET_MS - 1);
  await Promise.resolve();
  assert.equal(accepted, false);
  f.advance(1);
  await work;
  assert.equal(accepted, true);
});
test("a continuation holds unsent work and freezes every final clause for later operations", async () => {
  const f = fixture();
  f.words("a", "Ask Build to inspect logs");
  f.input.completed("a", "Ask Build to inspect logs.");
  const id = f.input.snapshot()!.id,
    version = f.input.version;
  const pending = f.input.waitFor(version, true);
  f.advance(1000);
  f.words("b", "Do not edit files");
  assert.equal(await pending, null);
  assert.equal(f.input.snapshot(), null);
  f.input.completed("b", "Do not edit files.");
  f.advance(2000);
  const one = await f.input.waitFor(f.input.version, true),
    two = await f.input.waitFor(f.input.version, true);
  assert.equal(one!.id, id);
  assert.equal(one!.text, "Ask Build to inspect logs. Do not edit files.");
  assert.deepEqual(one, two);
  assert.deepEqual(
    one!.items.map((i) => i.itemId),
    ["a", "b"],
  );
});
test("a missing clause blocks the whole request; a late final only repairs display", async () => {
  const f = fixture();
  f.words("a", "Ask Build to change it");
  f.input.completed("a", "Ask Build to change it.");
  f.words("b", "Only if");
  const waiting = f.input.waitFor(f.input.version, true);
  f.advance(FINAL_TRANSCRIPT_MS);
  assert.equal(await waiting, null);
  assert.equal(f.input.snapshot(), null);
  assert.equal(f.repairs.length, 1);
  f.input.completed("b", "Only if tests passed.");
  assert.equal(f.input.snapshot(), null);
  assert.equal(f.finals.at(-1).late, true);
  f.words("c", "Inspect logs only, do not edit");
  f.input.completed("c", "Inspect logs only, do not edit.");
  f.advance(2000);
  assert.equal(
    (await f.input.waitFor(f.input.version, true))!.text,
    "Inspect logs only, do not edit.",
  );
});
test("old failures cannot poison a newer complete utterance, and repeated failures ask once", () => {
  const f = fixture();
  f.words("a", "Inspect");
  f.input.completed("a", "", { code: "failed" });
  f.words("b", "Inspect");
  f.input.completed("b", "", { code: "failed" });
  assert.equal(f.repairs.length, 1);
  f.words("c", "Open Build");
  f.input.completed("c", "Open Build");
  f.input.completed("a", "", { code: "late" });
  assert.equal(f.input.snapshot()!.text, "Open Build");
});
test("view is captured from microphone onset and stable across transcription delay", () => {
  const f = fixture();
  f.input.sample(0.02);
  f.advance(150);
  f.input.sample(0.02);
  f.setView("other");
  f.input.delta("a", "Open this thread");
  f.advance(1000);
  f.input.committed("a");
  f.input.completed("a", "Open this thread");
  assert.equal(f.input.snapshot()!.view.threadId, "build");
});
test("duplicate deltas do not duplicate words and disposal releases pending work without committing", async () => {
  const f = fixture();
  f.input.sample(0.02);
  f.advance(150);
  f.input.sample(0.02);
  f.input.delta("a", "Open", "event");
  f.input.delta("a", "Open", "event");
  assert.equal(f.input.item("a")!.text, "Open");
  const work = f.input.waitFor(f.input.version, true);
  f.input.dispose();
  f.advance(10000);
  assert.equal(await work, null);
  assert.equal(f.sent.length, 0);
});

test("microphone or transport loss invalidates unsent effects across recovery", async () => {
  const f = fixture();
  f.words("a", "Ask Build to edit");
  f.input.completed("a", "Ask Build to edit.");
  const pending = f.input.waitFor(f.input.version, true);
  f.input.setAvailable(false);
  assert.equal(await pending, null);
  f.input.setAvailable(true);
  f.advance(3000);
  assert.equal(f.input.snapshot(), null);
  f.words("b", "Inspect only");
  f.input.completed("b", "Inspect only.");
  f.advance(2000);
  assert.equal(
    (await f.input.waitFor(f.input.version, true))!.text,
    "Inspect only.",
  );
});

test("an oversized utterance asks for a smaller request and never silently drops words", async () => {
  const f = fixture();
  f.words("long", "Inspect " + "all files ".repeat(900));
  f.input.completed("long", "Inspect " + "all files ".repeat(900));
  f.advance(2000);
  assert.equal(await f.input.waitFor(f.input.version, true), null);
  assert.equal(f.repairs.length, 1);
  assert.match(f.repairs[0], /split/);
});

test("new microphone activity holds an effect while the next words are still in transit", async () => {
  const f = fixture();
  f.words("a", "Change the build");
  f.input.completed("a", "Change the build.");
  let accepted = false;
  const work = f.input.waitFor(f.input.version, true).then((value) => {
    accepted = !!value;
    return value;
  });
  f.advance(1800);
  f.input.sample(0.02);
  f.advance(150);
  f.input.sample(0.02);
  f.advance(400);
  await Promise.resolve();
  assert.equal(accepted, false);
  f.input.delta("b", "Only inspect it");
  assert.equal(await work, null);
});

test("later speech cannot lend microphone evidence to an old unconfirmed noise item", () => {
  const f = fixture();
  f.input.delta("noise", "Thank you.");
  f.advance(4000);
  f.words("real", "Open Build");
  f.input.completed("real", "Open Build.");
  assert.equal(f.interruptions.length, 1);
  assert.equal(f.interruptions[0].id, "real");
  assert.equal(f.input.snapshot()!.text, "Open Build.");
});
