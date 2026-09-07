/**
 * ip-api.com — free tier, no key, ~45 requests/minute, non-commercial use,
 * HTTP only. Called server-side against the *request's* IP for a best-effort
 * "Departing from" autofill; a failure or timeout just leaves the search box
 * empty; it never blocks the trip form. Written to the documented shape,
 * not run against live traffic from this environment — same caveat as every
 * other real provider here.
 */
import type { IpLocateProvider, IpLocateResult } from "./types.js";

export class IpApiLocateProvider implements IpLocateProvider {
  readonly name = "ip-api";
  async locate(ip: string): Promise<IpLocateResult | null> {
    if (!ip || ip === "127.0.0.1" || ip === "::1") return null;
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,lat,lon`);
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string; city?: string; regionName?: string; lat?: number; lon?: number };
    if (data.status !== "success" || typeof data.lat !== "number" || typeof data.lon !== "number") return null;
    const label = [data.city, data.regionName].filter(Boolean).join(", ") || "Your location";
    return { label, lat: data.lat, lon: data.lon };
  }
}
