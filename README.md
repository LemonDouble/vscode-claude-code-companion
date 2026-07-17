# Claude Code Companion

Claude Code CLI로 여러 프로젝트를 동시에 진행할 때의 워크플로우를 돕는 VS Code 확장.

멀티 루트 워크스페이스 한 창에서 프로젝트별 터미널을 띄워놓고 작업하는 상황을 전제로 한다. 기능은 계속 추가될 예정.

## 기능

### 1. 터미널-탐색기 동기화

터미널 포커스를 옮기면 탐색기(Explorer)가 해당 터미널의 작업 디렉토리로 자동 이동하고 해당 폴더를 펼친다.

- 활성 터미널이 바뀌면 (`onDidChangeActiveTerminal`) 셸 통합 API(`Terminal.shellIntegration.cwd`)로 그 터미널의 현재 작업 디렉토리를 조회해서 탐색기에서 reveal + 펼침
- 터미널 안에서 `cd`로 이동해도 따라감 (`explorerSync.followCd` 설정으로 끌 수 있음)
- 열려있는 에디터 탭은 건드리지 않음

VS Code에는 이 방향의 내장 기능이 없다 ([microsoft/vscode#71641](https://github.com/Microsoft/vscode/issues/71641), as-designed로 닫힘).

### 2. 현재 프로젝트로 한정된 검색

멀티 루트 워크스페이스에서 검색이 전체 워크스페이스에 걸리는 문제를 해결한다. "현재 프로젝트"는 마지막으로 포커스한 터미널의 폴더 또는 마지막으로 연 에디터 파일의 폴더로 자동 판단한다.

진입점은 마우스 중심으로 두 곳:

- **검색 뷰 상단의 필터 버튼** (`$(filter)` 아이콘) — 클릭하면 검색 뷰의 "포함할 파일"이 현재 프로젝트(`./폴더명`)로 채워진다. 한 번 채워지면 바꾸기 전까지 유지된다.
- **상태 표시줄의 현재 프로젝트 표시** (왼쪽 하단 `$(root-folder) 프로젝트명`) — 클릭하면 메뉴가 뜬다:
  - 현재 프로젝트에서 텍스트 검색
  - 현재 프로젝트에서 파일 열기 — 해당 프로젝트 파일만 QuickPick으로 표시 (Ctrl+P의 프로젝트 한정판, `files.exclude`/`search.exclude` 존중)
  - 다른 프로젝트로 전환 — 자동 판단을 수동으로 덮어쓰기

커맨드 팔레트(`Claude Code Companion: ...`)에서도 실행 가능하며, 기본 단축키는 제공하지 않는다 (원하면 키보드 단축키 설정에서 직접 할당).

### 3. Claude 응답 완료 / 승인 대기 알림

여러 터미널에서 Claude Code를 돌릴 때, 어느 프로젝트의 Claude가 **응답을 마쳤는지**(✅) 또는 **권한 승인을 기다리며 멈춰 있는지**(⏸️) VS Code 알림으로 알려준다. 알림의 "터미널로 이동" 버튼을 누르면 해당 프로젝트의 터미널로 포커스가 이동한다.

동작 방식: Claude Code의 [Stop 훅과 Notification 훅](https://code.claude.com/docs/en/hooks)이 이벤트 파일을 `~/.claude/companion-events/`에 쓰고, 확장이 이 디렉토리를 감시한다. 이벤트 종류는 페이로드의 `hook_event_name`으로 구분한다.

- 해당 프로젝트가 워크스페이스에 열려 있는 창에만 알림이 뜬다
- "터미널로 이동"은 claude 프로세스의 부모 셸 pid와 `terminal.processId`를 매칭해서, 같은 폴더에 터미널이 여러 개여도 claude가 실제로 도는 터미널로 이동한다
- `stopNotification.enabled` / `permissionNotification.enabled` 설정으로 각각 끌 수 있다
- `notifications.skipWhenViewing`을 켜면 해당 프로젝트 터미널을 보고 있을 때 알림을 생략한다 (터미널 패널이 닫혀 있어도 생략될 수 있는 오탐이 있어 기본 꺼짐)

**훅 설치** (필수, 1회): `~/.claude/settings.json`의 `hooks`에 추가:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "d=\"$HOME/.claude/companion-events\"; mkdir -p \"$d\"; find \"$d\" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; f=\"$d/$(date +%s%N)-$$\"; cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.json\""
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "d=\"$HOME/.claude/companion-events\"; mkdir -p \"$d\"; find \"$d\" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; f=\"$d/$(date +%s%N)-$$\"; cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.json\""
          }
        ]
      }
    ]
  }
}
```

훅은 이벤트의 stdin JSON(cwd 포함)을 그대로 파일로 저장하며, 1시간 지난 이벤트 파일은 스스로 정리한다. 승인 대기 알림의 한계: 승인을 이미 처리했어도 떠 있는 알림 토스트는 자동으로 사라지지 않는다 (VS Code API 제약).

### 4. Claude 세션 저장/복구

VS Code를 껐다 켜면 각 프로젝트 터미널에서 돌던 Claude 세션이 다 죽는 문제를 해결한다. 터미널 스크롤백은 살릴 수 없지만, 진짜 중요한 대화 세션은 `claude --resume <session_id>`로 복구된다.

동작 방식:

- **SessionStart 훅**이 세션 시작 시 `~/.claude/companion-sessions/<session_id>.json`에 기록 (cwd 포함). `claude -p` 단발 실행은 훅이 부모 프로세스의 cmdline에서 감지해 기록하지 않는다.
- **SessionEnd 훅**이 의도적 종료(`/exit`, `/clear`, logout — reason이 `prompt_input_exit`/`clear`/`logout`)일 때만 기록을 삭제한다. 창이 닫혀서 죽은 경우(SIGHUP)는 reason이 `other`라 기록이 남는다 — 실측 결과 SIGHUP에서도 SessionEnd 훅이 실행되므로 reason 구분이 필수다.
- **확장이 시작될 때** 남은 기록 중 이 창의 워크스페이스에 속한 것을 찾아 "복구할까요?" 알림을 띄운다. 수락하면 프로젝트별 터미널을 만들어 `claude --resume <session_id>`를 실행한다.
- 창 리로드처럼 claude 프로세스가 살아있는 경우는 `/proc` 스캔(argv[0]이 `claude`인 프로세스의 cwd)으로 걸러내 이중 부활을 막는다.
- 커맨드 팔레트 `Claude Code Companion: Claude 세션 복구`로 수동 실행도 가능.
- 30일 지난 기록은 자동 정리.

**훅 설치** (필수, 1회): `~/.claude/settings.json`의 `hooks`에 추가:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "case \" $(tr \"\\0\" \" \" < /proc/$PPID/cmdline 2>/dev/null)\" in *\" -p \"*|*\" --print \"*) exit 0;; esac; d=\"$HOME/.claude/companion-sessions\"; mkdir -p \"$d\"; j=\"$(cat)\"; id=$(printf \"%s\" \"$j\" | sed -n \"s/.*\\\"session_id\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\"); [ -n \"$id\" ] && printf \"%s\" \"$j\" > \"$d/$id.json\"; true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "d=\"$HOME/.claude/companion-sessions\"; j=\"$(cat)\"; id=$(printf \"%s\" \"$j\" | sed -n \"s/.*\\\"session_id\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\"); r=$(printf \"%s\" \"$j\" | sed -n \"s/.*\\\"reason\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\"); case \"$r\" in clear|logout|prompt_input_exit) [ -n \"$id\" ] && rm -f \"$d/$id.json\";; esac; true"
          }
        ]
      }
    ]
  }
}
```

