# Redmine MCP 사전조사 리포트

> 작성: 2026-10-20 · 방법: 워크플로 5병렬 리서치 + 부모 직접 검증(클론 실측, 공식 문서, Redmine master 소스)
> 결론: **TypeScript/Node>=20, stdio-first, ms-graph-mcp 구조 미러링**이 정답. Redmine 6.1+는 Doorkeeper 기반 OAuth2 Provider를 코어에 내장.

## 1. 참조 레포 실측 비교

두 레포 모두 TypeScript ESM, Node>=20. Python안은 워크플로 오류였고(공식 샘플을 참조로 착각), follow-up에서 해소됨.

| 항목 | apple-debug-mcp | ms-graph-mcp (주 템플릿) |
|---|---|---|
| 패키지 | `apple-debug-mcp` 0.1.0 | `@devyhan/ms-graph-mcp` 0.7.0 |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.12 | `@modelcontextprotocol/server` ^2 |
| 검증 | zod ^3.23 | zod ^4 |
| Transport | StreamableHTTP 데몬 (127.0.0.1:3100, `/mcp`+`/health`) | **stdio 전용** (`serveStdio`, stdout 순수성 강제) |
| 인증 | 없음 (localhost 바인딩 + lease 게이팅) | **브라우저 OAuth2 코드+PKCE loopback**, device 보조, auto 기본 |
| 토큰 저장 | — | AES-256-GCM `token-cache.enc` + 32B `cache.key` (0600/0700, 원자적 쓰기) |
| 도구 수 | 65 (server 19 + extras 46) | 111 + discovery 쌍 |
| 테스트 | vitest 20파일/~289개 | **node:test, colocated `*.test.ts`, `scripts/run-tests.mjs`** |
| docs | 6종 | 8종 (auth 포함) |
| 워크플로 | ci + release | ci + release + graph-contract(주간 drift) |

### 1.1 ms-graph-mcp 소스 구조 (redmine-mcp가 그대로 미러링)

```
src/index.ts          CLI (serve/login/logout/status/permissions) + serveStdio
src/server.ts         McpServer 조립, SERVER_INSTRUCTIONS, agent_start 프롬프트,
                      ALWAYS_EXPOSED 4종, discovery 모드
src/config.ts         플래그+환경변수 파싱 (flags 우선, 미상은 hard error)
src/contracts.ts      AuthProvider/GraphClient/ToolDefinition/ServerConfig 타입,
                      InteractionRequiredError 6-flag 분류
src/auth/             provider.ts(브라우저+device+auto) / token-cache.ts /
                      preflight.ts(브라우저·loopback·도달성 사전점검) / index.ts
src/graph/            client.ts(host pinning, 429/503/504 백오프, $batch 20) 등
src/tools/            도메인별 모듈 + generic.ts(로그인 쌍·세션·범용호출) +
                      discovery.ts + groups.ts(스코프 카탈로그)
src/util/             paths, truncate, logger 등
```

핵심 패턴: `ToolModule { group, build(deps) }`, `ToolDeps { graph, config, auth(필수), consentScopes(지연클로저) }`,
`auth_begin_login`(비차단 브라우저 오픈)+`auth_login_status`(폴링) 쌍, 토큰은 대화에 절대 노출 금지.

## 2. OAuth 브라우저 로그인 설계

### 2.1 참조 구현 (ms-graph-mcp, 실측)

- MSAL PublicClientApplication, public client라 secret 없음.
- `acquireTokenInteractive` + 커스텀 `openBrowser`(detached `open/cmd/xdg-open`, stdio ignore).
- loopback 리다이렉트 `http://localhost[:--auth-port]`, 0이면 OS 할당. 성공/실패 HTML 템플릿.
- 데이터 경로는 `acquireTokenSilent`만. 실패 시 `InteractionRequiredError` 분류 플래그.
- `auto` 플로우: preflight(브라우저 가능·loopback 바인드·Entra 도달성) 후 브라우저 시도, 불가면 device 폴백.

### 2.2 Redmine 측 실체 (직접 검증)

