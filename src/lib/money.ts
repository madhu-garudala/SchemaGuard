/** Integer minor units as bigint. Decimal strings at every boundary; no floats. */

const INT = /^-?\d+$/;

export function cents(value: string | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`unsafe integer amount: ${value}`);
    return BigInt(value);
  }
  if (!INT.test(value)) throw new Error(`not integer minor units: ${value}`);
  return BigInt(value);
}

export const sameCents = (a: string | bigint, b: string | bigint): boolean => cents(a) === cents(b);

/** "159227" -> "1592.27" (decimal string, sign preserved). */
export function centsToDecimal(value: string | bigint): string {
  const v = cents(value);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Compare two string->cents maps exactly. Returns the keys that differ. */
export function diffCentMaps(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] === undefined || b[k] === undefined || !sameCents(a[k], b[k])).sort();
}
