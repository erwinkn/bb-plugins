/** The browser's echo-cancelled microphone stream also feeds the endpoint meter.
 * It never connects to speakers. Its levels cannot authorize or interrupt work.
 */
export async function startMicrophoneMeter(
  stream: MediaStream,
  sample: (rms: number) => void,
): Promise<() => void> {
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
    return () => {
      clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  } catch (error) {
    void context.close();
    throw error;
  }
}
