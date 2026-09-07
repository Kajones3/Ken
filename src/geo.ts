/** Great-circle distance in miles. Shared by the mock flight provider (to
 *  scale fares with distance) and the driving-cost estimate (to scale gas
 *  cost with distance) — one formula, not two copies drifting apart. */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
