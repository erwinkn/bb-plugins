import protobuf from "protobufjs";

// Wire fields from the installed Devin Desktop protobuf descriptors (2026-09-06).
// Keep only usage/account fields; protobuf skips unrelated and future fields.
const root = protobuf.parse(`syntax = "proto3";
message Timestamp { int64 seconds = 1; }
message PlanInfo { string plan_name = 2; bool hide_daily_quota = 36; bool hide_weekly_quota = 37; }
message PlanStatus {
  PlanInfo plan_info = 1; Timestamp plan_end = 3;
  int32 daily_quota_remaining_percent = 14; int32 weekly_quota_remaining_percent = 15;
  int64 daily_quota_reset_at_unix = 17; int64 weekly_quota_reset_at_unix = 18;
  optional double acu_consumed = 19; optional double acu_limit = 20;
}
message UserStatus { string email = 7; PlanStatus plan_status = 13; }
message Response { UserStatus user_status = 1; PlanInfo plan_info = 2; }
`).root;
const responseType = root.lookupType("Response");

export function decodeUsageResponse(bytes: Uint8Array): unknown {
  // Omitted scalar fields retain proto3 defaults, including zero remaining quota.
  return responseType.toObject(responseType.decode(bytes), { longs: Number, defaults: true });
}

export function encodeUsageFixture(value: object): Uint8Array {
  return responseType.encode(responseType.create(value)).finish();
}

export function decodeCachedUserStatus(bytes: Uint8Array): unknown {
  const type = root.lookupType("UserStatus");
  return { userStatus: type.toObject(type.decode(bytes), { longs: Number, defaults: true }) };
}
export function encodeCachedUsageFixture(value: object): Uint8Array {
  const type = root.lookupType("UserStatus");
  return type.encode(type.create(value)).finish();
}
