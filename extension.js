const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_NS = 'claudeCodeCompanion';

function config() {
	return vscode.workspace.getConfiguration(CONFIG_NS);
}

// ============================================================
// 현재 프로젝트 추적
// 터미널 포커스/cwd 변경, 에디터 전환 중 가장 최근 이벤트를 기준으로
// "지금 작업 중인 프로젝트(워크스페이스 폴더)"를 기억한다.
// ============================================================

let currentProjectFolder;

function setCurrentProject(uri) {
	if (!uri) {
		return undefined;
	}
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder) {
		currentProjectFolder = folder;
		updateStatusBar();
	}
	return folder;
}

async function resolveProjectFolder() {
	if (currentProjectFolder) {
		return currentProjectFolder;
	}
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 0) {
		vscode.window.showWarningMessage('열린 워크스페이스 폴더가 없습니다.');
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0];
	}
	const picked = await vscode.window.showQuickPick(
		folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
		{ placeHolder: '프로젝트 선택' }
	);
	return picked && picked.folder;
}

// ============================================================
// 상태 표시줄: 현재 프로젝트 표시 + 클릭 시 검색/파일 열기 메뉴
// ============================================================

let statusItem;

function updateStatusBar() {
	if (!statusItem) {
		return;
	}
	if (currentProjectFolder) {
		statusItem.text = `$(root-folder) ${currentProjectFolder.name}`;
		statusItem.tooltip = '현재 프로젝트 — 클릭해서 검색/파일 열기';
		statusItem.show();
	} else {
		statusItem.hide();
	}
}

async function switchProject() {
	const folders = vscode.workspace.workspaceFolders || [];
	const picked = await vscode.window.showQuickPick(
		folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
		{ placeHolder: '현재 프로젝트로 지정할 폴더 선택' }
	);
	if (picked) {
		currentProjectFolder = picked.folder;
		updateStatusBar();
	}
}

async function projectActions() {
	const folder = await resolveProjectFolder();
	if (!folder) {
		return;
	}
	const picked = await vscode.window.showQuickPick(
		[
			{ label: `$(search) ${folder.name}에서 텍스트 검색`, action: findInProject },
			{ label: `$(go-to-file) ${folder.name}에서 파일 열기`, action: openFileInProject },
			{ label: '$(folder-opened) 다른 프로젝트로 전환...', action: switchProject }
		],
		{ placeHolder: `현재 프로젝트: ${folder.name}` }
	);
	if (picked) {
		await picked.action();
	}
}

// ============================================================
// 기능 1: 터미널-탐색기 동기화
// 터미널 포커스가 바뀌면 그 터미널의 작업 디렉토리를 탐색기에서 reveal + 펼침.
// ============================================================

// 직전에 reveal한 경로 — 같은 폴더를 반복해서 reveal하지 않기 위한 기억값
let lastRevealedPath;
// 포커스 시점에 셸 통합(cwd 조회)이 아직 준비되지 않았던 터미널들
const pendingReveal = new WeakSet();

function getTerminalCwd(terminal) {
	if (terminal.shellIntegration && terminal.shellIntegration.cwd) {
		return terminal.shellIntegration.cwd;
	}
	// 셸 통합이 아직 없으면 터미널 생성 시 지정된 cwd로 대체
	const raw = terminal.creationOptions && terminal.creationOptions.cwd;
	if (!raw) {
		return undefined;
	}
	return typeof raw === 'string' ? vscode.Uri.file(raw) : raw;
}

async function revealCwd(terminal) {
	if (!terminal) {
		return;
	}
	const cwd = getTerminalCwd(terminal);
	if (!cwd) {
		return;
	}
	// 동기화가 꺼져 있어도 현재 프로젝트 추적은 유지
	const folder = setCurrentProject(cwd);
	// 워크스페이스 바깥 경로는 탐색기 트리에 없으므로 무시
	if (!folder || !config().get('explorerSync.enabled', true)) {
		return;
	}
	if (cwd.toString() === lastRevealedPath) {
		return;
	}
	lastRevealedPath = cwd.toString();
	try {
		await vscode.commands.executeCommand('revealInExplorer', cwd);
		// reveal은 폴더를 선택만 하고 펼치지는 않으므로, 포커스된 항목을 펼침
		await vscode.commands.executeCommand('list.expand');
		// reveal이 탐색기로 포커스를 가져가므로 터미널로 되돌림
		if (vscode.window.activeTerminal === terminal) {
			terminal.show(false);
		}
	} catch {
		// reveal 실패(트리에서 찾을 수 없는 항목 등)는 조용히 무시
	}
}

