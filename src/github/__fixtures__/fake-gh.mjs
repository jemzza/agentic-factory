// Fake `gh` for tests: `node fake-gh.mjs api -i -X <METHOD> [--input -] <path>`.
// A tiny in-file GitHub: issues, comments, pulls and labels live in the JSON file named by
// FAKE_GH_STATE; every request is appended to state.requests. Output imitates `gh api -i`
// (status line, headers, blank line, JSON body; exit 1 on HTTP errors with the gh-style
// message on stderr), as observed with gh 2.102.0. Response objects follow the REST
// reference shapes (fields the factory reads, plus a few realistic extras).
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
state.requests ??= [];
state.nextId ??= 1000;
state.clock ??= Date.parse("2026-10-20T10:00:00Z");

const args = process.argv.slice(2);
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
const apiPath = args[args.length - 1];
const input = args.includes("--input")
  ? await new Promise((resolve) => {
      let d = "";
      process.stdin.on("data", (c) => (d += c));
      process.stdin.on("end", () => resolve(d ? JSON.parse(d) : null));
    })
  : null;

const [pathOnly, query = ""] = apiPath.split("?");
const q = new URLSearchParams(query);
state.requests.push({
  method,
  path: pathOnly,
  query: Object.fromEntries(q),
  body: input,
  tokenSeen: process.env.GH_TOKEN === state.expectedToken,
  configDir: process.env.GH_CONFIG_DIR ?? null,
});

const tick = () => new Date((state.clock += 1000)).toISOString();
const user = (login) => ({ login, type: "User", id: login.length });
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
function respond(status, body, headers = {}) {
  save();
  const reason =
    {
      200: "OK",
      201: "Created",
      204: "No Content",
      404: "Not Found",
      422: "Unprocessable Entity",
      403: "Forbidden",
      429: "Too Many Requests",
    }[status] ?? "";
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Ratelimit-Limit": "5000",
    "X-Ratelimit-Remaining": String(state.rateRemaining ?? 4999),
    "X-Ratelimit-Reset": "1792400000",
    ...headers,
  };
  process.stdout.write(
    `HTTP/2.0 ${status} ${reason}\n${Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n\n${body === null ? "" : JSON.stringify(body, null, 2)}\n`,
  );
  if (status >= 400) {
    process.stderr.write(`gh: ${body?.message ?? "error"} (HTTP ${status})\n`);
    process.exit(1);
  }
  process.exit(0);
}
const page = (items) => {
  const per = Number(q.get("per_page") ?? 30);
  const p = Number(q.get("page") ?? 1);
  return items.slice((p - 1) * per, p * per);
};
const since = (items, field = "updated_at") =>
  q.get("since") ? items.filter((i) => i[field] >= q.get("since")) : items;
const byUpdated = (a, b) =>
  a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id;

if (state.failNext) {
  const f = state.failNext;
  delete state.failNext;
  respond(f.status, { message: f.message ?? "failure" }, f.headers ?? {});
}

