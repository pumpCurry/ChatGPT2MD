(async () => {
    /** * ログ出力用のタグ 
     * @constant {string} 
     */
    const TAG = "[codex-export-strict]";
    
    // --- 1. Clipboard Mock ---
    // ブラウザのセキュリティ制約を回避し、コード内の writeText をフックしてデータを取得するためのモック
    const clipboardEventTarget = new EventTarget();
    Object.defineProperty(navigator, 'clipboard', {
        value: {
            /**
             * クリップボードへの書き込みを模倣し、カスタムイベントを発火させる
             * @param {string} text - 書き込まれるテキスト
             * @returns {Promise<void>}
             */
            writeText: async (text) => {
                clipboardEventTarget.dispatchEvent(new CustomEvent("codex-copy", { detail: text }));
                return Promise.resolve();
            }
        },
        configurable: true, writable: true
    });

    // --- 2. Helpers ---

    /**
     * 指定時間待機する
     * @param {number} ms - 待機時間（ミリ秒）
     * @returns {Promise<void>}
     */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /**
     * 要素からテキストを安全に取得する
     * @param {HTMLElement|null} el - 対象要素
     * @returns {string} トリム済みのテキスト、要素がない場合は空文字
     */
    const safeText = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");

    /**
     *セレクタに一致する最初の要素を取得する（例外を握り潰して安全に実行）
     * @param {string} sel - CSSセレクタ
     * @param {Document|HTMLElement} [root=document] - 検索ルート
     * @returns {HTMLElement|null}
     */
    const find = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };

    /**
     * セレクタに一致する全ての要素を配列として取得する
     * @param {string} sel - CSSセレクタ
     * @param {Document|HTMLElement} [root=document] - 検索ルート
     * @returns {HTMLElement[]}
     */
    const findAll = (sel, root = document) => { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } };

    /**
     * 人間のクリック動作（mousedown -> mouseup -> click）を模倣する
     * React などのイベントハンドラを確実に発火させるために使用
     * @param {HTMLElement} el - クリック対象の要素
     * @returns {Promise<boolean>} 成功したかどうか
     */
    const humanClick = async (el) => {
        if (!el) return false;
        try {
            el.scrollIntoView({ block: "center", inline: "nearest" });
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
            return true;
        } catch (e) { return false; }
    };

    /**
     * 開いているメニューやダイアログを閉じる
     * 安全な場所（プロジェクトタイトルなど）をクリックすることでフォーカスを外す
     * @returns {Promise<void>}
     */
    const closeAllMenus = async () => {
        const safeZone = find("h1"); // Project title usually safe to click
        if (safeZone) await humanClick(safeZone);
        await sleep(200);
    };

    /**
     * 条件が満たされるまで待機する
     * @param {Function} predicate - 真偽値を返す判定関数
     * @param {number} [timeoutMs=5000] - タイムアウト時間
     * @param {string} [desc="condition"] - ログ用の説明
     * @returns {Promise<boolean>} 条件が満たされたら true、タイムアウトなら false
     */
    const waitForCondition = (predicate, timeoutMs = 5000, desc = "condition") => {
        return new Promise((resolve) => {
            if (predicate()) return resolve(true);
            const start = Date.now();
            const timer = setInterval(() => {
                if (predicate()) {
                    clearInterval(timer);
                    resolve(true);
                }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    console.warn(TAG, `Timeout waiting for: ${desc}`);
                    resolve(false);
                }
            }, 100);
        });
    };

    /**
     * クリップボードイベント（codex-copy）の発火を待機し、データを取得する
     * @param {number} [timeoutMs=4000] 
     * @returns {Promise<string|null>} 取得したテキスト、またはタイムアウト時 null
     */
    const waitForClipboard = (timeoutMs = 4000) => {
        return new Promise((resolve) => {
            const handler = (e) => {
                const text = e.detail || "";
                clipboardEventTarget.removeEventListener("codex-copy", handler);
                resolve(text);
            };
            clipboardEventTarget.addEventListener("codex-copy", handler);
            setTimeout(() => {
                clipboardEventTarget.removeEventListener("codex-copy", handler);
                resolve(null);
            }, timeoutMs);
        });
    };

    /**
     * 取得したパッチの内容が期待するファイルパスのものか検証する
     * @param {string} patchText - クリップボードから取得したパッチテキスト
     * @param {string} expectedPath - 期待するファイルパス
     * @returns {{ok: boolean, reason?: string, found?: string}} 検証結果
     */
    const validatePatchContent = (patchText, expectedPath) => {
        if (!patchText) return { ok: false, reason: "empty" };
        const match = patchText.match(/diff --git a\/(.*?) b\//);
        if (!match) return { ok: false, reason: "no diff header" };
        const foundPath = match[1].trim();
        
        // 【修正】同名ファイル（例: updates.md と service/updates.md）の混同を防ぐため、
        // endswith 等の緩い一致ではなく、完全一致で判定する
        const isMatch = foundPath === expectedPath;
        
        return { ok: isMatch, found: foundPath };
    };

    // --- 3. Core Logic ---

    /**
     * 現在アクティブなタブパネル、またはbodyを取得する
     * @returns {HTMLElement}
     */
    const getRightPane = () => find('[role="tabpanel"][data-state="active"]') || document.body;

    /**
     * 指定されたパスのパッチ（diff）をUI操作を通じて抽出する
     * メニュー操作やDOMの状態変化待ちを含む複雑なフロー
     * @param {string} path - 対象ファイルパス
     * @param {number} [retryCount=0] - 現在のリトライ回数
     * @returns {Promise<string>} パッチテキスト、またはエラーメッセージ
     */
    const extractPatchStrict = async (path, retryCount = 0) => {
        if (retryCount > 3) return "(retry limit exceeded)";
        
        // ★重要: UIの状態をリセット（前のメニューを閉じる）
        await closeAllMenus();

        // 1. Sidebar File Click
        // ファイル名完全一致でボタンを探す
        let fileBtn = find(`button[aria-label="ファイル${path}を確認"]`);
        if (!fileBtn) {
            // フォールバック検索：aria-labelの部分一致ではなく、構造解析して完全一致を探す
            fileBtn = findAll('button[aria-label^="ファイル"]').find(b => {
                const l = b.getAttribute("aria-label");
                // 【修正】以前の includes(path) は誤爆の元なので、完全な文字列生成で比較する
                return l === `ファイル${path}を確認`;
            });
        }
        if (!fileBtn) {
            console.warn(TAG, `File button not found for path: ${path}`);
            return "(file button not found)";
        }

        await humanClick(fileBtn);
        
        // 2. Wait for Header
        // 右ペインに対象ファイルのヘッダーが表示されるのを待つ
        const rightPane = getRightPane();
        const isHeaderVisible = await waitForCondition(() => {
            // "差分を読み込む" ボタンが出ている場合は押して中身を表示させる
            const loadBtn = findAll("button", rightPane).find(b => b.textContent.includes("差分を読み込む"));
            if (loadBtn) loadBtn.click();
            
            const headers = findAll('div[data-diff-header]', rightPane);
            return headers.some(h => {
                const val = (h.getAttribute("data-diff-header") || "").trim();
                // 【修正】endsWith ではなく完全一致で判定し、同名他階層ファイルのヘッダー誤検知を防ぐ
                return val === path && h.offsetParent !== null;
            });
        }, 5000, `Header for ${path}`);

        // ヘッダーが出ない場合はリトライ
        if (!isHeaderVisible) return extractPatchStrict(path, retryCount + 1);

        await sleep(500); 

        // 3. Locate & Force Focus Header
        // 操作対象のヘッダーを特定する
        const targetHeader = findAll('div[data-diff-header]', rightPane).find(h => {
            const val = (h.getAttribute("data-diff-header") || "").trim();
            // 【修正】ここも完全一致のみ
            return val === path && h.offsetParent !== null;
        });

        if (!targetHeader) return "(header logic error)";

        // ★Focus Spam: ヘッダをクリックしてコンテキスト（アクティブな要素）を確実に切り替える
        await humanClick(targetHeader); 
        await sleep(200);

        // 4. Open Menu
        // ヘッダー内の「コピーメニューを開く」ボタンを探す
        const menuBtn = find('button[aria-label="コピーメニューを開く"]', targetHeader);
        if (!menuBtn) return "(menu button not found)";

        await humanClick(menuBtn);

        // 5. Select Item from the LAST opened menu
        // DOMの末尾に追加されるメニュー要素の中から、目的の項目を探す
        let targetItem = null;
        const menuReady = await waitForCondition(() => {
            // 全メニュー項目を取得
            const allItems = findAll('[role="menuitem"]');
            // "git apply" を含む項目を抽出
            const candidates = allItems.filter(i => safeText(i).toLowerCase().includes("git apply"));
            
            if (candidates.length === 0) return false;

            // ★最後の候補を選ぶ（これが今開いたメニューのはずであるという仮定）
            targetItem = candidates[candidates.length - 1];
            return true;
        }, 2000, "Menu item 'git apply'");

        if (!targetItem) {
            await closeAllMenus();
            return `(menu item 'git apply' not found)`;
        }

        // 6. Copy & Validate
        // クリップボードイベントを監視開始してからクリックする
        const clipboardPromise = waitForClipboard(4000);
        
        await humanClick(targetItem); // Click the LAST item found
        
        const result = await clipboardPromise;

        await closeAllMenus(); // 終わったら閉じる

        if (!result) {
            console.warn(TAG, `Null data for ${path}. Retrying...`);
            await sleep(1000);
            return extractPatchStrict(path, retryCount + 1);
        }

        // 取得内容が本当にこのファイルのものか検証
        const validation = validatePatchContent(result, path);
        if (!validation.ok) {
            console.error(TAG, `Mismatch! Target: ${path}, Got: ${validation.found}`);
            await sleep(1000);
            return extractPatchStrict(path, retryCount + 1);
        }

        return result;
    };


    // --- 4. Main Loop ---

    console.log(TAG, "Started.");
    const projName = safeText(find("h1")) || document.title;
    
    // バージョン番号の収集
    let vNums = findAll('button[aria-label^="タスクのバージョン"]').map(b => {
        return parseInt(b.getAttribute("aria-label").match(/(\d+)/)[1], 10);
    });
    vNums = [...new Set(vNums)].sort((a,b)=>a-b);
    if (vNums.length === 0) vNums = [1]; 

    // プロンプト文の抽出 (XPathを使用して特定の位置関係にあるテキストを取得)
    let promptText = "(prompt not found)";
    try {
        const promptEl = document.evaluate(
            "//button[starts-with(@aria-label,'タスクのバージョン')][1]/preceding::*[contains(@class,'whitespace-pre-wrap')][1]", 
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (promptEl) promptText = safeText(promptEl);
    } catch(e) {
        console.warn(TAG, "Prompt extraction failed", e);
    }

    // Markdownのヘッダー構築
    let md = `# Codex 結果レビュー\n- Project: ${projName}\n- Date: ${new Date().toLocaleString()}\n\n`;
    md += `## Prompt\n${promptText}\n\n`;

    // 各バージョンごとの処理
    for (const v of vNums) {
        console.log(TAG, `Processing Version ${v}...`);
        
        // バージョン切り替えボタンを押す
        const vBtn = find(`button[aria-label="タスクのバージョン${v}を確認"]`) || find(`button[aria-label="タスクのバージョン ${v} を確認"]`);
        if (vBtn) {
            await humanClick(vBtn);
            await sleep(1500); 
        }

        md += `## Version ${v}\n\n`;

        // 差分タブを選択
        const diffTab = find('button[aria-label="コード差分を確認するためのタブ"]');
        if (diffTab) await humanClick(diffTab);

        // ファイル一覧が折りたたまれていたら展開する
        const toggle = find('button[aria-label="ファイル一覧の差分表示を切り替え"]');
        if (toggle && findAll('button[aria-label$="を確認"]').length < 2) {
            await humanClick(toggle);
            await sleep(500);
        }

        // ファイル一覧の収集
        const files = [];
        const seen = new Set();
        findAll('button[aria-label^="ファイル"][aria-label$="を確認"]').forEach(b => {
            const label = b.getAttribute("aria-label");
            // ファイルパスの抽出処理
            const path = label.replace(/^ファイル/, "").replace(/を確認$/, "").trim();
            if (!seen.has(path)) {
                seen.add(path);
                const row = b.closest("li") || b.parentElement;
                let meta = "";
                if (row && row.textContent.includes("新規")) meta = " [新規]";
                files.push({path, meta});
            }
        });

        md += `### Files\n`;
        const patches = {};

        // 各ファイルのパッチ抽出
        for (const f of files) {
            md += `- ${f.path}${f.meta}\n`;
            // リトライロジックを含む厳密な抽出関数を呼び出し
            patches[f.path] = await extractPatchStrict(f.path);
            await sleep(300);
        }

        md += `\n### Patches\n`;
        for (const f of files) {
            md += `#### ${f.path}\n\`\`\`diff\n${patches[f.path]}\n\`\`\`\n\n`;
        }
    }

    // ファイルダウンロード処理
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codex_export_${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log(TAG, "Done.");
})();