function handleTerminalFocus(terminal) {
	if (!terminal) {
		return;
	}
	if (!(terminal.shellIntegration && terminal.shellIntegration.cwd)) {
		// 셸 통합이 활성화되면 onDidChangeTerminalShellIntegration에서 재시도
		pendingReveal.add(terminal);
	}
	revealCwd(terminal);
}

// ============================================================
// 기능 2: 현재 프로젝트로 한정된 검색
// ============================================================

// 검색 뷰를 현재 프로젝트 폴더로 스코프해서 연다 (완전한 한정)
async function findInProject() {
	const folder = await resolveProjectFolder();
	if (!folder) {
		return;
	}
	const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
	await vscode.commands.executeCommand('workbench.action.findInFiles', {
		// 멀티 루트에서 ./루트폴더명 은 해당 루트 하나로 검색을 한정하는 문법
		filesToInclude: multiRoot ? `./${folder.name}` : '',
		showIncludesExcludes: true
	});
}

// files.exclude + search.exclude 를 합쳐 findFiles용 제외 glob 생성
function buildExcludeGlob(folder) {
	const patterns = new Set();
	for (const section of ['files', 'search']) {
		const excludes = vscode.workspace.getConfiguration(section, folder.uri).get('exclude') || {};
		for (const [pattern, active] of Object.entries(excludes)) {
			if (active) {
				patterns.add(pattern);
			}
		}
	}
	return patterns.size > 0 ? `{${[...patterns].join(',')}}` : undefined;
}

const MAX_FILES = 20000;

// 현재 프로젝트 폴더의 파일만 QuickPick으로 보여준다 (Ctrl+P의 프로젝트 한정판)
async function openFileInProject() {
	const folder = await resolveProjectFolder();
	if (!folder) {
		return;
	}
	const files = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*'),
		buildExcludeGlob(folder),
		MAX_FILES
	);
	if (files.length === 0) {
		vscode.window.showInformationMessage(`${folder.name} 안에서 파일을 찾지 못했습니다.`);
		return;
	}
	const items = files
		.map((uri) => {
			const rel = vscode.workspace.asRelativePath(uri, false);
			const slash = rel.lastIndexOf('/');
			return {
				label: slash >= 0 ? rel.slice(slash + 1) : rel,
				description: slash >= 0 ? rel.slice(0, slash) : '',
				uri
			};
		})
		.sort((a, b) => `${a.description}/${a.label}`.localeCompare(`${b.description}/${b.label}`));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `${folder.name}에서 파일 열기${files.length >= MAX_FILES ? ` (상위 ${MAX_FILES}개만 표시)` : ''}`,
		matchOnDescription: true
	});
	if (picked) {
		await vscode.window.showTextDocument(picked.uri);
	}
}

// ============================================================
// 기능 3: Claude 응답 완료 알림
// Claude Code의 Stop 훅이 ~/.claude/companion-events/ 에 이벤트 파일을
// 떨구면 (설치 방법은 README 참고), 그 이벤트의 cwd를 워크스페이스
// 폴더에 매핑해서 알림을 띄운다. 알림 클릭 시 해당 터미널로 이동.
// ============================================================

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'companion-events');

// 알림이 떠 있는 동안 같은 폴더의 중복 알림을 막기 위한 기억값
const pendingNotifications = new Set();

function findTerminalForFolder(folder, cwdPath) {
	let fallback;
	for (const t of vscode.window.terminals) {
		const cwd = getTerminalCwd(t);
		if (!cwd || cwd.scheme !== 'file') {
			continue;
		}
		if (cwd.fsPath === cwdPath) {
			return t;
		}
		const f = vscode.workspace.getWorkspaceFolder(cwd);
		if (f && f.uri.toString() === folder.uri.toString() && !fallback) {
			fallback = t;
		}
	}
	return fallback;
}

