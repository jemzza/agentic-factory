import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { STORED_RUN_STATUSES } from "../store/store.js";
import type { Redactor } from "../store/redact.js";
import {
  comparable,
  readEvalSummary,
  readReport,
  readSpecNotice,
  type DashboardSource,
} from "./data.js";
import type { Html } from "./html.js";
import { comparePage, evalPage, evalsPage, notFoundPage, runPage, runsPage } from "./views.js";

/** The dashboard listens on loopback only; there is no option to change it. */
export const DASHBOARD_HOST = "127.0.0.1";

/**
 * Token and key shapes masked in every page, on top of the configured secret values
 * (defence in depth: such values should never have been written in the first place).
 */
const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
export const maskShapes = (text: string): string =>
  SECRET_SHAPES.reduce((acc, re) => acc.replace(re, "***"), text);

const RunsQuerySchema = z.object({
  project: z.string().max(100).optional(),
  status: z.enum(STORED_RUN_STATUSES).or(z.literal("")).optional(),
});
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/);
const CompareQuerySchema = z.object({ a: IdSchema, b: IdSchema });

/**
 * Read-only dashboard: GET routes only, server-rendered HTML without scripts. Every response
 * passes the secret redactor. Requests whose Host is not this loopback address are refused
 * (no DNS rebinding). The caller opens the database with `query_only`.
 */
export function buildDashboard(
  src: DashboardSource,
  opts: { redact: Redactor; port: number },
): FastifyInstance {
  const app = Fastify({ logger: false });
  const allowedHosts = new Set([
    `${DASHBOARD_HOST}:${String(opts.port)}`,
    `localhost:${String(opts.port)}`,
  ]);

  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      await reply.code(403).type("text/plain").send("forbidden host");
    }
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("cache-control", "no-store");
    return typeof payload === "string" ? maskShapes(opts.redact(payload)) : payload;
  });

  const page = (body: Html) => body.value;
  const send = (reply: { type: (t: string) => unknown }, body: Html) => {
    reply.type("text/html; charset=utf-8");
    return page(body);
  };

  app.get("/", async (req, reply) => {
    const q = RunsQuerySchema.safeParse(req.query);
    const project = q.success && q.data.project ? q.data.project : null;
    const status = q.success && q.data.status ? q.data.status : null;
    const runs = src.store.listRuns({
      ...(project ? { projectId: project } : {}),
      ...(status ? { status } : {}),
      limit: 500,
    });
    return send(
      reply,
      runsPage(runs, {
        projects: src.store.listRunProjects(),
        statuses: STORED_RUN_STATUSES,
        filter: { project, status },
        repos: src.githubRepos,
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const id = IdSchema.safeParse(req.params.id);
    const run = id.success ? src.store.getRun(id.data) : null;
    if (!run) return send(reply.code(404), notFoundPage("No such run."));
    return send(
      reply,
      runPage({
        run,
        repo: src.githubRepos[run.project_id],
        steps: src.store.listSteps(run.id),
        events: src.store.listEvents(run.id),
        approvals: src.store.listApprovals(run.id),
        specVersions: src.store.listSpecVersions(run.id),
        report: await readReport(src, run),
        notice: run.status === "awaiting_spec_approval" ? await readSpecNotice(src, run) : null,
      }),
    );
  });

  app.get("/evals", async (_req, reply) => send(reply, evalsPage(src.store.listEvals(500))));

  app.get("/evals/compare", async (req, reply) => {
    const q = CompareQuerySchema.safeParse(req.query);
    const a = q.success ? src.store.getEval(q.data.a) : null;
    const b = q.success ? src.store.getEval(q.data.b) : null;
    if (!a || !b) return send(reply.code(404), notFoundPage("No such eval."));
    const c = comparable(a, b);
    const views = { a: await readEvalSummary(src, a), b: await readEvalSummary(src, b) };
    return send(reply, comparePage(a, b, views, c.ok ? null : c.reason));
  });

  app.get<{ Params: { id: string } }>("/evals/:id", async (req, reply) => {
    const id = IdSchema.safeParse(req.params.id);
    const e = id.success ? src.store.getEval(id.data) : null;
    if (!e) return send(reply.code(404), notFoundPage("No such eval."));
    const runs = src.store.listRuns({ evalId: e.id, limit: 1000 });
    return send(reply, evalPage(e, await readEvalSummary(src, e), runs));
  });

  app.setNotFoundHandler(async (_req, reply) =>
    send(reply.code(404), notFoundPage("No such page.")),
  );
  return app;
}