### 5. Add to Claude Path

탐색기에서 파일/폴더를 우클릭하면 메뉴 최상단에 **Add to Claude Path**가 뜬다. 클릭하면 선택한 항목의 절대 경로가 활성 터미널(=Claude Code 입력창)에 개행 없이 타이핑되고 포커스가 터미널로 이동한다 — 이어서 프롬프트를 계속 쓰면 된다.

- 다중 선택 지원 (공백으로 구분해서 한꺼번에 입력)
- 공백이 포함된 경로는 자동으로 따옴표 처리
- 활성 터미널로 보내므로, 프로젝트 A의 채팅에 프로젝트 B의 파일 경로를 넣는 것도 가능

## 설치

[Releases](https://github.com/LemonDouble/vscode-claude-code-companion/releases)에서 vsix를 받거나, 직접 빌드한다:

```bash
npx --yes @vscode/vsce package
code --install-extension vscode-claude-code-companion-0.7.1.vsix
```

WSL 환경이라면 VS Code 통합 터미널(WSL)에서 실행해야 WSL 쪽에 설치된다.
UI로 설치하려면: 확장 탭 → `...` 메뉴 → "Install from VSIX...".

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `claudeCodeCompanion.explorerSync.enabled` | `true` | 터미널 포커스 시 탐색기 이동 |
| `claudeCodeCompanion.explorerSync.followCd` | `true` | 터미널 안에서 cd 할 때도 따라 이동 |
| `claudeCodeCompanion.stopNotification.enabled` | `true` | Claude 응답 완료 시 알림 표시 |
| `claudeCodeCompanion.permissionNotification.enabled` | `true` | Claude 승인 대기 시 알림 표시 |
| `claudeCodeCompanion.notifications.skipWhenViewing` | `false` | 보고 있는 프로젝트의 알림 생략 (옵트인) |
| `claudeCodeCompanion.sessionRestore.enabled` | `true` | 시작 시 끊긴 Claude 세션 복구 여부 물어보기 |
| `claudeCodeCompanion.sessionRestore.claudeCommand` | `claude` | 복구 시 사용할 claude 실행 명령 |

커맨드 팔레트에서 `Claude Code Companion: 터미널-탐색기 동기화 켜기/끄기`로 토글 가능.

## 요구사항

- VS Code 1.93 이상 (셸 통합 API)
- 터미널 셸 통합 활성화 (bash/zsh 등에서 기본 자동 주입, `terminal.integrated.shellIntegration.enabled`)
- 탐색기 동기화는 터미널의 cwd가 열린 워크스페이스 폴더 안에 있을 때만 동작

## 함께 쓰면 좋은 워크스페이스 설정

```jsonc
{
	"settings": {
		// 터미널 탭 이름을 해당 터미널의 현재 폴더명으로 자동 표시
		"terminal.integrated.tabs.title": "${cwdFolder}",
		// 터미널 분할 시 어느 워크스페이스 폴더에서 열지 선택창 표시
		"terminal.integrated.splitCwd": "workspaceRoot"
	}
}
```