async function handleStopEvent(file) {
	let event;
	try {
		event = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return; // 아직 쓰이는 중이거나 깨진 파일
	}
	if (!event || typeof event.cwd !== 'string') {
		fs.unlink(file, () => {});
		return;
	}
	const uri = vscode.Uri.file(event.cwd);
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return; // 이 창에 없는 프로젝트 — 해당 폴더가 열린 다른 창의 몫
	}
	// 이 창의 이벤트로 확정됐으므로 파일 제거 (다른 창의 뒤늦은 처리 방지)
	fs.unlink(file, () => {});
	if (!config().get('stopNotification.enabled', true)) {
		return;
	}
	// 이미 그 프로젝트의 터미널을 보고 있으면 알림 생략
	const active = vscode.window.activeTerminal;
	if (vscode.window.state.focused && active) {
		const activeCwd = getTerminalCwd(active);
		const activeFolder = activeCwd && vscode.workspace.getWorkspaceFolder(activeCwd);
		if (activeFolder && activeFolder.uri.toString() === folder.uri.toString()) {
			return;
		}
	}
	const key = folder.uri.toString();
	if (pendingNotifications.has(key)) {
		return;
	}
	pendingNotifications.add(key);
	try {
		const picked = await vscode.window.showInformationMessage(
			`✅ ${folder.name} — Claude 응답 완료`,
			'터미널로 이동'
		);
		if (picked === '터미널로 이동') {
			const terminal = findTerminalForFolder(folder, event.cwd);
			if (terminal) {
				terminal.show();
			} else {
				await vscode.commands.executeCommand('revealInExplorer', uri);
			}
		}
	} finally {
		pendingNotifications.delete(key);
	}
}

function startStopEventWatcher(context) {
	try {
		fs.mkdirSync(EVENTS_DIR, { recursive: true });
		// 이전 세션에서 남은 이벤트 정리 — 다른 창이 방금 쓴 이벤트는 건드리지
		// 않도록 30초 이상 지난 파일만 지운다
		const now = Date.now();
		for (const name of fs.readdirSync(EVENTS_DIR)) {
			const p = path.join(EVENTS_DIR, name);
			try {
				if (now - fs.statSync(p).mtimeMs > 30_000) {
					fs.unlinkSync(p);
				}
			} catch {
				// 다른 창이 먼저 지웠으면 무시
			}
		}
		const watcher = fs.watch(EVENTS_DIR, (_eventType, filename) => {
			// 훅이 .tmp에 쓴 뒤 .json으로 rename하므로, .json 등장 = 쓰기 완료
			if (filename && filename.endsWith('.json')) {
				handleStopEvent(path.join(EVENTS_DIR, filename));
			}
		});
		context.subscriptions.push({ dispose: () => watcher.close() });
	} catch (e) {
		console.warn('claude-code-companion: 이벤트 감시 시작 실패', e);
	}
}

// ============================================================
// 기능 4: Claude 세션 저장/복구
// SessionStart/SessionEnd 훅이 ~/.claude/companion-sessions/ 에 활성
// 세션을 기록한다 (설치 방법은 README 참고). VS Code가 통째로 꺼지면
// SessionEnd가 실행되지 못해 파일이 남고, 그 파일이 곧 복구 대상이다.
// 복구 = 해당 폴더에 터미널을 만들어 `claude --resume <session_id>` 실행.
// ============================================================

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'companion-sessions');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readSavedSessions() {
	let names;
	try {
		names = fs.readdirSync(SESSIONS_DIR);
	} catch {
		return [];
	}
	const sessions = [];
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		const file = path.join(SESSIONS_DIR, name);
		try {
			const mtime = fs.statSync(file).mtimeMs;
			if (Date.now() - mtime > SESSION_MAX_AGE_MS) {
				fs.unlinkSync(file); // 오래된 잔재 정리
				continue;
			}
			const data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (data && typeof data.cwd === 'string' && typeof data.session_id === 'string') {
				sessions.push({ file, cwd: data.cwd, sessionId: data.session_id, mtime });
			}
		} catch {
			// 깨진 파일/동시 삭제는 무시
		}
	}
	return sessions;
}

// argv[0]이 정확히 claude인 프로세스들의 cwd 목록 (/proc 스캔, Linux/WSL 전용)
function runningClaudeCwds() {
	const cwds = [];
	let pids;
	try {
		pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
	} catch {
		return cwds; // /proc 없는 플랫폼 — 실행 중 감지 생략
	}
	for (const pid of pids) {
		try {
			const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || '';
			if (path.basename(argv0) !== 'claude') {
				continue;
			}
			cwds.push(fs.readlinkSync(`/proc/${pid}/cwd`));
		} catch {
			// 이미 종료됐거나 권한 없음
		}
	}
	return cwds;
}

