# 업스트림 0.7.x 동기화 계획

이 포크(`JungHoon0814/openusage-windows`)는 mesomya의 Windows 포트(v0.6.37)를 기반으로 한다.
mesomya 포트는 robinebers/openusage v0.6.28(Tauri + JS 플러그인)에서 갈라졌다. 업스트림은 그 뒤
네이티브 Swift(macOS 전용)로 다시 작성되어 v0.7.15까지 649커밋이 쌓였다. Swift 코드는 그대로
가져올 수 없으므로, 기능을 하나씩 **JS 플러그인**(`plugins/<id>/plugin.js`)이나 **Rust 호스트 API**
(`src-tauri/src/plugin_engine/host_api.rs`)로 옮겨 쓴다.

## 리모트

| 이름 | 저장소 | 용도 |
|---|---|---|
| `origin` | JungHoon0814/openusage-windows | 내 포크 (push 대상) |
| `upstream` | mesomya/openusage-windows | Windows 포트 원본. 새 커밋이 생기면 merge |
| `robin` | robinebers/openusage | 원조 프로젝트. Swift 코드 참고용 (merge하지 않음) |

```bash
git fetch robin
git log v0.6.28..robin/main --oneline -- Sources/OpenUsage/Providers/<Name> docs/providers/<name>.md
```

## 포크에서 이미 바꾼 것

- 업데이터 기본값을 꺼 두었다(`VITE_ENABLE_UPDATER`). 엔드포인트는 이 포크의 릴리스를 가리키고, `createUpdaterArtifacts: false`로 서명 키 없이 NSIS 인스톨러가 빌드된다.
- 다시 켜려면: `tauri signer generate`로 키를 만들고, `tauri.conf.json`의 `pubkey`를 교체하고, `createUpdaterArtifacts`를 다시 켠 다음 `VITE_ENABLE_UPDATER=true`로 빌드한다.

## 작업 목록 (가치는 크고 공수는 작은 순)

| # | 항목 | 방식 | 크기 |
|---|---|---|---|
| 0 | **응답 형식이 바뀌어 지금 깨졌을 가능성이 높은 것** (아래 4번의 ⚠ 항목) | JS | S |
| 1 | OpenRouter 플러그인 신설 | JS | S |
| 2 | OpenCode Go: 공식 usage API + OpenCode 2 DB 지원 | JS | S–M |
| 3 | ccusage 버전 올리기 (임시 조치) | Rust 상수 | S |
| 4 | 기존 provider 변경분 이식 (S 항목부터) | JS | M |
| 5 | OpenCode Zen 로컬 지출 | JS (sqlite) | S–M |
| 6 | Ollama Cloud 플러그인 신설 | JS (+ Rust) | S–M |
| 7 | 네이티브 로컬 지출 엔진 + 가격표 | Rust | L |
| 8 | 멀티 계정·계정 전환·Claude Desktop | JS + Rust | L, 후순위 |

### 0. 지금 깨졌을 가능성이 높은 것 (S, 최우선) — 완료
코드 대조로 찾은 것이고 실제 계정으로는 확인하지 않았다. 5개 모두 provider별 커밋과 테스트로 반영했다(4c580c1, f179621, 71dcbc5, 0f5761c, 9bdfbd2). Claude는 단순화한 버전이다. 저장된 로그인에 `user:profile` 스코프가 있으면 그것을 쓰고, 업스트림처럼 env 토큰을 후순위 후보로 두지는 않는다.
- **ZAI**: 현재 응답은 쿼터 타입이 `TOKENS_LIMIT`이 아니라 `CREDIT_LIMIT`이다. 플러그인이 `TOKENS_LIMIT`만 찾기 때문에 "No usage data"가 뜰 것이다.
- **Grok**: 이제 `/v1/billing?format=credits` 형식으로 응답한다(`config.creditUsagePercent`, `currentPeriod`). 지금 플러그인은 "response changed" 예외를 던질 것이다.
- **Codex**: 창을 슬롯(primary/secondary)이 아니라 `limit_window_seconds`(18000은 Session, 604800은 Weekly)로 분류해야 한다. 지금은 weekly 창 하나만 primary에 오면 Session으로 잘못 표시한다.
- **Claude**: `CLAUDE_CODE_OAUTH_TOKEN` 환경변수가 설정돼 있으면 Session/Weekly가 비어 버린다.
- **Antigravity**: Cloud Code URL 순서가 거꾸로다. daily 엔드포인트에는 Gemini 쿼터가 없으므로 `cloudcode-pa`를 먼저 호출해야 한다.