const m = (re) => re.exec(pathOnly);
let r;
const repo = m(/^repos\/([^/]+\/[^/]+)\//)?.[1] ?? null;
const issueObj = (i) => ({
  ...i,
  html_url: `https://github.com/${repo}/issues/${i.number}`,
  labels: i.labels.map((name) => ({ name })),
});
// Entries may carry `repo` ("owner/name"); entries without it belong to every repository.
const inRepo = (x) => x.repo === undefined || x.repo === repo;
const findIssue = (n) => state.issues.find((i) => i.number === n && inRepo(i));
const findPull = (n) => state.pulls.find((p) => p.number === n && inRepo(p));

if (method === "GET" && m(/^repos\/[^/]+\/[^/]+\/issues$/)) {
  const label = q.get("labels");
  const items = since(
    state.issues.filter((i) => inRepo(i) && (!label || i.labels.includes(label))),
  ).sort(byUpdated);
  respond(200, page(items).map(issueObj));
}
if (method === "GET" && m(/^repos\/[^/]+\/[^/]+\/issues\/comments$/)) {
  respond(
    200,
    page(
      since(state.comments.filter((c) => c.issue_url.includes(`/repos/${repo}/`))).sort(byUpdated),
    ),
  );
}
if (method === "GET" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
  const url = `https://api.github.com/repos/${repo}/issues/${r[1]}`;
  respond(200, page(state.comments.filter((c) => c.issue_url === url).sort((a, b) => a.id - b.id)));
}
if (method === "GET" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
  const i = findIssue(Number(r[1]));
  if (i) respond(200, issueObj(i));
  respond(404, { message: "Not Found" });
}
if (method === "PATCH" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
  const i = findIssue(Number(r[1]));
  if (!i) respond(404, { message: "Not Found" });
  Object.assign(i, input, { updated_at: tick() });
  respond(200, issueObj(i));
}
if (method === "POST" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
  const n = Number(r[1]);
  const at = tick();
  const c = {
    id: state.nextId++,
    body: input.body,
    user: user(state.tokenOwner ?? "owner"),
    created_at: at,
    updated_at: at,
    issue_url: `https://api.github.com/repos/${repo}/issues/${n}`,
    html_url: `https://github.com/${repo}/issues/${n}#issuecomment-${state.nextId}`,
  };
  state.comments.push(c);
  respond(201, c);
}
if (method === "POST" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/))) {
  const t = findIssue(Number(r[1])) ?? findPull(Number(r[1]));
  for (const l of input.labels) if (!t.labels.includes(l)) t.labels.push(l);
  respond(
    200,
    t.labels.map((name) => ({ name })),
  );
}
if (method === "DELETE" && (r = m(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/(.+)$/))) {
  const t = findIssue(Number(r[1])) ?? findPull(Number(r[1]));
  const name = decodeURIComponent(r[2]);
  if (!t.labels.includes(name)) respond(404, { message: "Label does not exist" });
  t.labels = t.labels.filter((l) => l !== name);
  respond(
    200,
    t.labels.map((n) => ({ name: n })),
  );
}
if (method === "POST" && m(/^repos\/[^/]+\/[^/]+\/labels$/)) {
  state.repoLabels ??= [];
  if (state.repoLabels.includes(input.name)) respond(422, { message: "Validation Failed" });
  state.repoLabels.push(input.name);
  respond(201, { name: input.name, color: input.color });
}
const pullObj = (p) => ({
  ...p,
  html_url: `https://github.com/${repo}/pull/${p.number}`,
  merged: p.merged_at !== null,
  head: { ref: p.head, sha: p.head_sha ?? "0".repeat(40) },
  base: { ref: p.base },
});
if (method === "GET" && m(/^repos\/[^/]+\/[^/]+\/pulls$/)) {
  const head = q.get("head")?.split(":")[1];
  respond(
    200,
    page(state.pulls.filter((p) => inRepo(p) && (!head || p.head === head))).map(pullObj),
  );
}
if (method === "POST" && m(/^repos\/[^/]+\/[^/]+\/pulls$/)) {
  const number =
    Math.max(
      0,
      ...state.issues.filter(inRepo).map((i) => i.number),
      ...state.pulls.filter(inRepo).map((p) => p.number),
    ) + 1;
  const p = {
    id: state.nextId++,
    repo,
    number,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    labels: [],
    user: user(state.tokenOwner ?? "owner"),
  };
  state.pulls.push(p);
  respond(201, pullObj(p));
}
if (method === "GET" && (r = m(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
  const p = findPull(Number(r[1]));
  if (p) respond(200, pullObj(p));
  respond(404, { message: "Not Found" });
}
if (method === "PATCH" && (r = m(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
  const p = findPull(Number(r[1]));
  Object.assign(p, input);
  respond(200, pullObj(p));
}
respond(404, { message: `fake gh: no route for ${method} ${pathOnly}` });
