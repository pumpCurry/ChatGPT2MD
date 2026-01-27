(async () => {
    const TAG = "[codex-export-last-menu]";
    
    // --- 1. Clipboard Mock ---
    const clipboardEventTarget = new EventTarget();
    Object.defineProperty(navigator, 'clipboard', {
        value: {
            writeText: async (text) => {
                clipboardEventTarget.dispatchEvent(new CustomEvent("codex-copy", { detail: text }));
                return Promise.resolve();
            }
        },
        configurable: true, writable: true
    });

    // --- 2. Helpers ---
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const safeText = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
    const find = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
    const findAll = (sel, root = document) => { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } };

    // Human Click (mousedown/up/click sequence)
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

    // Close any open menus by clicking the header title
    const closeAllMenus = async () => {
        const safeZone = find("h1"); // Project title usually safe
        if (safeZone) await humanClick(safeZone);
        await sleep(200);
    };

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

    const validatePatchContent = (patchText, expectedPath) => {
        if (!patchText) return { ok: false, reason: "empty" };
        const match = patchText.match(/diff --git a\/(.*?) b\//);
        if (!match) return { ok: false, reason: "no diff header" };
        const foundPath = match[1].trim();
        const p = expectedPath.split('/').pop();
        const isMatch = foundPath === expectedPath || foundPath.endsWith(expectedPath) || expectedPath.endsWith(foundPath);
        return { ok: isMatch, found: foundPath };
    };

    // --- 3. Core Logic ---

    const getRightPane = () => find('[role="tabpanel"][data-state="active"]') || document.body;

    const extractPatchStrict = async (path, retryCount = 0) => {
        if (retryCount > 3) return "(retry limit exceeded)";
        
        // ★重要: まず画面をきれいにする（前のメニューを閉じる）
        await closeAllMenus();

        // 1. Sidebar File Click
        let fileBtn = find(`button[aria-label="ファイル${path}を確認"]`);
        if (!fileBtn) {
            fileBtn = findAll('button[aria-label^="ファイル"]').find(b => {
                const l = b.getAttribute("aria-label");
                return l.includes(path) && l.endsWith("を確認");
            });
        }
        if (!fileBtn) return "(file button not found)";

        await humanClick(fileBtn);
        
        // 2. Wait for Header
        const rightPane = getRightPane();
        const isHeaderVisible = await waitForCondition(() => {
            const loadBtn = findAll("button", rightPane).find(b => b.textContent.includes("差分を読み込む"));
            if (loadBtn) loadBtn.click();
            const headers = findAll('div[data-diff-header]', rightPane);
            return headers.some(h => {
                const val = (h.getAttribute("data-diff-header") || "").trim();
                return (val === path || val.endsWith("/" + path)) && h.offsetParent !== null;
            });
        }, 5000, `Header for ${path}`);

        if (!isHeaderVisible) return extractPatchStrict(path, retryCount + 1);

        await sleep(500); 

        // 3. Locate & Force Focus Header
        const targetHeader = findAll('div[data-diff-header]', rightPane).find(h => {
            const val = (h.getAttribute("data-diff-header") || "").trim();
            return (val === path || val.endsWith("/" + path)) && h.offsetParent !== null;
        });

        if (!targetHeader) return "(header logic error)";

        // ★Focus Spam: ヘッダをクリックしてコンテキストを確実に切り替える
        await humanClick(targetHeader); 
        await sleep(200);

        // 4. Open Menu
        const menuBtn = find('button[aria-label="コピーメニューを開く"]', targetHeader);
        if (!menuBtn) return "(menu button not found)";

        await humanClick(menuBtn);

        // 5. Select Item from the LAST opened menu
        // ★重要: メニューは DOM の最後に追加されると仮定し、配列の最後を取得する
        let targetItem = null;
        const menuReady = await waitForCondition(() => {
            // 全メニュー項目を取得
            const allItems = findAll('[role="menuitem"]');
            // "git apply" を含む項目を抽出
            const candidates = allItems.filter(i => safeText(i).toLowerCase().includes("git apply"));
            
            if (candidates.length === 0) return false;

            // ★最後の候補を選ぶ（これが今開いたメニューのはず）
            targetItem = candidates[candidates.length - 1];
            return true;
        }, 2000, "Menu item 'git apply'");

        if (!targetItem) {
            await closeAllMenus();
            return `(menu item 'git apply' not found)`;
        }

        // 6. Copy & Validate
        const clipboardPromise = waitForClipboard(4000);
        
        await humanClick(targetItem); // Click the LAST item found
        
        const result = await clipboardPromise;

        await closeAllMenus(); // 終わったら閉じる

        if (!result) {
            console.warn(TAG, `Null data for ${path}. Retrying...`);
            await sleep(1000);
            return extractPatchStrict(path, retryCount + 1);
        }

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
    
    let vNums = findAll('button[aria-label^="タスクのバージョン"]').map(b => {
        return parseInt(b.getAttribute("aria-label").match(/(\d+)/)[1], 10);
    });
    vNums = [...new Set(vNums)].sort((a,b)=>a-b);
    if (vNums.length === 0) vNums = [1]; 

    const promptEl = document.evaluate("//button[starts-with(@aria-label,'タスクのバージョン')][1]/preceding::*[contains(@class,'whitespace-pre-wrap')][1]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    const promptText = safeText(promptEl) || "(prompt not found)";

    let md = `# Codex 結果レビュー\n- Project: ${projName}\n- Date: ${new Date().toLocaleString()}\n\n`;
    md += `## Prompt\n${promptText}\n\n`;

    for (const v of vNums) {
        console.log(TAG, `Processing Version ${v}...`);
        
        const vBtn = find(`button[aria-label="タスクのバージョン${v}を確認"]`) || find(`button[aria-label="タスクのバージョン ${v} を確認"]`);
        if (vBtn) {
            await humanClick(vBtn);
            await sleep(1500); 
        }

        md += `## Version ${v}\n\n`;

        const diffTab = find('button[aria-label="コード差分を確認するためのタブ"]');
        if (diffTab) await humanClick(diffTab);

        const toggle = find('button[aria-label="ファイル一覧の差分表示を切り替え"]');
        if (toggle && findAll('button[aria-label$="を確認"]').length < 2) {
            await humanClick(toggle);
            await sleep(500);
        }

        const files = [];
        const seen = new Set();
        findAll('button[aria-label^="ファイル"][aria-label$="を確認"]').forEach(b => {
            const label = b.getAttribute("aria-label");
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

        for (const f of files) {
            md += `- ${f.path}${f.meta}\n`;
            patches[f.path] = await extractPatchStrict(f.path);
            await sleep(300);
        }

        md += `\n### Patches\n`;
        for (const f of files) {
            md += `#### ${f.path}\n\`\`\`diff\n${patches[f.path]}\n\`\`\`\n\n`;
        }
    }

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
