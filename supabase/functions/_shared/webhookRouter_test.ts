// 웹훅 길잡이 시험: 연결표가 관리자 설정 체크리스트와 같은지, 동작 ID를 제대로 뽑는지, 기존 함수로 그대로 넘기는지.
import { WEBHOOK_ROUTES, resolveActions, routeById, targetUrl } from "./webhookRoutes.ts"
import { handleRouter, processRouterRetryItem, ROUTER_MISS_TARGET, ROUTER_RETRY_TARGET, type RouterDeps } from "./webhookRouter.ts"

function assert(cond: unknown, msg = "assertion failed"): asserts cond { if (!cond) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg?: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg ?? ""} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)

Deno.test("연결표 = 관리자 설정 웹훅 체크리스트(ID·함수·경로·순서)", async () => {
  const js = await Deno.readTextFile(new URL("../../../admin_settings.js", import.meta.url))
  const block = js.slice(js.indexOf("const CHECKLIST=["), js.indexOf("function route("))
  const items = [...block.matchAll(/\['([a-z0-9-]+)','[^']*',(BUTTON|AUTO),route\('([a-z-]+)'\)(,(\{[^\n]*?)\])?/g)].map((m) => {
    const path = /path:'([^']*)'/.exec(m[5] ?? "")
    return [m[1], m[3], path ? path[1] : ""]
  })
  eq(WEBHOOK_ROUTES.map((r) => [r.id, r.fn, r.path]), items, "routes")
  assert(new Set(WEBHOOK_ROUTES.map((r) => r.id)).size === WEBHOOK_ROUTES.length, "ids unique")
})

Deno.test("동작 ID: 헤더·수식(wait 배열·문자열)·중복·모르는 ID", () => {
  const h = new Headers({ "x-hada-action": "reg-link-regenerate, nope" })
  const body = { data: { id: "p1", properties: { "웹훅 정보": { type: "formula", formula: { type: "string", string: '{"db":"REG","wait":["reg-textbook-queue","reg-link-regenerate","x"]}' } } } } }
  const r = resolveActions(h, body)
  eq(r.ids, ["reg-link-regenerate", "reg-textbook-queue"])
  eq(r.unknown, ["nope", "x"])
  eq(resolveActions(new Headers(), { data: { properties: { "웹훅 정보": { formula: { string: '{"wait":"session-delete, session-attendance-queue"}' } } } } }).ids, ["session-delete", "session-attendance-queue"])
  eq(resolveActions(new Headers(), { data: { properties: { "웹훅 정보": { formula: { string: '{"wait":[]}' } } } } }).ids, [])
  eq(resolveActions(new Headers(), {}).ids, [])
})

Deno.test("동작 ID: 이름이 '웹훅'으로 시작하는 칸(버튼 select·수식 쉼표·조건 수식·텍스트), 다른 칸은 무시", () => {
  // 버튼: select `웹훅 버튼` + 함께 보내는 칸(담기 계획)은 무시
  const btn = { data: { id: "p", properties: {
    "담기 계획": { type: "formula", formula: { type: "string", string: "cart-notice" } },
    "웹훅 버튼": { type: "select", select: { name: "cart-progress-book" } },
  } } }
  eq(resolveActions(new Headers(), btn), { ids: ["cart-progress-book"], unknown: [] })
  // 상태 자동화: 수식 `웹훅 정보` 쉼표 목록(교재비 원본 시험 모양)
  const auto = { data: { properties: { "실행자": { people: [] }, "웹훅 정보": { formula: { string: "cart-notice,cart-delete" } } } } }
  eq(resolveActions(new Headers(), auto).ids, ["cart-notice", "cart-delete"])
  // 빈 수식·빈 select는 동작 없음
  eq(resolveActions(new Headers(), { data: { properties: { "웹훅 정보": { formula: { string: "" } }, "웹훅 버튼": { select: null } } } }).ids, [])
  // 조건 수식 `웹훅 링크`, 텍스트 칸
  eq(resolveActions(new Headers(), { data: { properties: { "웹훅 링크": { formula: { string: "reg-link-disable" } } } } }).ids, ["reg-link-disable"])
  eq(resolveActions(new Headers(), { data: { properties: { "웹훅 메모": { rich_text: [{ plain_text: "school-calendar" }] } } } }).ids, ["school-calendar"])
  // 헤더와 칸이 같으면 한 번만, 칸의 모르는 ID는 unknown
  const both = resolveActions(new Headers({ "x-hada-action": "cart-notice" }), { data: { properties: { "웹훅 정보": { formula: { string: "cart-notice, oops" } } } } })
  eq(both, { ids: ["cart-notice"], unknown: ["oops"] })
  // "웹훅"으로 시작하지 않는 칸에 ID가 있어도 무시
  eq(resolveActions(new Headers(), { data: { properties: { "정보 웹훅": { formula: { string: "cart-notice" } } } } }).ids, [])
})

