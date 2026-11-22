/** Test-only names upstream's tests import from BB's private packages, from the SDK's testing entry. */
import type { PromptInput } from "./bb.js";

export {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_createDeltaAssembler as createDeltaAssembler,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
export type {
  BridgeJsonRpcOutputMessage,
  CapturedBridgeJsonRpcOutput,
  DeltaAssembler,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
export { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";

type AssembledEvents = ReturnType<
  import("@get-bb/plugin-sdk/provider-bridge/testing").DeltaAssembler["assemble"]
>;
export type ThreadEvent = AssembledEvents[number];
type ThreadEventScope = ThreadEvent extends { scope: infer Scope }
  ? Scope
  : never;

export function threadScope(): ThreadEventScope {
  return { kind: "thread" } as ThreadEventScope;
}

export function turnScope(turnId: string): ThreadEventScope {
  return { kind: "turn", turnId } as ThreadEventScope;
}

/** A composer's standalone `/compact`: the text with its command mention. */
export function createStandaloneBuiltinCompactCommandInput(): PromptInput[] {
  return [
    {
      type: "text",
      text: "/compact",
      mentions: [
        {
          start: 0,
          end: "/compact".length,
          resource: {
            kind: "command",
            trigger: "/",
            name: "compact",
            source: "command",
            origin: "builtin",
            label: "compact",
            argumentHint: null,
          },
        },
      ],
    },
  ] as PromptInput[];
}
