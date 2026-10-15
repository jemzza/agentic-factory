import { buildApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "127.0.0.1";

const app = buildApp({ logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
