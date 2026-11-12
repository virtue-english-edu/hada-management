// _shared/webhookRouter.ts
//
// (v2.8.0, 261111) 웹훅 길잡이 본체. 학원의 모든 Notion 버튼·자동화가 같은 주소(notion-router)·같은 키로 보내면,
// 동작을 알아내(webhookRoutes.ts) 기존 함수 주소로 본문을 그대로 넘긴다.
//
// 원칙(설계: 길잡이 = 디스펜서)
// - Notion을 부르지 않는다. 받은 본문을 손대지 않고 넘긴다(기존 함수가 지금처럼 pageId·수식 속성을 읽는다).
// - 기존 함수의 잠금·상태·큐는 그대로다(이미 처리 중이면 그 함수가 already_processing으로 건너뜀).
// - 기존 함수별 주소는 계속 살아 있다. 길잡이를 끄면 자동화 주소만 예전 주소로 되돌리면 된다.
//
// (261112 원본 실시험) Notion은 웹훅이 400·401·5xx를 받으면 그 자동화를 통째로 "일시 중지"한다(받은편지함 알림에
// 이유·상태 코드 없음, 그 DB의 다른 행도 더는 안 감). 그래서 Notion에는 될 수 있는 한 2xx로 답하고, 실패는 서버가
// 스스로 처리한다.
// - 동작 ID를 못 찾음("웹훅…" 칸·헤더·?a= 모두 없음/모르는 ID): 200으로 답하고 sync_queue에 실패 한 줄
//   (target "notion-router")을 남긴다 → sync-failure-audit가 30분마다 자동화 로그 DB에 보고. 다시 해도 같은
//   결과라 재시도는 하지 않는다.
// - 넘기기 실패(네트워크·5xx·25초 초과): 그 동작만 sync_queue에 "다시 넘기기"(target "notion-router-retry")로
//   넣고 202로 답한다. process-sync-queue 워커가 다시 넘기고(최대 3번), 끝내 안 되면 failed → 같은 보고.
//   큐에도 못 넣을 때만 502(이때는 Notion이 멈출 수 있다).
// - 키가 틀리면 지금처럼 401(아무 기록도 남기지 않는다. 키 없는 요청으로 표를 채울 수 없게).
// - 25초를 넘겨 끊긴 경우 기존 함수가 실제로는 처리했을 수 있다. 다시 넘기기는 기존 함수의 잠금·상태 확인에 기댄다
//   (Notion이 502를 다시 보내던 예전 방식과 같은 위험, 기존 함수는 대부분 큐에 넣고 바로 답해 25초에 닿지 않는다).

import { authorizeKey, securityEnabled } from "./adminSecurity.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "./adminShared.ts"
import { enqueueSync, recordSyncFailure, wakeSyncQueueWorker } from "./syncQueue.ts"
import { resolveActions, routeById, targetUrl, ACTION_HEADER } from "./webhookRoutes.ts"

export const ROUTER_MISS_TARGET = "notion-router"
export const ROUTER_RETRY_TARGET = "notion-router-retry"
const FORWARD_TIMEOUT_MS = 25000

export type RouterDeps = {
  fetch: typeof fetch
  baseUrl: () => string
  currentKey: () => Promise<string>
  authorize: (req: Request, provided: string, legacy: string) => Promise<boolean>
  log: (msg: string, data?: unknown) => void
  enqueue: (target: string, payload: Record<string, unknown>) => Promise<void>
  recordFailure: (target: string, payload: Record<string, unknown>, message: string) => Promise<void>
}

export const defaultRouterDeps: RouterDeps = {
  fetch: (...a) => fetch(...a),
  baseUrl: () => Deno.env.get("SB_URL") ?? "",
  currentKey: () => (securityEnabled() ? Promise.resolve("") : getCurrentAdminKey()),
  authorize: authorizeKey,
  log: (msg, data) => console.log(`[notion-router] ${msg}`, data === undefined ? "" : JSON.stringify(data).slice(0, 2000)),
  enqueue: async (target, payload) => { await enqueueSync(target, payload); wakeSyncQueueWorker() },
  recordFailure: recordSyncFailure,
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// 실패로 볼 응답: 네트워크·시간 초과(0)와 5xx. 4xx는 기존 함수가 판단한 결과라 그대로 둔다(다시 해도 같음).
const isForwardFailure = (status: number) => status === 0 || status >= 500

async function forward(deps: Pick<RouterDeps, "fetch">, url: string, key: string, raw: string): Promise<{ status: number; error?: string }> {
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": key },
      body: raw || "{}",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    return { status: res.status }
  } catch (err) {
    return { status: 0, error: (err as Error).message }
  }
}

