import type { Deps } from "../deps/index.ts";
import { registerApi } from "./api.ts";
import { type Ctx, MIGRATIONS, cleanup } from "./core.ts";
import { registerPages } from "./pages.ts";

// Canone: publica e gerencia sites somente leitura. A especificação é o seed.md.
//
//   core.ts      banco, autenticação e as operações de administradores e leitores
//   view.ts      entrega dos arquivos de sites/ (permissão, props, renderização)
//   template.ts  engine de templates
//   pages.ts     páginas /admin, /reader e /root
//   api.ts       rotas /api/admin, /api/reader e /api/root
export default function main({ server, databases, sites, secrets, cron }: Deps) {
  // Um único banco, de identificador "canone" (seed.md, seção 10).
  const ctx: Ctx = { db: databases.open("canone", MIGRATIONS), sites, secrets };

  registerApi(server, ctx);
  registerPages(server, ctx);

  // Limpeza de sessões vencidas e de contagens antigas da senha root, de hora em hora.
  cron.schedule("17 * * * *", (time) => cleanup(ctx, time));
}
