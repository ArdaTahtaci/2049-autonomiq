/**
 * Deterministic JSON canonicalization for execution proofs.
 *
 * Approach: RFC 8785 — JSON Canonicalization Scheme (JCS).
 *   - Object keys are sorted by UTF-16 code units (JavaScript's default string sort).
 *     JS object key insertion order is never relied upon.
 *   - No insignificant whitespace.
 *   - Strings are serialized exactly like ECMAScript JSON.stringify (minimal escaping,
 *     lowercase \u00xx for control characters). Lone surrogates are rejected because
 *     they cannot be encoded as UTF-8.
 *   - Numbers use the ECMAScript Number-to-String algorithm (what JSON.stringify emits
 *     for finite numbers): 1.0 -> "1", 1e21 -> "1e+21", -0 -> "0".
 *   - Arrays keep their order.
 *   - Object properties whose value is `undefined` are omitted (same as JSON.stringify).
 *
 * Anything that has no unambiguous JSON representation throws CanonicalizationError:
 * non-finite numbers, bigint, functions, symbols, `undefined` at top level or inside
 * arrays, non-plain objects (Date, Map, Set, class instances, typed arrays, ...) and
 * cyclic structures.
 *
 * The canonical string is UTF-8 encoded and hashed (see hash.ts). Any producer can
 * reproduce the exact bytes with an RFC 8785 implementation — e.g. a Python simulator
 * can use the `rfc8785` PyPI package: `rfc8785.dumps(proof)`.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalizationError("cannot canonicalize undefined at $");
  }
  return serialize(value, "$", new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number (${value}) at ${path}`);
      }
      // JSON.stringify implements ECMAScript Number::toString and maps -0 to "0".
      return JSON.stringify(value);
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new CanonicalizationError(`string with lone UTF-16 surrogate at ${path}`);
      }
      return JSON.stringify(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new CanonicalizationError(`unsupported value of type ${typeof value} at ${path}`);
  }

  const obj = value as object;
  if (ancestors.has(obj)) {
    throw new CanonicalizationError(`cyclic structure at ${path}`);
  }

  if (Array.isArray(obj)) {
    ancestors.add(obj);
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      const itemPath = `${path}[${i}]`;
      if (obj[i] === undefined) {
        throw new CanonicalizationError(`undefined array element at ${itemPath}`);
      }
      parts.push(serialize(obj[i], itemPath, ancestors));
    }
    ancestors.delete(obj);
    return `[${parts.join(",")}]`;
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    const kind = (proto as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown";
    throw new CanonicalizationError(`non-plain object (${kind}) at ${path}`);
  }

  ancestors.add(obj);
  const record = obj as Record<string, unknown>;
  const parts: string[] = [];
  // Default sort compares UTF-16 code units, exactly as RFC 8785 requires.
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    const childPath = `${path}.${key}`;
    if (hasLoneSurrogate(key)) {
      throw new CanonicalizationError(`object key with lone UTF-16 surrogate at ${childPath}`);
    }
    parts.push(`${JSON.stringify(key)}:${serialize(child, childPath, ancestors)}`);
  }
  ancestors.delete(obj);
  return `{${parts.join(",")}}`;
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
