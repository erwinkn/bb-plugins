/** The browser's echo-cancelled microphone stream also feeds the endpoint meter.
 * It never connects to speakers. Its levels cannot authorize or interrupt work.
 */
export interface MeterEvents {
  /** The AudioContext left the running state, or came back. A suspended meter reads silence. */
  state?: (state: string, resumed: boolean) => void;
}
/** Stop function; `state` reads the AudioContext state when the meter exposes one. */
export type MeterHandle = (() => void) & { state?: () => string };
export async function startMicrophoneMeter(
  stream: MediaStream,
  sample: (rms: number) => void,
  events: MeterEvents = {},
): Promise<MeterHandle> {
  const context = new AudioContext();
  try {
    await context.resume();
    if (context.state !== "running")
      throw new Error("The microphone activity monitor could not start.");
    const source = context.createMediaStreamSource(stream),
      analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(values);
      sample(
        Math.sqrt(
          values.reduce((sum, value) => sum + value * value, 0) / values.length,
        ),
      );
    }, 50);
    // A suspended or interrupted context (audio route change, OS interruption)
    // reads zeros, and zeros mean "no speech" upstream. Report it and try to
    // resume, so the cause is on record even when the resume works.
    context.onstatechange = () => {
      const state = context.state as string;
      if (state === "closed") return;
      if (state === "running") { events.state?.(state, true); return; }
      events.state?.(state, false);
      void context.resume().catch(() => undefined);
    };
    const stop = () => {
      clearInterval(timer);
      context.onstatechange = null;
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
    return Object.assign(stop, { state: () => context.state as string });
  } catch (error) {
    void context.close();
    throw error;
  }
}
