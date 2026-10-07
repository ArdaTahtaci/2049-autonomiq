import { expect } from "chai";
import { CanonicalizationError, canonicalize } from "../../src/proof/canonicalize";

describe("canonicalize (RFC 8785 / JCS)", () => {
  it("is independent of key insertion order", () => {
    const a = { task_id: "t1", success: true, final_object_position: { x: 1, y: 2, z: 3 } };
    const b = { final_object_position: { z: 3, y: 2, x: 1 }, success: true, task_id: "t1" };
    expect(canonicalize(a)).to.equal(canonicalize(b));
    expect(canonicalize(a)).to.equal('{"final_object_position":{"x":1,"y":2,"z":3},"success":true,"task_id":"t1"}');
  });

  it("sorts nested objects and keeps array order", () => {
    const value = { b: [3, 1, 2, { d: 1, c: [{ z: 0, a: 0 }] }], a: { y: null, x: false } };
    expect(canonicalize(value)).to.equal('{"a":{"x":false,"y":null},"b":[3,1,2,{"c":[{"a":0,"z":0}],"d":1}]}');
    expect(canonicalize([1, 2, 3])).to.not.equal(canonicalize([3, 2, 1]));
  });

  it("emits no whitespace", () => {
    expect(canonicalize({ a: [1, { b: "x y" }] })).to.equal('{"a":[1,{"b":"x y"}]}');
  });

  it("formats numbers with ECMAScript Number-to-String", () => {
    expect(canonicalize(1.0)).to.equal("1");
    expect(canonicalize(0.1)).to.equal("0.1");
    expect(canonicalize(-0)).to.equal("0");
    expect(canonicalize(1e21)).to.equal("1e+21");
    expect(canonicalize(1e20)).to.equal("100000000000000000000");
    expect(canonicalize(1e-7)).to.equal("1e-7");
    expect(canonicalize(-1.5)).to.equal("-1.5");
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).to.equal("9007199254740991");
    expect(canonicalize({ x: 1.01, y: 0.01, z: -0 })).to.equal('{"x":1.01,"y":0.01,"z":0}');
  });

  it("serializes primitives", () => {
    expect(canonicalize(null)).to.equal("null");
    expect(canonicalize(true)).to.equal("true");
    expect(canonicalize(false)).to.equal("false");
    expect(canonicalize("hi")).to.equal('"hi"');
  });

  it("escapes strings minimally and keeps non-ASCII characters literal", () => {
    expect(canonicalize("€")).to.equal('"€"');
    expect(canonicalize("😀")).to.equal('"😀"');
    expect(canonicalize('quote " backslash \\')).to.equal('"quote \\" backslash \\\\"');
    expect(canonicalize("line\nbreak\ttab")).to.equal('"line\\nbreak\\ttab"');
    expect(canonicalize("\u0000\u001f")).to.equal('"\\u0000\\u001f"');
    expect(canonicalize("/")).to.equal('"/"');
  });

  it("rejects strings and keys containing lone surrogates", () => {
    expect(() => canonicalize("\ud800")).to.throw(CanonicalizationError);
    expect(() => canonicalize({ ["\udc00"]: 1 })).to.throw(CanonicalizationError);
  });

  // RFC 8785 vectors are built from char codes so no tool/transpiler can pre-decode the escapes.
  const BS = "\\";
  const ch = (code: number): string => String.fromCodePoint(code);

  it("matches the RFC 8785 section 3.2.2 example", () => {
    // JSON text: "string": "<BS>u20ac$<BS>u000F<BS>u000aA'<BS>u0042<BS>u0022<BS>u005c<BS><BS><BS>\"<BS>/"
    const jsonString = ["u20ac", "$", "u000F", "u000a", "A'", "u0042", "u0022", "u005c"]
      .map((part) => (part.startsWith("u") ? BS + part : part))
      .join("") + BS + BS + BS + '"' + BS + "/";
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "' + jsonString + '", "literals": [null, true, false]}',
    );
    const expected =
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"' + ch(0x20ac) + "$" + BS + "u000f" + BS + "nA'B" + BS + '"' + BS + BS + BS + BS + BS + '"/"}';
    expect(input.string).to.equal(ch(0x20ac) + "$" + ch(0x0f) + ch(0x0a) + "A'B" + '"' + BS + BS + '"/');
    expect(canonicalize(input)).to.equal(expected);
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 example)", () => {
    const input: Record<string, string> = {
      [ch(0x20ac)]: "Euro Sign",
      [ch(0x0d)]: "Carriage Return",
      [ch(0xfb33)]: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [ch(0x1f600)]: "Emoji: Grinning Face",
      [ch(0x80)]: "Control",
      [ch(0xf6)]: "Latin Small Letter O With Diaeresis",
    };
    const expected =
      '{"' + BS + 'r":"Carriage Return","1":"One","' + ch(0x80) + '":"Control",' +
      '"' + ch(0xf6) + '":"Latin Small Letter O With Diaeresis","' + ch(0x20ac) + '":"Euro Sign",' +
      '"' + ch(0x1f600) + '":"Emoji: Grinning Face","' + ch(0xfb33) + '":"Hebrew Letter Dalet With Dagesh"}';
    expect(canonicalize(input)).to.equal(expected);
  });

  it("omits object properties whose value is undefined", () => {
    expect(canonicalize({ a: 1, b: undefined })).to.equal('{"a":1}');
    expect(canonicalize({ a: 1, b: undefined })).to.equal(canonicalize({ a: 1 }));
  });

  it("accepts null-prototype objects and shared (non-cyclic) references", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 2;
    bare.a = 1;
    expect(canonicalize(bare)).to.equal('{"a":1,"b":2}');
    const shared = { x: 1 };
    expect(canonicalize({ p: shared, q: [shared, shared] })).to.equal('{"p":{"x":1},"q":[{"x":1},{"x":1}]}');
  });

  describe("rejects values without an unambiguous JSON form", () => {
    class Point {
      constructor(public x = 1) {}
    }
    const cyclicObject: Record<string, unknown> = { a: 1 };
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);

    const cases: Array<[string, unknown]> = [
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", { x: -Infinity }],
      ["bigint", { amount: BigInt(1) }],
      ["Date", { at: new Date(0) }],
      ["Map", new Map()],
      ["Set", [new Set([1])]],
      ["class instance", { p: new Point() }],
      ["typed array", new Uint8Array([1])],
      ["function", { f: () => 1 }],
      ["symbol", [Symbol("s")]],
      ["undefined at top level", undefined],
      ["undefined in array", [1, undefined, 3]],
      ["sparse array hole", [1, , 3]], // eslint-disable-line no-sparse-arrays
      ["cyclic object", cyclicObject],
      ["cyclic array", cyclicArray],
    ];

    for (const [label, value] of cases) {
      it(label, () => {
        expect(() => canonicalize(value)).to.throw(CanonicalizationError);
      });
    }

    it("reports the offending path", () => {
      expect(() => canonicalize({ a: { b: [0, NaN] } })).to.throw(CanonicalizationError, "$.a.b[1]");
    });
  });
});