### 1. OpenRouter (S) — 완료
`plugins/openrouter/`로 추가했다. 기본값은 꺼짐이고, 설정 방법은 `docs/providers/openrouter.md`에 있다.
- 키를 다음 순서로 찾는다: `~/.config/openusage/openrouter.json`(`apiKey`/`api_key`/`key` 또는 키만 든 텍스트) → `~/.config/openrouter/key.json` → 환경변수 `OPENROUTER_API_KEY` → `OPENROUTER_KEY`. Windows에서 `~`는 `%USERPROFILE%`이다.
- `GET https://openrouter.ai/api/v1/credits`는 필수이고, `GET /key`는 실패해도 넘어간다. 둘 다 Bearer 인증이다.
- 지표는 Credits, Balance, Today/This Week/This Month이고, 키에 한도가 걸려 있으면 Key Limit을 추가한다. $0은 "No data"가 아니라 0으로 표시한다.
- 기존 `fs`, `env`, `http` 호스트 API로 충분하다.
- 참고: `Sources/OpenUsage/Providers/OpenRouter/*`, `docs/providers/openrouter.md`.

### 2. OpenCode Go (S–M) — 완료
미터를 공식 usage API로 바꾸고, OpenCode 2 credential 테이블(import 마이그레이션 확인)과 데이터 디렉터리 해석, 모든 `opencode*.db` 읽기를 반영했다. 하드코딩된 $12/$30/$60 기준의 로컬 추정치는 업스트림처럼 없앴다.
- 미터 값은 `GET https://opencode.ai/zen/go/v1/usage`(Bearer)의 `usage.{rolling,weekly,monthly}.{percent,resetsAt}`에서 읽는다.
- OpenCode 2는 `session_message` 테이블을 쓰고 자격증명도 DB에 있다. `opencode*.db` 파일을 전부 읽는다.
- 참고: `Providers/OpenCode/OpenCodeAuthStore.swift`, `OpenCodeProvider.swift`.

### 3. ccusage 버전 올리기 (S)
- 현재 Claude/Codex의 일별 지출은 `host.ccusage`가 bunx/npx로 `ccusage`를 실행해서 얻는다. 그래서 Node가 필요하다.
- 7번을 하기 전까지는 고정된 ccusage 버전만 올려 최신 수정을 받는다.

### 4. 기존 provider 변경분
Windows 플러그인은 업스트림 v0.6.28 그대로다. Codex의 리셋 크레딧 목록, Antigravity/Devin의 Windows 경로만 추가돼 있다. 그래서 그 이후 Swift에서 바뀐 것은 전부 빠져 있다. ⚠ 표시는 0번에서 다룬다. 경로는 업스트림 `Sources/OpenUsage/Providers/` 기준이다.

**Claude** (`Claude/`)
- ⚠ 환경변수 토큰 처리: 라이브 미터는 저장된 로그인으로 읽고, env 토큰은 마지막 폴백으로만 쓴다(`ClaudeAuthStore.swift`). S
- 새 "Fable" 주간 지표: `limits[]`에서 `kind=="weekly_scoped"`인 항목을 읽는다. 기존 `seven_day_<model>` 키는 이제 null로 온다(`ClaudeUsageMapper.swift`). S
- User-Agent를 `claude-cli/<ver> (external, cli)`로 바꾼다. 알 수 없는 UA는 reset grant 대상에서 빠진다. S
- 토큰 갱신 후 다시 쓸 때: 파일을 새로 읽어 토큰 3개 필드만 병합한다. MCP 로그인 등 다른 필드를 덮어쓰지 않기 위해서다(`ClaudeCredentials.swift`). S
- 갱신 실패 메시지: `invalid_grant`일 때만 "Session expired"이고, 나머지는 "request failed (HTTP n)"로 표시한다. S
- 남은 Rate Limit Resets 표시: `?cedar_ember=1`로 요청하고 1시간에 한 번만 확인한다. 더 자주 부르면 429가 난다(`ClaudeProvider+ResetGrants.swift`). M
- 라이브 플랜 배지: `/api/oauth/profile`을 읽어 재로그인 없이 플랜 업그레이드를 반영한다. S–M
- `seven_day_omelette`("Claude Design")은 Swift에서 빠졌다. 실제 응답에서 확인한 뒤 지운다.