// 이 창에서 복구 가능한 세션 목록: 폴더당 최신 1개, 살아있는 세션 제외.
// files에는 해당 폴더의 레지스트리 파일 전부를 담는다 (복구/무시 시 일괄 정리용).
function collectRestorableSessions() {
	const aliveFolders = new Set();
	for (const cwd of runningClaudeCwds()) {
		const f = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
		if (f) {
			aliveFolders.add(f.uri.toString());
		}
	}
	const byFolder = new Map();
	for (const s of readSavedSessions()) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(s.cwd));
		if (!folder) {
			continue; // 이 창의 프로젝트 아님
		}
		const key = folder.uri.toString();
		if (aliveFolders.has(key)) {
			continue; // 이미 돌고 있음 (창 리로드 직후 등) — 부활 금지
		}
		const entry = byFolder.get(key) || { folder, files: [], latest: s };
		entry.files.push(s.file);
		if (s.mtime > entry.latest.mtime) {
			entry.latest = s;
		}
		byFolder.set(key, entry);
	}
	return [...byFolder.values()];
}

function discardSessionFiles(items) {
	for (const item of items) {
		for (const file of item.files) {
			try {
				fs.unlinkSync(file);
			} catch {
				// 다른 창이 먼저 지웠으면 무시
			}
		}
	}
}

function launchRestoredSessions(items) {
	const claudeCmd = config().get('sessionRestore.claudeCommand', 'claude');
	for (const item of items) {
		const s = item.latest;
		const terminal = vscode.window.createTerminal({
			name: item.folder.name,
			cwd: vscode.Uri.file(s.cwd)
		});
		terminal.show(true);
		terminal.sendText(`${claudeCmd} --resume ${s.sessionId}`);
	}
	discardSessionFiles(items);
}

async function restoreSessionsCommand() {
	const items = collectRestorableSessions();
	if (items.length === 0) {
		vscode.window.showInformationMessage('복구할 Claude 세션이 없습니다.');
		return;
	}
	launchRestoredSessions(items);
}

async function promptRestoreOnStartup() {
	if (!config().get('sessionRestore.enabled', true)) {
		return;
	}
	const items = collectRestorableSessions();
	if (items.length === 0) {
		return;
	}
	const names = items.map((i) => i.folder.name).join(', ');
	const picked = await vscode.window.showInformationMessage(
		`이전 Claude 세션 발견: ${names}`,
		'복구',
		'무시'
	);
	if (picked === '복구') {
		launchRestoredSessions(items);
	} else if (picked === '무시') {
		discardSessionFiles(items);
	}
}

// ============================================================

function activate(context) {
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusItem.command = 'claudeCodeCompanion.projectActions';
	context.subscriptions.push(statusItem);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal(handleTerminalFocus),

		vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
			if (terminal !== vscode.window.activeTerminal) {
				return;
			}
			if (pendingReveal.has(terminal)) {
				pendingReveal.delete(terminal);
				revealCwd(terminal);
				return;
			}
			// 같은 터미널 안에서 cd로 이동한 경우
			if (config().get('explorerSync.followCd', true)) {
				revealCwd(terminal);
			}
		}),

		// 에디터 전환도 "현재 프로젝트" 판단에 반영
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.uri.scheme === 'file') {
				setCurrentProject(editor.document.uri);
			}
		}),

		vscode.commands.registerCommand('claudeCodeCompanion.toggleExplorerSync', async () => {
			const current = config().get('explorerSync.enabled', true);
			await config().update('explorerSync.enabled', !current, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`터미널-탐색기 동기화: ${!current ? '켜짐' : '꺼짐'}`);
		}),

		vscode.commands.registerCommand('claudeCodeCompanion.findInProject', findInProject),
		vscode.commands.registerCommand('claudeCodeCompanion.openFileInProject', openFileInProject),
		vscode.commands.registerCommand('claudeCodeCompanion.projectActions', projectActions),
		vscode.commands.registerCommand('claudeCodeCompanion.restoreSessions', restoreSessionsCommand)
	);

	startStopEventWatcher(context);
	promptRestoreOnStartup();

	// 확장 로드 시점의 활성 터미널/에디터를 한 번 반영
	handleTerminalFocus(vscode.window.activeTerminal);
	if (vscode.window.activeTextEditor) {
		setCurrentProject(vscode.window.activeTextEditor.document.uri);
	}
	updateStatusBar();
}

function deactivate() {}

module.exports = { activate, deactivate };
