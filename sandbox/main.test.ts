import type { Tests } from "../deps/testing.ts";

export default function ({ test, assert }: Tests) {
  test("refuses requests that did not go through Access", async (app) => {
    assert.equal((await app.fetch("/")).status, 401);
    assert.equal((await app.fetch("/qualquer/caminho")).status, 401);
  });

  test("greets the person Access identified", async (app) => {
    const response = await app.fetch("/", { headers: { "Cf-Access-Authenticated-User-Email": "ana@example.com" } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Olá, ana@example.com");
  });
}
