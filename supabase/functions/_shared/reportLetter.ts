// _shared/reportLetter.ts
//
// (v2.8.0) 학부모 리포트 홈 탭의 가정통신문. 보낸 달 목록만 캐시(student_fields.letters)에 싣고, 본문은 누를 때 읽는다
// (get-report-letter). 그래서 본문·사진을 고쳐도 동기화 없이 바로 보이고, 사진 주소가 만료되지 않는다.
// (11/6 사용자) 반마다 따로 보인다: 영어반을 열면 영어반 내용만. 같은 내용을 여러 반에 적어도 합치지 않는다.
// 내용: 일정(알림톡과 같은 계산, 이 반 기준) + 전달사항 + 반 본문(반 발송함 페이지 본문) + 학생별 본문(가정통신문 페이지 본문).
import { readPageBodyBlocks } from "./feedBody.ts"
import { getPage, queryAllPages, relIds } from "./notionClient.ts"
import { seoulDay } from "./classReportPlan.ts"
import { resolveLetterDataSourceId, studentMonthEvents } from "./monthlyNotice.ts"
import { dotDate, monthLabel, type Section } from "./scheduleNotice.ts"

const PROP_PERIOD = "기간"
const PROP_REG = "등록"
const PROP_MAILBOX = "알림톡 발송함"
const PROP_STATUS = "안내문 전송 상태"
const PROP_BOX_NOTE = "가정통신문 전달사항"
const SENT = "✅ 완료"
const LIST_LIMIT = 24

export const reportLetterDeps = {
	queryAllPages,
	getPage,
	dataSourceId: () => resolveLetterDataSourceId(),
	events: (studentId: string, month: string, regs: any[]) => studentMonthEvents(studentId, month, regs),
	body: readPageBodyBlocks,
}

const alive = (p: any) => !!p && !p.in_trash && !p.archived
const monthOf = (letter: any) => String(seoulDay(letter?.properties?.[PROP_PERIOD]?.date?.start) ?? "").slice(0, 7)

async function sentLettersOfReg(ds: string, regId: string): Promise<any[]> {
	const pages = await reportLetterDeps.queryAllPages(ds, {
		and: [
			{ property: PROP_REG, relation: { contains: regId } },
			{ property: PROP_STATUS, select: { equals: SENT } },
		],
	})
	return pages.filter(alive)
}

// 캐시에 싣는 목록: 등록마다 보낸 달, 최근 달부터. 실패해도 리포트 동기화는 계속한다.
export async function buildLetterList(regIds: string[]): Promise<{ month: string; registrationId: string }[]> {
	if (!regIds.length) return []
	try {
		const ds = await reportLetterDeps.dataSourceId()
		const perReg = await Promise.all(regIds.map(async (registrationId) => {
			const months = new Set((await sentLettersOfReg(ds, registrationId)).map(monthOf).filter(Boolean))
			return Array.from(months).sort().reverse().slice(0, LIST_LIMIT).map((month) => ({ month, registrationId }))
		}))
		return perReg.flat()
	} catch (err) {
		console.warn("[report-letter] 가정통신문 목록 건너뜀:", (err as Error)?.message ?? err)
		return []
	}
}

// 화면에 보내는 본문에는 blockId를 빼고 새로 받은 주소만 남긴다. 파일은 그 주소로 바로 열린다.
// (보고서 본문 reportBody.ts도 같이 쓴다.)
export function publicBody(blocks: unknown[]): unknown[] {
	return blocks.map((b: any) => {
		if (!b || typeof b !== "object") return b
		const { blockId: _blockId, ...rest } = b
		return Array.isArray(rest.children) ? { ...rest, children: publicBody(rest.children) } : rest
	})
}

// 알림톡 일정 한 줄("11/7(토) 내용")을 화면 한 줄("11.07(토)  내용")로.
function eventText(line: string): string {
	const cut = line.indexOf(" ")
	return cut < 0 ? dotDate(line) : `${dotDate(line.slice(0, cut))}  ${line.slice(cut + 1).trim()}`
}

export type LetterView = {
	month: string
	label: string
	schedule: { rest: string[]; academy: string[]; school: string[] }
	note: string
	classBody: unknown[]
	studentBody: unknown[]
}

// 이 등록(반)의 이 달 가정통신문. 보낸 장이 없으면 null.
export async function buildLetterView(regId: string, studentId: string, month: string): Promise<LetterView | null> {
	const deps = reportLetterDeps
	const letter = (await sentLettersOfReg(await deps.dataSourceId(), regId)).find((l) => monthOf(l) === month)
	if (!letter) return null
	const boxId = relIds(letter?.properties?.[PROP_MAILBOX])[0]
	const [reg, box, classBody, studentBody] = await Promise.all([
		deps.getPage(regId),
		boxId ? deps.getPage(boxId).catch(() => null) : Promise.resolve(null),
		boxId ? deps.body(boxId) : Promise.resolve([]),
		deps.body(String(letter.id)),
	])
	const lines = await deps.events(studentId, month, [reg])
	const ofSection = (sec: Section) => lines.filter((l) => l.sec === sec).sort((a, b) => a.day.localeCompare(b.day)).map((l) => eventText(l.line))
	return {
		month,
		label: monthLabel(month),
		schedule: { rest: ofSection("휴원"), academy: ofSection("학원"), school: ofSection("학교") },
		// 전달 사항은 발송함에 적은 글 그대로 보인다(알림톡 글자 수 제한이 없다).
		note: ((box as any)?.properties?.[PROP_BOX_NOTE]?.rich_text ?? []).map((t: any) => t?.plain_text ?? "").join("").trim(),
		classBody: publicBody(classBody),
		studentBody: publicBody(studentBody),
	}
}
