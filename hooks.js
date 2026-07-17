// Claude Code 훅 명세와 설치/점검 로직 — 이 확장이 필요로 하는 훅의 단일
// 진실 공급원. vscode 의존성이 없어서 node로 직접 테스트할 수 있다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

// 훅 명세를 바꾸면 반드시 올릴 것 — 시작 시 안내의 "이 버전은 묻지 않음"이
// 이 버전 단위로 동작해서, 명세가 바뀌면 다시 안내된다.
const HOOKS_VERSION = 1;

// stdin JSON에서 문자열 필드 하나를 뽑는 sed (훅 커맨드는 POSIX sh에서 돈다)
const sedJsonField = (name) =>
	`sed -n "s/.*\\"${name}\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p"`;

// 기능 3/6: 이벤트 stdin JSON을 companion-events에 저장 (+1시간 지난 파일 정리)
const EVENTS_CMD =
	'd="$HOME/.claude/companion-events"; mkdir -p "$d"; find "$d" -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null; f="$d/$(date +%s%N)-$$"; cat > "$f.tmp" && mv "$f.tmp" "$f.json"';

// 기능 4: 활성 세션 기록 (claude -p 단발 실행은 부모 cmdline으로 감지해 제외)
const SESSION_START_CMD = `case " $(tr "\\0" " " < /proc/$PPID/cmdline 2>/dev/null)" in *" -p "*|*" --print "*) exit 0;; esac; d="$HOME/.claude/companion-sessions"; mkdir -p "$d"; j="$(cat)"; id=$(printf "%s" "$j" | ${sedJsonField('session_id')}); [ -n "$id" ] && printf "%s" "$j" > "$d/$id.json"; true`;

// 기능 4: 의도적 종료(exit/clear/logout)일 때만 세션 기록 삭제
const SESSION_END_CMD = `d="$HOME/.claude/companion-sessions"; j="$(cat)"; id=$(printf "%s" "$j" | ${sedJsonField('session_id')}); r=$(printf "%s" "$j" | ${sedJsonField('reason')}); case "$r" in clear|logout|prompt_input_exit) [ -n "$id" ] && rm -f "$d/$id.json";; esac; true`;

const HOOK_SPECS = [
	{ event: 'Stop', command: EVENTS_CMD },
	{ event: 'Notification', matcher: 'permission_prompt', command: EVENTS_CMD },
	{ event: 'UserPromptSubmit', command: EVENTS_CMD },
	{ event: 'PostToolUse', command: EVENTS_CMD },
	{ event: 'SessionStart', command: SESSION_START_CMD },
	{ event: 'SessionEnd', command: SESSION_END_CMD }
];

// companion 디렉토리를 참조하는 훅 항목 = 이 확장이 관리하는 항목.
// 별도 마커 없이 경로 참조로 식별해서, 수동 설치된 기존 훅도 관리 대상이 된다.
function isCompanionEntry(entry) {
	return (
		!!entry &&
		Array.isArray(entry.hooks) &&
		entry.hooks.some(
			(h) => h && typeof h.command === 'string' && h.command.includes('/.claude/companion-')
		)
	);
}

function specEntry(spec) {
	const entry = {};
	if (spec.matcher) {
		entry.matcher = spec.matcher;
	}
	entry.hooks = [{ type: 'command', command: spec.command }];
	return entry;
}

function entryMatchesSpec(entry, spec) {
	return (
		(entry.matcher || undefined) === (spec.matcher || undefined) &&
		Array.isArray(entry.hooks) &&
		entry.hooks.length === 1 &&
		entry.hooks[0].type === 'command' &&
		entry.hooks[0].command === spec.command
	);
}

// settings.json이 없으면 빈 설정으로 시작, 파싱 실패는 그대로 던짐 (덮어쓰기 방지)
function readSettings(file = SETTINGS_FILE) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return {};
	}
	return JSON.parse(raw);
}

// 명세와 어긋나는(없거나, 구버전이거나, 중복인) 이벤트 목록
function findStaleEvents(settings) {
	const hooks = (settings && settings.hooks) || {};
	const stale = [];
	for (const spec of HOOK_SPECS) {
		const ours = (hooks[spec.event] || []).filter(isCompanionEntry);
		if (ours.length !== 1 || !entryMatchesSpec(ours[0], spec)) {
			stale.push(spec.event);
		}
	}
	return stale;
}

// settings 객체를 제자리에서 수정하고 변경 내역을 돌려준다.
// companion 항목이 아닌 훅(사용자의 다른 훅)은 순서 포함 그대로 보존.
function mergeCompanionHooks(settings) {
	const hooks = settings.hooks || (settings.hooks = {});
	const added = [];
	const updated = [];
	for (const spec of HOOK_SPECS) {
		const entries = hooks[spec.event] || (hooks[spec.event] = []);
		const firstIdx = entries.findIndex(isCompanionEntry);
		if (firstIdx === -1) {
			entries.push(specEntry(spec));
			added.push(spec.event);
			continue;
		}
		const ours = entries.filter(isCompanionEntry);
		if (ours.length === 1 && entryMatchesSpec(ours[0], spec)) {
			continue; // 이미 최신
		}
		// 첫 companion 항목 자리에 최신 명세를 넣고 중복은 제거
		const rest = entries.filter((e) => !isCompanionEntry(e));
		rest.splice(Math.min(firstIdx, rest.length), 0, specEntry(spec));
		hooks[spec.event] = rest;
		updated.push(spec.event);
	}
	return { added, updated };
}

// 훅을 설치/갱신하고 결과를 돌려준다. 변경이 없으면 파일을 건드리지 않는다.
function installCompanionHooks(file = SETTINGS_FILE) {
	const settings = readSettings(file);
	const { added, updated } = mergeCompanionHooks(settings);
	let backup;
	if (added.length > 0 || updated.length > 0) {
		if (fs.existsSync(file)) {
			backup = `${file}.bak`;
			fs.copyFileSync(file, backup);
		} else {
			fs.mkdirSync(path.dirname(file), { recursive: true });
		}
		fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	}
	return { added, updated, backup, file };
}

module.exports = {
	SETTINGS_FILE,
	HOOKS_VERSION,
	HOOK_SPECS,
	readSettings,
	findStaleEvents,
	mergeCompanionHooks,
	installCompanionHooks
};
