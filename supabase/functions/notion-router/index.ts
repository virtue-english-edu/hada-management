// notion-router — 웹훅 길잡이 (v2.8.0, 261111)
//
// 학원의 모든 Notion 버튼·자동화가 이 주소 하나·같은 키(x-admin-key)로 보낸다. 동작 ID(본문에서 이름이 "웹훅"으로
// 시작하는 칸 — 버튼 `웹훅 버튼`, 자동화 `웹훅 정보` 등. 헤더 x-hada-action·?a=도 받음)를 보고 기존 함수 주소로
// 본문을 그대로 넘긴다. 자세한 규칙은
// _shared/webhookRouter.ts, 연결표는 _shared/webhookRoutes.ts(= 관리자 설정 웹훅 체크리스트 항목 ID).
import { handleRouter } from "../_shared/webhookRouter.ts"

Deno.serve((req: Request) => handleRouter(req))
