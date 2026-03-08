const vscode = require('vscode');
const path = require('path');

// ========== ファイル I/O ユーティリティ ==========
async function ensureParentDir(fileUri) {
    const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
    await vscode.workspace.fs.createDirectory(dirUri);
}

async function readFileIfExists(uri) {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder('utf-8').decode(data);
    } catch {
        return null;
    }
}

function resolveEOL() {
    const cfg = vscode.workspace.getConfiguration('files');
    const eolSetting = cfg.get('eol');
    if (eolSetting === '\n' || eolSetting === '\r\n') return eolSetting;
    const active = vscode.window.activeTextEditor;
    if (active) {
        return active.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    }
    return process.platform === 'win32' ? '\r\n' : '\n';
}

// ========== カテゴリ挿入ロジック ==========
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertCategoryEntry({
    existing,
    eol,
    useDateHeader,
    dateString,
    categoryTitle,
    entryLine,
    addDivider,
    dividerText
}) {
    let text = existing ?? '';

    const ensureTrailingEol = (s) =>
        (s.endsWith('\n') || s.endsWith('\r')) ? s : (s + eol);

    // 1) スコープ決定
    let scopeStart = 0;
    let scopeEnd = text.length;

    if (useDateHeader) {
        const dateHeaderRe = new RegExp(`^##\\s+${escapeRegExp(dateString)}\\s*$`, 'm');
        let dateHeaderMatch = text.match(dateHeaderRe);

        if (!dateHeaderMatch) {
            text = ensureTrailingEol(text);
            text += `## ${dateString}${eol}`;
            dateHeaderMatch = text.match(dateHeaderRe);
        }

        const dateHeaderIndex = dateHeaderMatch.index;

        const afterDateHeaderLineEnd = (() => {
            const lineEnd = text.indexOf('\n', dateHeaderIndex);
            return lineEnd === -1 ? text.length : lineEnd + 1;
        })();

        const nextDateHeaderRe = /^##\s+/mg;
        nextDateHeaderRe.lastIndex = afterDateHeaderLineEnd;
        const nextDateHeaderMatch = nextDateHeaderRe.exec(text);

        scopeStart = afterDateHeaderLineEnd;
        scopeEnd = nextDateHeaderMatch ? nextDateHeaderMatch.index : text.length;
    }

    // 2) カテゴリ見出し検索
    const scopeText = text.slice(scopeStart, scopeEnd);
    const catHeaderLine = `### ${categoryTitle}`;
    const catHeaderRe = new RegExp(`^###\\s+${escapeRegExp(categoryTitle)}\\s*$`, 'm');
    const catHeaderMatch = scopeText.match(catHeaderRe);

    let insertionPosGlobal;
    if (catHeaderMatch) {
        const catHeaderIndexInScope = catHeaderMatch.index;

        const catHeaderLineEndInScope = (() => {
            const abs = scopeStart + catHeaderIndexInScope;
            const lineEnd = text.indexOf('\n', abs);
            return lineEnd === -1 ? text.length : lineEnd + 1;
        })();

        const nextSectionRe = useDateHeader ? /^(###|##)\s+/mg : /^###\s+/mg;
        nextSectionRe.lastIndex = catHeaderLineEndInScope;
        const nextSectionMatch = nextSectionRe.exec(text);

        insertionPosGlobal =
            (nextSectionMatch && nextSectionMatch.index < scopeEnd)
                ? nextSectionMatch.index
                : scopeEnd;

    } else {
        insertionPosGlobal = scopeEnd;

        const before = text.slice(0, insertionPosGlobal);
        const after = text.slice(insertionPosGlobal);

        const needsEol = before.length > 0 && !before.endsWith('\n') && !before.endsWith('\r');
        const catChunk = (needsEol ? eol : '') + `${catHeaderLine}${eol}`;

        text = before + catChunk + after;
        insertionPosGlobal += catChunk.length;
        scopeEnd += catChunk.length;
    }

    // 3) 追記ブロック構築
    let block = entryLine + eol;
    if (addDivider) block += `${dividerText}${eol}`;

    const beforeInsert = text.slice(0, insertionPosGlobal);
    const needsLeadingEol =
        beforeInsert.length > 0 && !beforeInsert.endsWith('\n') && !beforeInsert.endsWith('\r');
    const insertChunk = (needsLeadingEol ? eol : '') + block;

    const afterInsert = text.slice(insertionPosGlobal);
    return beforeInsert + insertChunk + afterInsert;
}

// ========== 日付 ==========
function formatNow() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    return {
        dateString: `${yyyy}-${mm}-${dd}`,
        timeString: `${hh}:${mi}`
    };
}

// ========== カテゴリ ==========
const DEFAULT_CATEGORIES = [
    'わからん🤔',
    'わかった🎉',
    'トライ💪'
];

let cachedCategories = null;

