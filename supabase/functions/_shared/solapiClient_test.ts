// All network calls are mocked. No live Solapi calls or secret values are used.
const assertEquals = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const assertMatch = (s: string, re: RegExp) => { if (!re.test(s)) throw new Error(`${s} !~ ${re}`) }
async function assertRejects<E extends Error>(fn: () => Promise<unknown>, cls: new (...a: any[]) => E, msg?: string): Promise<E> {
	try { await fn() } catch (e) {
		if (!(e instanceof cls)) throw new Error(`wrong error type: ${e}`)
		if (msg && !(e as Error).message.includes(msg)) throw new Error(`message ${(e as Error).message} lacks ${msg}`)
		return e as E
	}
	throw new Error("expected rejection")
}
import { createSolapiService, solapiDeps, SolapiNotReceivedError } from "./solapiClient.ts"
import { clearTemplateFitCache, emphasisTitleForTemplate, templateEmphasisTitle } from "./templateFit.ts"

const templates: Record<string, unknown> = {
	EMPH: { emphasizeType: "TEXT", emphasizeTitle: "수강 등록 안내", content: "#{학생이름}" },
	VAR: { emphasizeType: "TEXT", emphasizeTitle: "#{학생이름} 보고서", content: "#{학생이름}" },
	PLAIN: { emphasizeType: "NONE", emphasizeTitle: null, content: "#{학생이름}" },
}

function stub(response: { status?: number; body: unknown }) {
	const calls: { url: string; headers: Record<string, string>; body: any }[] = []
	solapiDeps.loadSdk = async () => ({ getKakaoAlimtalkTemplate: async (id: string) => templates[id] })
	solapiDeps.now = () => "2026-11-10T05:00:00.000Z"
	solapiDeps.salt = () => "abcdef0123456789"
	solapiDeps.fetch = async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
		return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
	}
	clearTemplateFitCache()
	return calls
}

const ok = { groupInfo: { count: { total: 1, registeredFailed: 0 } }, failedMessageList: [] }
const msg = (templateId: string) => ({ to: "01000000000", from: "0200000000", kakaoOptions: { pfId: "PF", templateId, variables: { "#{학생이름}": "예시학생" }, disableSms: true } })

Deno.test("강조표기형 템플릿은 강조 제목을 title로 채워 보낸다", async () => {
	const calls = stub({ body: ok })
	const service = await createSolapiService("KEY", "SECRET")
	await service.send(msg("EMPH"), { allowDuplicates: true })
	assertEquals(calls.length, 1)
	assertEquals(calls[0].url, "https://api.solapi.com/messages/v4/send-many/fast")
	assertEquals(calls[0].body.messages[0].kakaoOptions.title, "수강 등록 안내")
	assertEquals(calls[0].body.allowDuplicates, true)
	assertMatch(calls[0].headers.Authorization, /^HMAC-SHA256 apiKey=KEY, date=2026-11-10T05:00:00.000Z, salt=abcdef0123456789, signature=[0-9a-f]{64}$/)
})

Deno.test("강조 제목의 변수는 보낼 값으로 바꾼다", async () => {
	const calls = stub({ body: ok })
	const service = await createSolapiService("KEY", "SECRET")
	await service.send(msg("VAR"))
	assertEquals(calls[0].body.messages[0].kakaoOptions.title, "예시학생 보고서")
	assertEquals(calls[0].body.allowDuplicates, undefined)
})

Deno.test("강조표기형이 아니면 title 없이 보낸다", async () => {
	const calls = stub({ body: ok })
	const service = await createSolapiService("KEY", "SECRET")
	await service.send(msg("PLAIN"))
	assertEquals("title" in calls[0].body.messages[0].kakaoOptions, false)
})

Deno.test("전부 접수 실패면 failedMessageList를 단 오류를 던진다", async () => {
	stub({ body: { groupInfo: { count: { total: 1, registeredFailed: 1 } }, failedMessageList: [{ statusCode: "1055", statusMessage: "강조형 템플릿은 title값이 필수입니다." }] } })
	const service = await createSolapiService("KEY", "SECRET")
	const err = await assertRejects(() => service.send(msg("EMPH")), SolapiNotReceivedError)
	assertEquals(err.failedMessageList[0].statusMessage, "강조형 템플릿은 title값이 필수입니다.")
})

Deno.test("HTTP 오류는 솔라피 오류 문구로 던진다", async () => {
	stub({ status: 401, body: { errorCode: "InvalidApiKey", errorMessage: "API Key가 올바르지 않습니다." } })
	const service = await createSolapiService("KEY", "SECRET")
	await assertRejects(() => service.send(msg("EMPH")), Error, "InvalidApiKey: API Key가 올바르지 않습니다.")
})

Deno.test("템플릿 강조 제목 읽기", async () => {
	assertEquals(templateEmphasisTitle(templates.EMPH), "수강 등록 안내")
	assertEquals(templateEmphasisTitle(templates.PLAIN), "")
	assertEquals(templateEmphasisTitle(null), "")
	clearTemplateFitCache()
	const broken = { getKakaoAlimtalkTemplate: async () => { throw new Error("읽기 실패") } }
	assertEquals(await emphasisTitleForTemplate(broken, "X", {}), "")
})
