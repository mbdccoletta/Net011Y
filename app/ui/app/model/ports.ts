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
  /**
   * The port reports no operational status the app could read.
   *
   * These used to be counted as down, because `down` was everything left over after up and
   * unused. Measured on a firewall with four interfaces in Smartscape: the panel read "3 up,
   * 5 down" and the device had nothing down at all — the ports arrive from the metric rows,
   * and the ones whose Smartscape node did not match fall back to `oper: "unknown"`. Not
   * knowing a port's state is not the same statement as the port having failed, and the one
   * the app was making sent a reader hunting a fault that was never reported.
   */
  unknown: number;
  total: number;
  /** false in an estate too large to read every port, where only the total is known */
  known: boolean;
}

/** the one definition of "this port is up": the value arrives as `up(1)`, not as `up` */
export const isUp = (i: Pick<Iface, "oper">) => i.oper.startsWith("up");
/** shut by an operator, or no module in the slot — the one test that separates a port nobody
 *  expects to be carrying traffic from one that is failing to */
export const isUnused = (i: Iface) => i.admin.startsWith("down") || i.oper.startsWith("notPresent");
/** no readable operational status: neither up, nor down, nor deliberately off */
export const isUnknownState = (i: Pick<Iface, "oper">) => !i.oper || i.oper.startsWith("unknown");

export function portCounts(d: Device): PortCounts {
  if (!d.interfaces.length) {
    return { up: 0, down: 0, unused: 0, unknown: 0, total: d.ifStats?.interfaces ?? 0, known: false };
  }
  let up = 0, unused = 0, unknown = 0;
  for (const i of d.interfaces) {
    if (isUp(i)) up++;
    else if (isUnused(i)) unused++;
    else if (isUnknownState(i)) unknown++;
  }
  return { up, down: d.interfaces.length - up - unused - unknown, unused, unknown, total: d.interfaces.length, known: true };
}

/**
 * A port that carries a cable, as against a logical interface the device invents.
 *
 * Measured on a firewall whose panel read "5 ports enabled and not carrying traffic": the five
 * were loopback, mgmt, two tunnels and a vm-interface — a tunnel with no peer established and a
 * loopback are oper-down as a matter of course, and naming them as ports that should be working
 * is the same false confidence the app exists to avoid. ifType is the test the device itself
 * publishes: ethernetCsmacd and the LAG that bundles them are links; everything else is not.
 */
const PHYSICAL = /^(ethernetCsmacd|ieee8023adLag|fastEther|gigabitEthernet|infiniband|sonet|opticalChannel)/i;
export const isPhysical = (i: Iface) => !i.type || PHYSICAL.test(i.type);

/** The links that are enabled and not carrying traffic: the ones somebody expected to be up. */
export const portsDown = (d: Device): Iface[] =>
  d.interfaces.filter((i) => !isUp(i) && !isUnused(i) && !isUnknownState(i) && isPhysical(i));
