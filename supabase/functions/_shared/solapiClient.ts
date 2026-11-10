// (항목 49) 솔라피 알림톡 발송 창구. 솔라피 SDK(npm:solapi 6.x)의 send()는 요청을 스키마로 검사하면서
// 스키마에 없는 kakaoOptions.title을 지운다. 강조표기형 템플릿은 title(강조 제목)이 없으면 접수되지 않으므로
// (1055 "강조형 템플릿은 title값이 필수입니다", 11/10 확인), 템플릿 조회는 SDK로 하고 발송은 같은 키로
// 솔라피 REST(send-many/fast, SDK가 쓰는 주소)에 직접 보내면서 강조 제목을 채운다.
// 돌려주는 값과 오류는 SDK send()와 같은 모양: 전부 실패하면 failedMessageList를 단 오류를 던진다.
import { emphasisTitleForTemplate } from "./templateFit.ts"

const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/fast"

type KakaoOptions = { pfId: string; templateId?: string; variables?: Record<string, string>; disableSms?: boolean; title?: string }
export type SolapiMessage = { to: string | string[]; from?: string; kakaoOptions?: KakaoOptions; [key: string]: unknown }
type TemplateSdk = { getKakaoAlimtalkTemplate(templateId: string): Promise<unknown> }

export const solapiDeps = {
	fetch: (url: string, init: RequestInit) => fetch(url, init),
	now: () => new Date().toISOString(),
	salt: () => crypto.randomUUID().replace(/-/g, ""),
	loadSdk: async (apiKey: string, apiSecret: string): Promise<TemplateSdk> => {
		const { SolapiMessageService } = await import("npm:solapi")
		return new SolapiMessageService(apiKey, apiSecret)
	},
}

async function hmacHex(secret: string, text: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))
	return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function solapiAuthHeader(apiKey: string, apiSecret: string): Promise<string> {
	const date = solapiDeps.now()
	const salt = solapiDeps.salt()
	return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${await hmacHex(apiSecret, date + salt)}`
}

export class SolapiNotReceivedError extends Error {
	failedMessageList: Array<{ statusCode?: string; statusMessage?: string }>
	constructor(failed: Array<{ statusCode?: string; statusMessage?: string }>) {
		super(`${failed.length}개의 메시지가 접수되지 못했습니다. 자세한 에러 메시지는 해당 에러 내 failedMessageList를 확인해주세요.`)
		this.name = "MessageNotReceivedError"
		this.failedMessageList = failed
	}
}

export async function createSolapiService(apiKey: string, apiSecret: string) {
	const sdk = await solapiDeps.loadSdk(apiKey, apiSecret)
	return {
		getKakaoAlimtalkTemplate: (templateId: string) => sdk.getKakaoAlimtalkTemplate(templateId),
		async send(message: SolapiMessage | SolapiMessage[], config: { allowDuplicates?: boolean } = {}) {
			const list = Array.isArray(message) ? message : [message]
			const messages: SolapiMessage[] = []
			for (const m of list) {
				const k = m.kakaoOptions
				if (k?.templateId && !k.title) {
					const title = await emphasisTitleForTemplate(sdk, k.templateId, k.variables ?? {})
					messages.push(title ? { ...m, kakaoOptions: { ...k, title } } : m)
				} else messages.push(m)
			}
			const res = await solapiDeps.fetch(SOLAPI_SEND_URL, {
				method: "POST",
				headers: { Authorization: await solapiAuthHeader(apiKey, apiSecret), "Content-Type": "application/json" },
				body: JSON.stringify({ messages, ...(config.allowDuplicates ? { allowDuplicates: true } : {}) }),
			})
			const body = await res.json().catch(() => ({})) as any
			if (!res.ok) {
				const err = new Error(`${body?.errorCode ?? res.status}: ${body?.errorMessage ?? "솔라피 요청 실패"}`) as Error & { errorMessage?: string }
				err.errorMessage = body?.errorMessage
				throw err
			}
			const failed = Array.isArray(body?.failedMessageList) ? body.failedMessageList : []
			const total = body?.groupInfo?.count?.total
			const registeredFailed = body?.groupInfo?.count?.registeredFailed
			if (failed.length > 0 && (total === undefined || total === registeredFailed)) throw new SolapiNotReceivedError(failed)
			return body
		},
	}
}
