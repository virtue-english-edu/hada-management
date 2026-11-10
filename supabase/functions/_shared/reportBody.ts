// _shared/reportBody.ts
//
// (v2.8.0) 학부모 리포트의 주간·월간·수료 보고서 본문. 가정통신문(reportLetter.ts)과 같은 방식으로, 캐시에는 보고서 id만 있고
// 본문은 화면이 그 보고서를 볼 때 읽는다(get-report-body). 그래서 본문을 고쳐도 동기화 없이 바로 보이고, 사진 주소가 만료되지 않는다.
// 반 공통 본문 = 보고서가 연결된 반 알림톡 발송함 페이지 본문, 학생 개인 본문 = 그 학생 보고서 페이지 본문.
// 일간 보고서는 그날 출석 페이지 본문(학생 개인)만 있다.
// (11/10 대표) 본문은 보낸 보고서만 보인다. 보냈는지는 여기서 그 자리에서 확인한다 — 발송은 리포트 캐시를 먼저 새로 만들고
// 그 뒤에 ✅ 완료를 쓰므로(noticeQueue.ts), 캐시에 보냄 여부를 실으면 막 보낸 보고서가 '안 보냄'으로 남는다.
import { readPageBodyBlocks } from "./feedBody.ts"
import { getPage, pickProp, relIds } from "./notionClient.ts"
import { publicBody } from "./reportLetter.ts"

const PROP_REG = "등록"
const PROP_MAILBOX = "알림톡 발송함"
const PROP_STATUS = "보고서 전송 상태" // 보고서·출석(일일 보고서) 모두 같은 이름
const SENT = "✅ 완료"

export const reportBodyDeps = {
	getPage,
	body: readPageBodyBlocks,
}

const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()

export type ReportBodyView = { classBody: unknown[]; studentBody: unknown[] }

// 이 등록의 보낸 보고서 본문. 남의 등록·안 보냄·휴지통이면 null(화면은 칸을 숨긴다).
export async function buildReportBodyView(reportId: string, regId: string): Promise<ReportBodyView | null> {
	const deps = reportBodyDeps
	const report: any = await deps.getPage(reportId)
	if (!report || report.in_trash || report.archived) return null
	const props = report.properties ?? {}
	if (!relIds(pickProp(props, PROP_REG)).some((id: string) => key(id) === key(regId))) return null
	if (pickProp(props, PROP_STATUS)?.select?.name !== SENT) return null
	const boxId = relIds(props[PROP_MAILBOX])[0]
	const [classBody, studentBody] = await Promise.all([
		boxId ? deps.body(boxId) : Promise.resolve([]),
		deps.body(String(report.id ?? reportId)),
	])
	return { classBody: publicBody(classBody), studentBody: publicBody(studentBody) }
}

// 이 등록의 일일 보고서를 보낸 출석 페이지 본문. 조건은 보고서와 같다(남의 등록·안 보냄·휴지통이면 null).
export async function buildAttendanceBodyView(attendanceId: string, regId: string): Promise<ReportBodyView | null> {
	const deps = reportBodyDeps
	const page: any = await deps.getPage(attendanceId)
	if (!page || page.in_trash || page.archived) return null
	const props = page.properties ?? {}
	if (!relIds(pickProp(props, PROP_REG)).some((id: string) => key(id) === key(regId))) return null
	if (pickProp(props, PROP_STATUS)?.select?.name !== SENT) return null
	return { classBody: [], studentBody: publicBody(await deps.body(String(page.id ?? attendanceId))) }
}
