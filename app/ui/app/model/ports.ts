// What a switch's ports are actually doing, in the three states an operator distinguishes.
//
// "59/97 interfaces up" reads as thirty-eight broken ports. On a switch it almost never is: most of
// them were never patched, or someone shut them on purpose. The device reports both facts — ifOperStatus
// and ifAdminStatus — and keeping them apart is the difference between a screen a network team trusts
// and one they explain away. Measured on one environment: of 4,310 ports not up, 2,836 were
// administratively down or absent, and only 1,485 were ports somebody expected to be carrying traffic.
import type { Device, Iface } from "./types";

export interface PortCounts {
  up: number;
  /** admin up, oper not up: a port that is meant to be carrying traffic and is not */
  down: number;
  /** shut by an operator, or no module in the slot: not a fault */
  unused: number;
  total: number;
  /** false in an estate too large to read every port, where only the total is known */
  known: boolean;
}

const isUp = (i: Iface) => i.oper.startsWith("up");
const isUnused = (i: Iface) => i.admin.startsWith("down") || i.oper.startsWith("notPresent");

export function portCounts(d: Device): PortCounts {
  if (!d.interfaces.length) {
    return { up: 0, down: 0, unused: 0, total: d.ifStats?.interfaces ?? 0, known: false };
  }
  let up = 0, unused = 0;
  for (const i of d.interfaces) {
    if (isUp(i)) up++;
    else if (isUnused(i)) unused++;
  }
  return { up, down: d.interfaces.length - up - unused, unused, total: d.interfaces.length, known: true };
}
