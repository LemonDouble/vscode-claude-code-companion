const vscode = require('vscode');

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
		vscode.commands.registerCommand('claudeCodeCompanion.projectActions', projectActions)
	);

	// 확장 로드 시점의 활성 터미널/에디터를 한 번 반영
	handleTerminalFocus(vscode.window.activeTerminal);
	if (vscode.window.activeTextEditor) {
		setCurrentProject(vscode.window.activeTextEditor.document.uri);
	}
	updateStatusBar();
}

function deactivate() {}

module.exports = { activate, deactivate };