function getCategoriesFromConfig() {
    const cfg = vscode.workspace.getConfiguration('HitofudeLog');
    const cats = cfg.get('categories');
    if (Array.isArray(cats) && cats.length > 0) {
        return cats.map(String).map(s => s.trim()).filter(s => s.length > 0);
    }
    return DEFAULT_CATEGORIES;
}

function categories() {
    if (!cachedCategories) cachedCategories = getCategoriesFromConfig();
    return cachedCategories;
}

function registerConfigWatcher(context) {
    const sub = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('HitofudeLog.categories')) {
            cachedCategories = null;
        }
    });
    context.subscriptions.push(sub);
}

async function pickCategory() {
    return vscode.window.showQuickPick(categories(), {
        canPickMany: false,
        placeHolder: '追記するカテゴリを選択してください',
        ignoreFocusOut: true
    });
}

function pickTextFromSelectionOrLine(editor) {
    const sel = editor.selection;
    let selected = editor.document.getText(sel);
    if (!selected || !selected.trim()) {
        const lineText = editor.document.lineAt(sel.active.line).text;
        selected = (lineText || '').trim();
    }
    return selected || "";
}

// ========== コマンド実装 ==========
async function handleAddLike(isSend) {
    const cfg = vscode.workspace.getConfiguration('HitofudeLog');
    const targetPath = cfg.get('targetPath');
    const prependDateHeader = cfg.get('prependDateHeader', true);
    const addDivider = cfg.get('addDivider', false);
    const dividerText = cfg.get('dividerText', '---');

    if (!targetPath || typeof targetPath !== 'string' || targetPath.trim().length === 0) {
        vscode.window.showErrorMessage('設定 "HitofudeLog.targetPath" が未設定です。ユーザー設定で追記先の絶対パスを指定してください。');
        return;
    }

    // 1)カテゴリ
    const category = await pickCategory();
    if (!category) return;

    // 2)テキスト
    let initialValue = '';
    if (isSend) {
        const editor = vscode.window.activeTextEditor;
        if (editor) initialValue = pickTextFromSelectionOrLine(editor);
    }
    const input = await vscode.window.showInputBox({
        prompt: `「${category}」に追記するテキストを入力してください`,
        value: initialValue,
        ignoreFocusOut: true,
        validateInput: (val) => (val && val.trim().length > 0 ? null : '1文字以上入力してください')
    });
    if (!input) return;

    // 3)追記処理
    const { dateString, timeString } = formatNow();
    let entryLine;
    // entryLine = `* [ ] ${timeString} ${input.trim()}`;
    if (category=='わからん🤔'){
      entryLine = `* [ ] ${input.trim()}`;
    }
    else{
      entryLine = `* ${input.trim()}`;
    }
    const fileUri = vscode.Uri.file(targetPath);
    const eol = resolveEOL();

    await ensureParentDir(fileUri);
    const existing = await readFileIfExists(fileUri);

    const updated = upsertCategoryEntry({
        existing,
        eol,
        useDateHeader: !!prependDateHeader,
        dateString,
        categoryTitle: category,
        entryLine,
        addDivider: !!addDivider,
        dividerText
    });

    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(updated));

    vscode.window
      .showInformationMessage(`「${category}」に追記しました。`, '開く')
      .then(async (btn) => {
        if (btn === '開く') {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
        }
    });
}

// ========== activate / deactivate ==========
function activate(context) {
    const addCmd = vscode.commands.registerCommand('HitofudeLog.Add', async () => {
        try {
            await handleAddLike(false);
        } catch (err) {
            vscode.window.showErrorMessage(`エラー: ${String(err?.message || err)}`);
            console.error(err);
        }
    });

    const sendCmd = vscode.commands.registerCommand('HitofudeLog.Send', async () => {
        try {
            await handleAddLike(true);
        } catch (err) {
            vscode.window.showErrorMessage(`エラー: ${String(err?.message || err)}`);
            console.error(err);
        }
    });

    const openCmd = vscode.commands.registerCommand('HitofudeLog.Open', async () => {
        const cfg = vscode.workspace.getConfiguration('HitofudeLog');
        const rawPath = cfg.get('targetPath');

        if (!rawPath || typeof rawPath !== 'string') {
            vscode.window.showErrorMessage('HitofudeLog.targetPath が設定されていません。ユーザー設定で追記先の絶対パスを指定してください。');
            return;
        }

        // VS Code の API だけで URI を作る
        const fileUri = vscode.Uri.file(rawPath);

        // 親ディレクトリを作成（VS Code API）
        await ensureParentDir(fileUri);

        // ファイルが存在しなければ VS Code API で作成
        const existing = await readFileIfExists(fileUri);
        if (existing === null) {
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(''));
        }

        // 開く
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    context.subscriptions.push(addCmd, sendCmd, openCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };

