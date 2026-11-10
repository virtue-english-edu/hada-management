// POST /functions/v1/get-report-body
// body: { token: string, reportId: string } 또는 { token: string, attendanceId: string }
//
// (v2.8.0) 학부모 리포트의 선생님 한마디 카드를 펼치면 보이는 본문을 읽는다.
//  - reportId: 주간·월간·수료 보고서(반 공통 = 발송함, 학생 개인 = 보고서 페이지). 토큰의 캐시 report_comments에 있는 것만.
//  - attendanceId: 일간 보고서(그날 출석 페이지 본문). 토큰의 캐시 attendance_rows에 있는 것만.
// 그중 보낸(보고서 전송 상태 ✅ 완료) 것만 연다.
import { buildAttendanceBodyView, buildReportBodyView } from "../_shared/reportBody.ts"
import { CORS_HEADERS, selectReportCacheByToken } from "../_shared/reportCacheShared.ts"

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

const key = (id: unknown) => String(id ?? "").replace(/-/g, "").toLowerCase()

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  try {
    const { token, reportId, attendanceId } = await req.json().catch(() => ({}))
    const id = String(reportId ?? attendanceId ?? "")
    if (!token || !id || (reportId && attendanceId) || !/^[0-9a-f-]{32,36}$/i.test(id)) return json({ error: "token과 reportId 또는 attendanceId가 필요합니다." }, 400)

    const row = await selectReportCacheByToken(String(token))
    if (!row) return json({ error: "유효하지 않은 토큰입니다." }, 404)
    const detail = (row.registration_detail as any) ?? {}
    const listed = (reportId ? detail.report_comments ?? [] : detail.attendance_rows ?? []).some((c: any) => key(c?.id) === key(id))
    if (!listed) return json({ error: reportId ? "이 보고서가 없습니다." : "이 출석이 없습니다." }, 404)

    const view = reportId ? await buildReportBodyView(id, row.registration_id) : await buildAttendanceBodyView(id, row.registration_id)
    // 안 보낸 보고서는 오류가 아니라 빈 본문(화면은 칸을 숨긴다).
    return json({ body: view ?? { classBody: [], studentBody: [] } })
  } catch (err) {
    console.error("get-report-body failed", err)
    return json({ error: "보고서 본문을 불러오지 못했습니다." }, 500)
  }
})