**Codex** (`Codex/`)
- ⚠ 창 분류를 `limit_window_seconds` 기준으로 바꾼다(`CodexUsageMapper.swift`). S
- "Reviews"와 모델별 행을 지운다. 업스트림에서 퇴역했고, "Spark"/"Spark Weekly"만 남긴다. S
- 플랜명: prolite는 "Pro 100", pro는 "Pro 200", promax는 "Pro 500"으로 표시한다. S
- 리셋 크레딧 요청: 헤더를 `OpenAI-Beta: codex-1`과 `originator: Codex Desktop`으로 바꾸고, 목록을 항상 받으며, `status`가 없는 항목도 남긴다. S
- 토큰 갱신 실패 처리와 쓰기 직전 소스 변경 감지(tokenConflict). S
- 리셋 크레딧 사용(`.../consume`): 되돌릴 수 없으므로 두 번 클릭해 확인하는 UI가 필요하다(`CodexResetClaimService.swift`). M

**Cursor** (`Cursor/`)
- 라벨 변경: "Auto usage"는 "Cursor Models", "API usage"는 "Other Models"가 되고, "Bonus spend"는 없앤다. S
- Grok Bot 미터: `DashboardService/GetSandUsageStatus`. S
- 팀 풀 퍼센트가 있으면 예전 $20 달러 미터 대신 그것을 쓴다(#1337). S
- On-demand: `individualUsed`, `pooledUsed`, `totalSpend` 순으로 찾는다. Credits는 남은 달러 금액 하나로 표시한다(#723). S
- 엔터프라이즈 폴백: `cursor.com/api/usage-summary`(#986). M
- 지출 히스토리: `get-filtered-usage-events`를 30일간 하루씩 받는다. 가격표가 필요하므로 7번 이후에 한다. L

**Copilot** (`Copilot/`)
- 매퍼 재작성: "Premium"은 "Credits"가 되고, Extra Usage와 Completions를 추가한다. unlimited/-1 값은 숨긴다. S
- 조직 관리 좌석: `token_based_billing`이면 개인 Credits 개수를 표시한다. S
- 자격증명 파일 경로: `apps.json`/`hosts.json`과 gh `hosts.yml`. Windows 경로는 실제 PC에서 확인해야 한다. `GH_TOKEN` 경로는 유지한다. S
- 조직 빌링: Org Credits/Spend(`CopilotOrgBillingClient.swift`). M

**Grok** (`Grok/`)
- ⚠ `?format=credits` 응답 파싱. "Weekly limit" 지표를 쓰고 예전 "Credits used"는 없앤다. S
- 412 "no personal team"은 오류로 처리하지 않고 경고만 띄운다(#1272). S
- `~/.grok/sessions/**/updates.jsonl` 로그 스캐너로 일별 지출. M–L

**Devin** (`Devin/`)
- `hideDailyQuota`일 때 남은 비율을 사용량으로 표시하는 버그를 고친다(100 − remaining). S
- 퍼센트는 없고 reset 시각만 있으면 100% 사용으로 표시한다(#1251). S

**ZAI** (`ZAI/`)
- ⚠ `CREDIT_LIMIT` 인식(#1105). S
- 창 분류를 `unit × number`로 계산한다(1일 미만은 Session, 그 이상은 Weekly). S
- `success:false` + "coding plan" 응답이면 "No active GLM Coding Plan" 오류를 띄운다. S
- 키 파일: `~/.config/openusage/zai.json`과 `~/.config/zai/key.json`을 환경변수보다 먼저 읽는다. S

**Antigravity** (`Antigravity/`)
- ⚠ Cloud Code URL 순서. S
- 쿼터 요약 엔드포인트 `retrieveUserQuotaSummary`(`gemini-5h`/`gemini-weekly`/`3p-5h`/`3p-weekly`)를 먼저 시도한다. M
- "Argon Weekly" 지표를 추가하고, 기존 경로의 Gemini 모델은 Session 하나로 합친다. S
- 토큰 갱신 오류를 세분화하고, 갱신 토큰 캐시에 지문을 붙인다. S
- 자격증명이 Keychain(go-keyring)으로 옮겨졌다. Windows에서 읽으려면 Credential Manager를 읽는 호스트 API가 새로 필요하다. M
- 대화 DB(protobuf)에서 지출 읽기. 7번 이후. L

### 5. OpenCode Zen 로컬 지출 (S–M)
- 메시지별 `cost` 컬럼을 일별로 합산한다. 기존 `host.sqlite`로 가능하다.

### 6. Ollama Cloud (S–M)
- 인증 키는 `~/.ollama/id_ed25519`(OpenSSH ed25519)다. 요청마다 `"<METHOD>,<path>?ts=<unix>"`를 서명해 `Authorization: <pubkey b64>:<sig b64>`로 보낸다.
- `GET https://ollama.com/api/balance`, `POST /api/me`를 호출한다.
- 먼저 로컬 Ollama 서버(`http://localhost:11434`)가 `/api/balance`를 프록시해 주는지 확인한다. 프록시해 주면 서명 없이 S 공수로 끝난다. 안 되면 `ed25519-dalek` 크레이트로 `host.crypto.ed25519SignOpenSsh`를 추가한다.
- 키 파일은 로그인하지 않아도 존재하므로, 키가 있다고 플러그인을 자동으로 켜면 안 된다.

### 7. 네이티브 로컬 지출 엔진 (L)
- JS로는 현실적이지 않다. QuickJS에서 수백 MB의 JSONL을 매번 파싱해야 하고, mtime을 읽을 수 없어 증분 캐시도 못 만든다.
- 대신 Rust에 `host.localUsage.daily({provider, days})`를 추가한다.
  - Claude 스캐너: `~/.claude/projects/**/*.jsonl`, (message.id, requestId)로 중복 제거.
  - Codex 스캐너: `$CODEX_HOME/{sessions,archived_sessions}`. fork replay 제외, priority/long-context 요율 등 업스트림 수정을 반영한다.
  - 경로+크기+mtime 키로 증분 캐시를 만든다.
  - 가격표는 LiteLLM, models.dev, pricing_supplement를 쓰고, 번들 스냅샷을 폴백으로 둔다.
- 이걸 만들면 Node 의존이 사라진다. 이후 Pi(Claude/Codex 카드에 합산), Grok 원장, Antigravity를 순서대로 붙인다.
- 참고: `Providers/Claude/ClaudeLogUsageScanner.swift`, `Providers/Codex/CodexLogUsageScanner.swift`, `Sources/OpenUsage/Pricing/*`.

### 8. 후순위
- 멀티 계정 카드, 계정 전환, Claude Desktop 인증은 macOS 경로가 많이 섞여 있다. Windows 경로(`%APPDATA%\Claude` 등)를 확인하기 전까지는 보류한다.

## 그대로 둘 것
- amp, factory, jetbrains-ai-assistant, kimi, kiro, minimax, perplexity, synthetic은 Swift판에서 빠진 플러그인이다. 업스트림에 새 코드가 없으므로 지금 상태를 유지한다.

## 작업 방식
- 항목 하나당 커밋 하나. 플러그인 옆에 `plugin.test.js`를 두고 `npx vitest run plugins/<id>`로 검증한다.
- Rust 변경 후에는 `cargo test -- --test-threads=1`(src-tauri)을 돌린다. CI도 같은 방식으로 단일 스레드에서 실행한다.
- 배포할 때는 업스트림 [TRADEMARK.md](https://github.com/robinebers/openusage/blob/main/TRADEMARK.md)에 따라 "OpenUsage" 이름과 로고를 쓰지 말고 포크임을 밝힌다. 개인적으로만 쓴다면 상관없다.
