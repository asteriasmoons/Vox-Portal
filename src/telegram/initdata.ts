// Validate a Telegram Mini App initData string per:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// The validation is HMAC-SHA256 with a two-step key derivation:
//   secret = HMAC_SHA256(key="WebAppData", data=bot_token)
//   hash   = HMAC_SHA256(key=secret,       data=data_check_string)
// where data_check_string is every field EXCEPT `hash`, sorted by key,
// joined as "k=v\n...".
//
// We also enforce a max age on `auth_date` so a stolen initData can't be
// replayed indefinitely.

import type { Env } from "../config";

const MAX_AGE_SECONDS = 60 * 60 * 24; // 24h — Telegram recommends ≤ 1 day

export interface InitDataUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ValidatedInitData {
  raw: string;
  user: InitDataUser;
  auth_date: number;
  query_id?: string;
}

export async function validateInitData(env: Env, initData: string): Promise<ValidatedInitData> {
  if (!initData) throw new Error("missing initData");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("initData missing hash");
  params.delete("hash");

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate) throw new Error("initData missing auth_date");
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > MAX_AGE_SECONDS) throw new Error("initData expired");

  // Build data_check_string: sorted key=value pairs joined by \n.
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(env.TELEGRAM_BOT_TOKEN));
  const sig = await hmacSha256(secretKey, enc.encode(dataCheckString));
  const sigHex = toHex(sig);

  if (!timingSafeEqualHex(sigHex, hash.toLowerCase())) {
    throw new Error("initData signature mismatch");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("initData missing user");
  const user = JSON.parse(userRaw) as InitDataUser;
  if (!user || typeof user.id !== "number") throw new Error("initData user malformed");

  return {
    raw: initData,
    user,
    auth_date: authDate,
    query_id: params.get("query_id") ?? undefined,
  };
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, data);
}

function toHex(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