- Redmine **6.1+ 코어가 Doorkeeper OAuth2 Provider 내장** (Feature #24808). 구 플러그인
  `suer/redmine_oauth_provider`는 OAuth 1.0a 유물(2015년 종료), `redmine_oauth` 포크들은
  클라이언트 방향(잘못된 방향)이라 모두 배제.
- `config/initializers/30-redmine.rb` (master 실측): `grant_flows ['authorization_code']` 단독,
  refresh token 사용, 토큰·시크릿 해시 저장, `allow_token_introspection false`,
  http loopback(localhost/127.0.0.1) 허용, scope = Redmine 권한명 + `admin` + `enforce_configured_scopes`,
  인가·앱관리 모두 **REST API 활성화 필수**.
- `Gemfile`: `doorkeeper ~> 5.9.6`. `routes.rb`: 표준 `use_doorkeeper` 마운트 →
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/applications`.
- PKCE 지시어 없음 → Doorkeeper 기본값 적용. 설계는 **PKCE S256 + client_secret 병행**으로
  양쪽(무시/요구) 모두 동작하게 함. 라이브 핸드셰이크 미검증은 잔여 리스크로 명시.

### 2.3 redmine-mcp 인증 설계 (확정)

1. 사용자는 Redmine 관리 → OAuth2 Applications에 앱 1회 등록
   (redirect `http://127.0.0.1:<port>/callback`, 필요 권한 scope 선택).
2. `redmine-mcp login` 또는 대화 내 `auth_begin_login`: 시스템 브라우저로
   `{REDMINE_URL}/oauth/authorize?code_challenge=S256…` 오픈, loopback 콜백 수신.
3. `POST /oauth/token`(code + PKCE verifier + secret) → access + refresh 저장
   (AES-256-GCM, ms-graph-mcp `token-cache.ts` 방식 그대로).
4. 데이터 경로는 silent refresh만. 만료·취소 시 재로그인 안내 에러 분류 반환.
5. **폴백**: pre-6.1 서버용 API 키 모드 (`X-Redmine-API-Key`, 브라우저 붙여넣기 화면 대신
   `login --api-key` + `GET /users/current.json` 검증). EasyRedmine 등 변형 커버.

## 3. Redmine REST API 커버리지 (공식 Rest_api 실측, 21 리소스)

| 리소스 | 상태 | 비고 |
|---|---|---|
| Issues, Projects | Stable | 핵심 |
| Users, TimeEntries, News | Stable | News CRUD는 4.1+ |
| Versions, WikiPages, Queries, Attachments | Alpha~Beta | |
| Memberships, IssueRelations, IssueStatuses, Trackers, Enumerations, IssueCategories, Roles, Groups, CustomFields, Search, Files, MyAccount, Journals | Alpha | |
| Documents | — | 7.1+ |

공통 규칙: `POST/PUT`에 `Content-Type` 필수, `.json` 접미, 페이지네이션 `offset/limit`
(기본 25, 최대 100), 연관데이터 `include=`, 커스텀필드 `custom_fields[]`,
파일은 `POST /uploads.json` → token을 이슈 등에 첨부, 에러는 `422` + 메시지 배열.
인증: Basic 또는 API 키(`key` 파라미터·Basic 유저명·`X-Redmine-API-Key` 헤더), OAuth2는
`Authorization: Bearer` (6.1+, REST API 활성화 필수).

### 3.1 도구 그룹 매핑 (초안, ms-graph-mcp `groups.ts` 대응)

`issues`(list/get/create/update/delete + notes·watchers·relations),
`projects`(list/get/create/update/archive + memberships),
`users`·`my`(current/get/update),
`time`(entries CRUD + activities),
`wiki`(pages CRUD), `files`(uploads/downloads),
`search`(global), `queries`(saved), `admin`(trackers/statuses/roles/groups/enumerations/customfields),
`generic`(auth 쌍 + session_status + redmine_request 범용 호출 + list_permissions).
쓰기 도구는 `--read-only`에서 제거. Discovery 모드 동일 제공.

## 4. 타겟 레포 구조 (확정)

ms-graph-mcp를 1:1 대응으로 미러링하고 `graph/`만 `redmine/`으로 교체.
apple-debug-mcp에서는 루트 문서 세트(CHANGELOG/CONTRIBUTING/SECURITY)와
`scripts/smoke.mjs` 라이브 스모크 아이디어를 차용.

```
redmine-mcp/
  package.json  tsconfig.json  README.md  CHANGELOG.md  CONTRIBUTING.md
  SECURITY.md  LICENSE  .gitignore
  src/index.ts  src/server.ts  src/config.ts  src/contracts.ts
  src/auth/{index,provider,token-cache,preflight}.ts (+colocated tests)
  src/redmine/{client,errors,paginate}.ts
  src/tools/{issues,projects,users,time,wiki,files,search,queries,admin,
              generic,discovery,groups}.ts
  src/util/{paths,truncate,logger}.ts
  scripts/{run-tests.mjs,smoke.mjs,redmine-contract.mjs}
  docs/{auth,configuration,tools,examples,security,agents,troubleshooting,why}.md
  .github/workflows/{ci,redmine-contract,release}.yml
```

환경변수 네임스페이스: `REDMINE_MCP_*` (`REDMINE_MCP_URL`, `REDMINE_MCP_CLIENT_ID`,
`REDMINE_MCP_CLIENT_SECRET`, `REDMINE_MCP_API_KEY`, `REDMINE_MCP_CACHE_DIR` …).
MCP 서버명: `redmine-mcp`. Transport: **stdio 우선** (HTTP 데몬은 후순위 옵션).

## 5. 잔여 리스크와 해소 계획

1. **라이브 Redmine 없음**: 인가·토큰 왕복 미관측. `scripts/redmine-contract.mjs`가
   도커 Redmine(6.1/7.x) 대상으로 주간 drift 검사. 수동 검증 전까지 릴리스 보류 항목.
2. **PKCE 강제 여부**: secret 병행 전송으로 양쪽 대응. 계약 스크립트에서 S256-only/public-only 케이스 분리 검증.
3. **DCR 없음**: Doorkeeper에 동적 등록이 없어 앱 사전등록 필수. 문서+`login` 가이드로 커버.
4. **scope 모델**: 권한명 기반이라 버전별 차이 가능. `redmine_list_permissions`로 실행 시점 노출.
5. **deepwiki 429**: 본문 미열람. 공식 wiki + 소스로 대체 완료, deepwiki는 아키텍처 이해용으로 후순위 재시도.

## 6. 빌드 단계

1. 스캐폴드: 루트 문서·설정·CI·`run-tests.mjs`·`contracts/config` (본 커밋).
2. `auth`(provider·token-cache·preflight) + `redmine/client` + 테스트.
3. `generic`·`discovery`·`groups` + `issues`·`projects`·`users`·`time` 1차 도구군.
4. 나머지 리소스 도구군 + docs 8종 + smoke/contract 스크립트.
5. 도커 Redmine 대상 라이브 검증 후 0.1.0 릴리스.
