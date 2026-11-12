import { assert, assertEquals } from "jsr:@std/assert@1"
import { assertThrows } from "jsr:@std/assert@1"
import { buildPlan, canStart, CLEAR_DBS, ClearError, countPlan, GROUPS, iconOf, KEEP_DBS, selectionKeep, STALE_MS } from "./exampleClear.ts"

// scripts/clear-example-data.py의 목록과 같아야 한다(PC 스크립트와 화면이 같은 DB를 지운다).
function pyList(src: string, name: string): string[] {
  const block = src.split(`${name} = [`)[1].split("\n]")[0]
  return [...block.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1])
}

Deno.test("지울·남길 DB 목록이 PC 스크립트와 같다", async () => {
  const src = await Deno.readTextFile(new URL("../../../scripts/clear-example-data.py", import.meta.url))
  assertEquals(CLEAR_DBS, pyList(src, "CLEAR_DBS"))
  assertEquals(KEEP_DBS, pyList(src, "KEEP_DBS"))
})

Deno.test("남기는 DB는 알림톡 설정·과목과 시스템용 메뉴·웹페이지·학년, 비어 있는 문의·요청뿐", () => {
  assertEquals([...KEEP_DBS].sort(), ["과목(학원) DB", "메뉴(학원) DB", "문의·요청(학원) DB", "알림톡 설정(학원) DB", "웹페이지(학원) DB", "학년(학원) DB"].sort())
  for (const n of KEEP_DBS) assert(!CLEAR_DBS.includes(n))
})

Deno.test("계획은 지울 순서대로, 남길 DB·모르는 DB는 넣지 않는다", () => {
  const sources = new Map([
    ["학생(학원) DB", ["s"]], ["출석(학원) DB", ["a"]], ["과목(학원) DB", ["k"]], ["🔑 키 발급 매뉴얼", ["x"]],
  ])
  const { plan, missing, unknown } = buildPlan(sources)
  assertEquals(plan, [{ name: "출석(학원) DB", ds: "a" }, { name: "학생(학원) DB", ds: "s" }])
  assertEquals(unknown, ["🔑 키 발급 매뉴얼"])
  assert(missing.includes("수업(학원) DB"))
  assert(!missing.includes("패치·이슈 관리 DB")) // 옛 이름은 없어도 된다
})

Deno.test("keep에 적은 DB는 이번 계획에서 뺀다(원본 리허설)", () => {
  const sources = new Map([["출석(학원) DB", ["a"]], ["업데이트(학원) DB", ["u"]]])
  assertEquals(buildPlan(sources).plan.map((p) => p.name), ["출석(학원) DB", "업데이트(학원) DB"])
  const { plan, missing } = buildPlan(sources, ["업데이트(학원) DB"])
  assertEquals(plan.map((p) => p.name), ["출석(학원) DB"])
  assert(!missing.includes("업데이트(학원) DB"))
})

Deno.test("시작은 처음·오류·오래 멈춘 진행에서만", () => {
  const now = Date.parse("2026-11-02T12:00:00Z")
  assert(canStart(null, null, now))
  assert(canStart({ state: "error" }, "2026-11-02T11:59:00Z", now))
  assert(canStart({ state: "stopped" }, "2026-11-02T11:59:00Z", now))
  assert(!canStart({ state: "done" }, "2026-11-02T11:00:00Z", now))
  assert(!canStart({ state: "locked" }, "2026-11-02T11:00:00Z", now))
  assert(!canStart({ state: "running" }, new Date(now - 60_000).toISOString(), now))
  assert(canStart({ state: "running" }, new Date(now - STALE_MS - 1).toISOString(), now))
})

Deno.test("화면에서 고른 DB만 비우고 나머지 비울 DB는 남긴다", () => {
  const keep = selectionKeep(["출석(학원) DB", "학생(학원) DB"])
  assert(!keep.includes("출석(학원) DB") && !keep.includes("학생(학원) DB"))
  assert(keep.includes("라이브러리(학원) DB"))
  assertEquals(keep.length, CLEAR_DBS.length - 2)
  assertThrows(() => selectionKeep([]), ClearError)
  assertThrows(() => selectionKeep(["알림톡 설정(학원) DB"]), ClearError) // 남기는 DB는 고를 수 없다
  assertThrows(() => selectionKeep("출석(학원) DB"), ClearError)
})

Deno.test("비울 DB는 모두 화면 묶음 하나에만 들어 있다", () => {
  const all = GROUPS.flatMap((g) => g.dbs)
  assertEquals([...all].sort(), [...CLEAR_DBS].sort())
  assertEquals(new Set(all).size, all.length)
})

Deno.test("DB 아이콘: Notion 기본 아이콘·이모지만 쓰고 올린 그림은 뺀다", () => {
  assertEquals(iconOf({ type: "external", external: { url: "/icons/push-pin_gray.svg" } }), { url: "https://www.notion.so/icons/push-pin_gray.svg" })
  assertEquals(iconOf({ type: "external", external: { url: "https://www.notion.so/icons/user_gray.svg" } }), { url: "https://www.notion.so/icons/user_gray.svg" })
  assertEquals(iconOf({ type: "icon", icon: { name: "school", color: "gray" } }), { url: "https://www.notion.so/icons/school_gray.svg" })
  assertEquals(iconOf({ type: "emoji", emoji: "📌" }), { emoji: "📌" })
  assertEquals(iconOf({ type: "file", file: { url: "https://prod-files-secure.s3.amazonaws.com/x.png" } }), null)
  assertEquals(iconOf({ type: "external", external: { url: "https://evil.example/x.svg" } }), null)
  assertEquals(iconOf(null), null)
})

// (11/9) 큰 학원(1만 5천 건)에서 건수 세기가 함수 시간 한도를 넘기지 않게: 상한·동시 실행·시간 예산
Deno.test("건수는 소스마다 상한까지만 세고 넘으면 capped", async () => {
  const sizes: Record<string, number> = { a1: 3, a2: 5, b1: 12 }
  const read = async (ds: string, limit: number) => Array.from({ length: Math.min(sizes[ds], limit) }, (_, i) => `${ds}-${i}`)
  const plan = [{ name: "A", ds: "a1" }, { name: "A", ds: "a2" }, { name: "B", ds: "b1" }]
  const c = await countPlan(plan, read, { cap: 10 })
  assertEquals(c.get("A"), { count: 8, capped: false })
  assertEquals(c.get("B"), { count: 10, capped: true })
})

Deno.test("건수는 동시에 정해진 수만큼만 읽는다", async () => {
  let running = 0, peak = 0
  const read = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return ["x"] }
  const plan = Array.from({ length: 9 }, (_, i) => ({ name: `D${i}`, ds: `d${i}` }))
  const c = await countPlan(plan, read, { parallel: 3 })
  assertEquals(peak, 3)
  assertEquals([...c.values()].every((v) => v.count === 1 && !v.capped), true)
})

Deno.test("시간 예산이 지나면 남은 소스는 세지 않고 capped", async () => {
  const read = async () => { await new Promise((r) => setTimeout(r, 30)); return ["x"] }
  const plan = Array.from({ length: 6 }, (_, i) => ({ name: `D${i}`, ds: `d${i}` }))
  const c = await countPlan(plan, read, { parallel: 1, budgetMs: 40 })
  const vals = [...c.values()]
  assert(vals.some((v) => v.capped && v.count === 0))
  assert(vals.some((v) => v.count === 1))
})