export async function handleRouter(req: Request, deps: RouterDeps = defaultRouterDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST 요청만 받습니다." }, 405)
  const raw = await req.text()
  let body: any = {}
  try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }

  const provided = resolveAdminKeyFromRequest(req, body) ?? ""
  if (!provided || !await deps.authorize(req, provided, await deps.currentKey())) {
    return json({ error: "unauthorized" }, 401)
  }

  // 버튼은 헤더를 못 보낼 때가 있어 주소 끝 ?a=동작ID 도 받는다.
  const headers = new Headers(req.headers)
  const q = new URL(req.url).searchParams.get("a")
  if (q) headers.set(ACTION_HEADER, [headers.get(ACTION_HEADER), q].filter(Boolean).join(","))
  const { ids, unknown } = resolveActions(headers, body)
  const pageId = body?.data?.id ?? null
  const automationId = body?.source?.automation_id ?? null
  if (unknown.length || !ids.length) {
    // 본문(학생 정보가 들어 있을 수 있음)은 남기지 않는다. 어느 자동화·페이지에서 왔는지만.
    const message = ids.length
      ? `모르는 동작 ID ${unknown.join(", ")} (나머지는 넘김) — 버튼의 "웹훅 버튼" 단계·보낼 속성, 자동화의 "웹훅 정보" 수식을 확인하세요`
      : `동작을 찾지 못했습니다${unknown.length ? `(모르는 ID ${unknown.join(", ")})` : ""} — 버튼은 웹훅 앞에 "웹훅 버튼 = 항목 ID" 단계와 보낼 속성 "웹훅 버튼", 자동화는 보낼 속성에 "웹훅 정보"(등) 수식이 있는지 확인하세요`
    deps.log(ids.length ? "모르는 동작(무시)" : "동작 없음", { unknown, pageId, automationId })
    await deps.recordFailure(ROUTER_MISS_TARGET, { pageId, automationId, unknown }, message)
      .catch((err) => deps.log("실패 기록 못 남김", { error: (err as Error).message }))
  }
  if (!ids.length) {
    // 200: 4xx로 답하면 Notion이 이 자동화를 멈춘다. 무엇이 잘못됐는지는 자동화 로그 DB에 남는다.
    return json({ ok: false, error: "동작을 찾지 못했습니다(웹훅 버튼·웹훅 정보 칸 또는 x-hada-action 헤더)", unknown }, 200)
  }

  const base = deps.baseUrl()
  if (!base) return json({ ok: false, error: "SB_URL이 설정되지 않았습니다." }, 503)
  const results: { id: string; fn: string; status: number; error?: string; retry?: boolean }[] = await Promise.all(ids.map(async (id) => {
    const route = routeById(id)!
    return { id, fn: route.fn + route.path, ...(await forward(deps, targetUrl(base, route), provided, raw)) }
  }))

  let enqueueFailed = false
  for (const r of results.filter((x) => isForwardFailure(x.status))) {
    try {
      await deps.enqueue(ROUTER_RETRY_TARGET, { id: r.id, pageId, body: raw || "{}", firstError: r.error ?? `HTTP ${r.status}` })
      r.retry = true
    } catch (err) {
      enqueueFailed = true
      deps.log("다시 넘기기 큐 적재 실패", { id: r.id, pageId, error: (err as Error).message })
    }
  }
  deps.log("넘김", { pageId, results, unknown })
  // 큐에도 못 넣었을 때만 502(Notion이 다시 보내게). 그 밖에는 202.
  return json({ ok: !results.some((r) => isForwardFailure(r.status)), pageId, results, unknown }, enqueueFailed ? 502 : 202)
}

// process-sync-queue 워커: 길잡이가 넘기지 못한 동작 하나를 다시 넘긴다. 실패(0·5xx)면 throw → 워커가 최대 3번 재시도,
// 끝내 안 되면 failed → sync-failure-audit 보고. 키는 저장하지 않고 지금 서버 키(보안 모드면 내부 키)를 쓴다.
export type RouterRetryPayload = { id: string; pageId?: string | null; body: string }
export const routerRetryDeps = {
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
  baseUrl: () => Deno.env.get("SB_URL") ?? "",
  key: () => getCurrentAdminKey(),
}

export async function processRouterRetryItem(payload: RouterRetryPayload, _cachedGetPage?: unknown, deps = routerRetryDeps): Promise<void> {
  const route = routeById(payload?.id)
  if (!route) throw new Error(`notion-router-retry: 모르는 동작 ${payload?.id}`)
  const base = deps.baseUrl()
  if (!base) throw new Error("SB_URL이 설정되지 않았습니다.")
  const r = await forward({ fetch: deps.fetch as typeof fetch }, targetUrl(base, route), await deps.key(), payload.body ?? "{}")
  if (isForwardFailure(r.status)) throw new Error(`notion-router-retry ${payload.id} → ${route.fn}${route.path} 실패: ${r.error ?? `HTTP ${r.status}`}`)
  console.log(`[notion-router-retry] ${payload.id} page=${payload.pageId ?? "-"} → HTTP ${r.status}`)
}
