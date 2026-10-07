/** Console narration shared by the demos (green ✓ steps, yellow ⛔ blocked steps, red ✗ failures). */
import { formatEther } from "ethers";
import type { TaskView } from "../../src/tasks/types";

const color = process.env.NO_COLOR ? false : process.stdout.isTTY;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const cyan = paint(36);
export const magenta = paint(35);
export const dim = paint(2);
export const bold = paint(1);

export const STEP_DELAY_MS = Number(process.env.DEMO_STEP_DELAY_MS ?? 250);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failureCount = 0;
export const failures = () => failureCount;

export async function ok(label: string, detail = ""): Promise<void> {
  console.log(`${green("✓")} ${label.padEnd(34)} ${dim(detail)}`);
  await sleep(STEP_DELAY_MS);
}
export function bad(label: string, detail = ""): void {
  failureCount += 1;
  console.log(`${red("✗")} ${label.padEnd(34)} ${detail}`);
}
export async function blocked(label: string, detail = ""): Promise<void> {
  console.log(`${yellow("⛔")} ${label.padEnd(33)} ${dim(detail)}`);
  await sleep(STEP_DELAY_MS);
}
export async function check(cond: boolean, label: string, detail: string, failDetail = detail): Promise<void> {
  if (cond) await ok(label, detail);
  else bad(label, failDetail);
}
export function section(title: string): void {
  console.log(`\n${bold(cyan(`━━ ${title} `.padEnd(78, "━")))}`);
}
export const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;
export const eth = (wei: string | bigint) => `${formatEther(wei)} ETH`;
export const vec = (v: { x: number; y: number; z: number }) => `(${v.x}, ${v.y}, ${v.z})`;

/** Minimal JSON client for the backend API. */
export function apiClient(baseUrl: string) {
  return async function api<T = TaskView>(method: string, route: string, body?: unknown, rawBody?: string): Promise<{ status: number; body: T }> {
    const res = await fetch(baseUrl + route, {
      method,
      headers: { "content-type": "application/json" },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
}

export const reasonOf = (b: unknown) => {
  const e = b as { error: string; details?: { reasons?: string[] } };
  return e.details?.reasons?.[0] ?? e.error;
};
