// Which site an IPv4 address belongs to.
//
// Two sources, in this order: the site_cidr tag the customer set on the site (any prefix length, the
// longest match wins), then the /24 of any address a device at that site carries — every interface
// address SNMP autodiscovery lists, not only the management one. A /24 claimed by devices at two sites
// is left unattributed rather than guessed.

export type AddressKind = "site" | "private" | "internet";

export interface AddressOwner {
  kind: AddressKind;
  site?: string;
  /** how the site was known: the customer's tag, or a device address in the same /24 */
  source?: "tag" | "device";
}

const toInt = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
const inBlock = (ip: number, base: number, bits: number) => ((ip & maskOf(bits)) >>> 0) === ((base & maskOf(bits)) >>> 0);

// RFC 1918, carrier-grade NAT, link-local and loopback: addresses that are somebody's inside
const PRIVATE: [number, number][] = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16], ["127.0.0.0", 8]]
  .map(([b, n]) => [toInt(b as string)!, n as number]);

export const isIpv4 = (ip: string) => toInt(ip) != null;
export const isPrivate = (ip: string) => { const v = toInt(ip); return v != null && PRIVATE.some(([b, n]) => inBlock(v, b, n)); };

export function buildAddressing(tagged: { site: string; cidr: string }[], devices: { site: string; ips: string[] }[]) {
  const blocks = tagged.flatMap(({ site, cidr }) => cidr.split(/[,;\s]+/).filter(Boolean).flatMap((c) => {
    const [addr, len] = c.split("/");
    const base = toInt(addr), bits = len == null ? 24 : Number(len);
    return base == null || !(bits >= 0 && bits <= 32) ? [] : [{ site, base, bits }];
  })).sort((a, b) => b.bits - a.bits);
  const by24 = new Map<number, string | null>();
  devices.forEach(({ site, ips }) => ips.forEach((ip) => {
    const v = toInt(ip);
    if (v == null) return;
    const k = (v & maskOf(24)) >>> 0;
    const cur = by24.get(k);
    by24.set(k, cur === undefined || cur === site ? site : null);
  }));
  return {
    /** number of subnets known to belong to a site */
    known: blocks.length + [...by24.values()].filter(Boolean).length,
    tagged: blocks.length,
    ownerOf(ip: string): AddressOwner {
      const v = toInt(ip);
      if (v == null) return { kind: "internet" };
      const b = blocks.find((x) => inBlock(v, x.base, x.bits));
      if (b) return { kind: "site", site: b.site, source: "tag" };
      const s = by24.get((v & maskOf(24)) >>> 0);
      if (s) return { kind: "site", site: s, source: "device" };
      return { kind: isPrivate(ip) ? "private" : "internet" };
    },
  };
}

export type Addressing = ReturnType<typeof buildAddressing>;
