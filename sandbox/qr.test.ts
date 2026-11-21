import type { Tests } from "../deps/testing.ts";
import { qrMatrix, qrSvg } from "./qr.ts";

// The QR code of the two-step setup. What is checked here is what the
// standard fixes: sizes, capacities, the fixed patterns and the format bits.
export default function ({ test, assert }: Tests) {
  const rows = (text: string): string[] => (qrMatrix(text) ?? []).map((row) => row.map((on) => (on ? "1" : "0")).join(""));

  test("qr: a code grows with the text, at the capacities of the standard", async () => {
    // Bytes that fit in versions 1 to 10 at level M (ISO/IEC 18004, table 7).
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    capacity.forEach((bytes, i) => {
      const version = i + 1;
      assert.equal(rows("a".repeat(bytes)).length, version * 4 + 17, `version ${version} holds ${bytes}`);
      assert.equal(rows("a".repeat(bytes + 1)).length, (version + 1) * 4 + 17, `${bytes + 1} need version ${version + 1}`);
    });
    // Letters outside ASCII count by their bytes.
    assert.equal(rows("ã".repeat(7)).length, 21);
    assert.equal(rows("ã".repeat(8)).length, 25);
    assert.equal(qrMatrix("a".repeat(2331))?.length, 177);
    assert.equal(qrMatrix("a".repeat(2332)), null);
  });

  test("qr: the fixed patterns and the format bits are where a camera looks for them", async () => {
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    // The 15 format bits of level M, for each of the eight masks.
    const formats = [
      "101010000010010", "101000100100101", "101111001111100", "101101101001011",
      "100010111111001", "100000011001110", "100111110010111", "100101010100000",
    ];
    for (const text of ["a", "otpauth://totp/Gatefold%3Aleo?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=Gatefold", "b".repeat(400)]) {
      const code = rows(text);
      const size = code.length;
      assert(code.every((row) => row.length === size), "square");
      finder.forEach((line, y) => {
        assert.equal([code[y]!.slice(0, 8), code[y]!.slice(size - 8)], [`${line}0`, `0${line}`]);
        assert.equal(code[size - 7 + y]!.slice(0, 8), `${line}0`);
      });
      // The timing lines alternate between the corner squares.
      for (let i = 8; i < size - 8; i++) assert.equal([code[6]![i], code[i]![6]], [i % 2 === 0 ? "1" : "0", i % 2 === 0 ? "1" : "0"]);
      assert.equal(code[size - 8]![8], "1");
      // The format bits, read from both copies, most significant first.
      const first = [...[0, 1, 2, 3, 4, 5, 7].map((x) => code[8]![x]), code[8]![8], code[7]![8], ...[5, 4, 3, 2, 1, 0].map((y) => code[y]![8])].join("");
      const second = [...[1, 2, 3, 4, 5, 6, 7].map((i) => code[size - i]![8]), ...[8, 7, 6, 5, 4, 3, 2, 1].map((i) => code[8]![size - i])].join("");
      assert(formats.includes(first), `format bits ${first}`);
      assert.equal(second, first);
    }
  });

  test("qr: the picture has a white margin and nothing but shapes", async () => {
    const svg = qrSvg("hello, world", 184, 'A "label" <with> marks') ?? "";
    assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="184" height="184"'));
    assert(svg.includes('aria-label="A label with marks"') && svg.includes('<rect width="29" height="29" fill="#fff"/>'));
    assert(/<path d="[MhvzZ0-9,-]+" fill="#000"\/><\/svg>$/.test(svg));
    assert.equal(qrSvg("a".repeat(3000), 184, "too long"), null);
  });
}
