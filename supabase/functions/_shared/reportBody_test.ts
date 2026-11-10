// (v2.8.0) 학부모 리포트 보고서 본문: 반 공통(발송함) + 학생 개인(보고서), 보낸 것만.
import { buildAttendanceBodyView, buildReportBodyView, reportBodyDeps } from "./reportBody.ts"

function eq(a: unknown, b: unknown) {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`다름\n 실제: ${JSON.stringify(a)}\n 기대: ${JSON.stringify(b)}`)
}
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const report = (id: string, reg: string, status: string, box?: string, extra: Record<string, unknown> = {}) => ({
	id,
	...extra,
	properties: { "등록": rel(reg), "알림톡 발송함": rel(...(box ? [box] : [])), "보고서 전송 상태": { select: { name: status } } },
})

function mock(pages: Record<string, any>, bodies: Record<string, unknown[]> = {}) {
	const read: string[] = []
	Object.assign(reportBodyDeps, {
		getPage: (id: string) => Promise.resolve(pages[id]),
		body: (id: string) => {
			read.push(id)
			return Promise.resolve(bodies[id] ?? [])
		},
	})
	return read
}

Deno.test("v2.8.0 보고서 본문: 보낸 보고서는 발송함 본문(반)과 보고서 본문(개인)을 따로, 파일 blockId는 뺀다", async () => {
	mock({ rp1: report("rp1", "reg-1", "✅ 완료", "box1") }, {
		box1: [{ type: "paragraph", text: "이번 주 반 전체 진도" }, { type: "pdf", blockId: "blk", url: "https://f/a.pdf", name: "a.pdf" }],
		rp1: [{ type: "paragraph", text: "서아는 분수를 잘했어요" }],
	})
	eq(await buildReportBodyView("rp1", "reg1"), {
		classBody: [{ type: "paragraph", text: "이번 주 반 전체 진도" }, { type: "pdf", url: "https://f/a.pdf", name: "a.pdf" }],
		studentBody: [{ type: "paragraph", text: "서아는 분수를 잘했어요" }],
	})
})

Deno.test("v2.8.0 보고서 본문: 안 보냄·대기·오류·남의 등록·휴지통은 열지 않는다", async () => {
	for (const status of ["⚪ 대기", "⚠️ 오류", ""]) {
		const read = mock({ rp: report("rp", "reg1", status, "box1") }, { box1: [{ type: "paragraph", text: "x" }] })
		eq(await buildReportBodyView("rp", "reg1"), null)
		eq(read.length, 0)
	}
	mock({ rp: report("rp", "reg2", "✅ 완료", "box1") })
	eq(await buildReportBodyView("rp", "reg1"), null)
	mock({ rp: report("rp", "reg1", "✅ 완료", "box1", { in_trash: true }) })
	eq(await buildReportBodyView("rp", "reg1"), null)
})

Deno.test("v2.8.0 보고서 본문: 발송함이 없으면 반 본문은 비고, 옛 이름 '전송 상태'도 읽는다", async () => {
	const old = { id: "rp", properties: { "등록": rel("reg1"), "알림톡 발송함": rel(), "전송 상태": { select: { name: "✅ 완료" } } } }
	const read = mock({ rp: old }, { rp: [{ type: "paragraph", text: "개인" }] })
	eq(await buildReportBodyView("rp", "reg1"), { classBody: [], studentBody: [{ type: "paragraph", text: "개인" }] })
	eq(read, ["rp"])
})

Deno.test("v2.8.0 일간 보고서 본문: 일일 보고서를 보낸 출석 페이지 본문만(반 공통 칸 없음), 안 보냄·남의 등록은 열지 않는다", async () => {
	const att = (id: string, reg: string, status: string) => ({ id, properties: { "등록": rel(reg), "보고서 전송 상태": { select: { name: status } } } })
	const read = mock({ a1: att("a1", "reg1", "✅ 완료"), a2: att("a2", "reg1", "⚪ 대기"), a3: att("a3", "reg2", "✅ 완료") }, {
		a1: [{ type: "paragraph", text: "12번은 집에서 한 번 더" }, { type: "image", blockId: "img", url: "https://f/p.png" }],
	})
	eq(await buildAttendanceBodyView("a1", "reg1"), { classBody: [], studentBody: [{ type: "paragraph", text: "12번은 집에서 한 번 더" }, { type: "image", url: "https://f/p.png" }] })
	eq(await buildAttendanceBodyView("a2", "reg1"), null)
	eq(await buildAttendanceBodyView("a3", "reg1"), null)
	eq(read, ["a1"])
})
