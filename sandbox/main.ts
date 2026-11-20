import type { Deps } from "../deps/index.ts";

// Minimal Cloudflare Access login. Access sits in front of the app and adds
// this header only to requests from people who have already logged in.
// Without the header the request did not go through Access: refuse it.
export default function main({ server }: Deps) {
  server.route("*", "/*", (request) => {
    const email = request.headers.get("Cf-Access-Authenticated-User-Email");
    if (!email) return new Response("Não autenticado", { status: 401 });
    return new Response(`Olá, ${email}`);
  });
}