Deno.test("주소: 경로·쿼리 붙이기", () => {
  eq(targetUrl("https://x.supabase.co/", routeById("reg-link-regenerate")!), "https://x.supabase.co/functions/v1/toggle-report-link?action=regenerate")
  eq(targetUrl("https://x.supabase.co", routeById("cart-progress-book")!), "https://x.supabase.co/functions/v1/sync-textbook-distribution/from-cart/queue")
})

function deps(over: Partial<RouterDeps> & { calls?: any[]; queued?: any[]; failures?: any[]; status?: number | ((url: string) => number); enqueueThrows?: boolean } = {}): RouterDeps {
  const calls = over.calls ?? [], queued = over.queued ?? [], failures = over.failures ?? []
  return {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers, body: init.body })
      const st = typeof over.status === "function" ? over.status(url) : (over.status ?? 202)
      if (st === 0) throw new Error("network")
      return new Response("{}", { status: st })
    }) as unknown as typeof fetch,
    baseUrl: () => "https://x.supabase.co",
    currentKey: async () => "k",
    authorize: over.authorize ?? (async (_r, p, l) => p === l),
    log: () => {},
    enqueue: async (target, payload) => { if (over.enqueueThrows) throw new Error("db down"); queued.push({ target, payload }) },
    recordFailure: async (target, payload, message) => { failures.push({ target, payload, message }) },
  }
}
const req = (body: unknown, headers: Record<string, string> = {}, q = "") =>
  new Request("https://x.supabase.co/functions/v1/notion-router" + q, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": "k", ...headers }, body: JSON.stringify(body) })

Deno.test("키가 틀리면 401, 아무것도 넘기지 않음", async () => {
  const calls: any[] = []
  const res = await handleRouter(req({}, { "x-admin-key": "bad", "x-hada-action": "reg-report-sync" }), deps({ calls }))
  eq(res.status, 401); eq(calls.length, 0)
})

Deno.test("본문 adminKey도 키로 받음(버튼이 헤더를 못 보낼 때)", async () => {
  const calls: any[] = []
  const r = new Request("https://x.supabase.co/functions/v1/notion-router?a=reg-report-sync", { method: "POST", body: JSON.stringify({ adminKey: "k", data: { id: "p" } }) })
  const res = await handleRouter(r, deps({ calls }))
  eq(res.status, 202); eq(calls.length, 1)
  assert((calls[0].headers as Record<string, string>)["x-admin-key"] === "k")
})

Deno.test("수식 wait 두 개 → 두 함수로 본문 그대로 넘김", async () => {
  const calls: any[] = []
  const body = { source: { type: "automation" }, data: { id: "pg", properties: { "웹훅 정보": { formula: { string: '{"db":"SES","wait":["session-attendance-queue","session-delete"]}' } } } } }
  const res = await handleRouter(req(body), deps({ calls }))
  eq(res.status, 202)
  eq(calls.map((c) => c.url).sort(), ["https://x.supabase.co/functions/v1/cascade-delete", "https://x.supabase.co/functions/v1/fix-attendance/queue"])
  assert(calls.every((c) => c.body === JSON.stringify(body)), "body forwarded unchanged")
  const j = await res.json(); eq(j.pageId, "pg")
})

Deno.test("?a= 주소 꼬리와 헤더를 합침", async () => {
  const calls: any[] = []
  const res = await handleRouter(req({ data: { id: "p" } }, { "x-hada-action": "reg-link-disable" }, "?a=reg-report-sync"), deps({ calls }))
  eq(res.status, 202); eq(calls.length, 2)
})

Deno.test("동작이 없으면 200(Notion이 자동화를 멈추지 않게) + 실패 한 줄 기록, 아무것도 넘기지 않음", async () => {
  const calls: any[] = [], failures: any[] = []
  const body = { source: { type: "automation", automation_id: "a1" }, data: { id: "p", properties: { "학생": "비밀" } } }
  const res = await handleRouter(req(body, {}, "?a=no-such-action"), deps({ calls, failures }))
  eq(res.status, 200); eq(calls.length, 0)
  eq((await res.json()).ok, false)
  eq(failures.length, 1); eq(failures[0].target, ROUTER_MISS_TARGET)
  eq(failures[0].payload, { pageId: "p", automationId: "a1", unknown: ["no-such-action"] }, "본문은 남기지 않음")
  assert(failures[0].message.includes("no-such-action"))
})

Deno.test("모르는 ID가 섞이면 아는 것은 넘기고 모르는 것은 기록", async () => {
  const calls: any[] = [], failures: any[] = []
  const res = await handleRouter(req({ data: { id: "p" } }, { "x-hada-action": "reg-report-sync,nope" }), deps({ calls, failures }))
  eq(res.status, 202); eq(calls.length, 1); eq(failures.length, 1)
})

Deno.test("실패 기록이 안 돼도 200(기록 실패로 Notion을 멈추지 않음)", async () => {
  const d = deps(); d.recordFailure = async () => { throw new Error("db down") }
  eq((await handleRouter(req({ data: { id: "p" } }), d)).status, 200)
})

Deno.test("넘기기 실패(5xx·네트워크)면 그 동작만 다시 넘기기 큐에 넣고 202. 4xx는 함수가 판단한 것이라 그대로 202", async () => {
  for (const st of [500, 0]) {
    const queued: any[] = []
    const res = await handleRouter(req({ data: { id: "p" } }, { "x-hada-action": "reg-report-sync" }), deps({ status: st, queued }))
    eq(res.status, 202); eq(queued.length, 1)
    eq(queued[0].target, ROUTER_RETRY_TARGET); eq(queued[0].payload.id, "reg-report-sync"); eq(queued[0].payload.pageId, "p")
    eq(queued[0].payload.body, JSON.stringify({ data: { id: "p" } }), "본문 그대로")
    assert(!("key" in queued[0].payload) && !JSON.stringify(queued[0].payload).includes('"k"'), "키는 저장하지 않음")
    eq((await res.json()).ok, false)
  }
  const q400: any[] = []
  eq((await handleRouter(req({}, { "x-hada-action": "reg-report-sync" }), deps({ status: 400, queued: q400 }))).status, 202)
  eq(q400.length, 0)
  const queued: any[] = []
  const mixed = await handleRouter(req({}, { "x-hada-action": "reg-report-sync,reg-link-regenerate" }), deps({ queued, status: (u) => u.includes("toggle") ? 503 : 202 }))
  eq(mixed.status, 202); eq(queued.map((x) => x.payload.id), ["reg-link-regenerate"])
})

Deno.test("다시 넘기기 큐에도 못 넣으면 502(최후의 수단)", async () => {
  eq((await handleRouter(req({}, { "x-hada-action": "reg-report-sync" }), deps({ status: 500, enqueueThrows: true }))).status, 502)
})

Deno.test("워커 다시 넘기기: 지금 서버 키로 본문 그대로, 실패면 throw(큐가 재시도)", async () => {
  const calls: any[] = []
  const mk = (st: number) => ({
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); if (st === 0) throw new Error("net"); return new Response("{}", { status: st }) }) as any,
    baseUrl: () => "https://x.supabase.co",
    key: async () => "server-key",
  })
  await processRouterRetryItem({ id: "reg-textbook-queue", pageId: "p", body: '{"data":{"id":"p"}}' }, undefined, mk(202))
  eq(calls[0].url, "https://x.supabase.co/functions/v1/sync-registration-textbook/queue")
  eq(calls[0].init.body, '{"data":{"id":"p"}}')
  eq((calls[0].init.headers as Record<string, string>)["x-admin-key"], "server-key")
  await processRouterRetryItem({ id: "reg-textbook-queue", body: "{}" }, undefined, mk(409)) // 4xx는 함수 판단 → 끝
  for (const st of [500, 0]) {
    let threw = false
    try { await processRouterRetryItem({ id: "reg-textbook-queue", body: "{}" }, undefined, mk(st)) } catch { threw = true }
    assert(threw, `retry should throw on ${st}`)
  }
  let threw = false
  try { await processRouterRetryItem({ id: "nope", body: "{}" }, undefined, mk(202)) } catch { threw = true }
  assert(threw, "unknown id throws")
})

Deno.test("GET은 405", async () => {
  eq((await handleRouter(new Request("https://x/functions/v1/notion-router"), deps())).status, 405)
})
