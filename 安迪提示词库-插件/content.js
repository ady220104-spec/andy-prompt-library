// 网页内脚本：① 输入框里打 "/" 弹出提示词选择；② {{变量}} 就地填空；③ Ctrl+S 把正在写的内容存进库
(function () {
  "use strict";
  if (window.__andyPromptsLoaded) return; window.__andyPromptsLoaded = true;
  var STORE_KEY = "andy-prompts-v1", SET_KEY = "andy-settings";
  var DATA = [], SET = { trigger: "double" };
  var EXT = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  // 唤起方式：double = 打 //（中文输入法下打 、、 也算）；single = 打 /；off = 关
  function normSet(s) { s = s || {}; var t = s.trigger; if (!t) t = (s.slash === false) ? "off" : "double"; return { trigger: t }; }
  // 与 background.js 的 validPrompts 对齐：旧数据/外部写坏的数据直接丢弃，
  // 否则一条 null 或非字符串正文就会让每次按键在 input 监听里抛 Uncaught TypeError（浮层永远打不开）
  function normData(a) {
    if (!Array.isArray(a)) return [];
    return a.filter(function (p) {
      return p && typeof p === "object" && typeof p.title === "string" && typeof p.content === "string";
    }).map(function (p) { if (typeof p.cat !== "string") p.cat = ""; if (typeof p.uses !== "number") p.uses = 0; if (typeof p.last !== "number") p.last = 0; return p; });
  }

  function load() {
    if (!EXT) return;
    try {
      chrome.storage.local.get([STORE_KEY, SET_KEY], function (res) {
        if (chrome.runtime.lastError || !res) return;
        DATA = normData(res[STORE_KEY]);
        SET = normSet(res[SET_KEY]);
      });
    } catch (e) {}
  }
  load();
  if (EXT) try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local") return;
      if (ch[STORE_KEY]) { DATA = normData(ch[STORE_KEY].newValue); if (P && P.mode === "list") { renderList(); place(); } if (P && P.mode !== "list") close(); }
      if (ch[SET_KEY]) { SET = normSet(ch[SET_KEY].newValue); if (SET.trigger === "off") close(); }
    });
  } catch (e) {}

  // ---- 输入框判断 ----
  function editable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") return /^(text|search|url|)$/i.test(el.getAttribute("type") || "") && !el.disabled && !el.readOnly;
    return !!el.isContentEditable;
  }
  function activeEditable() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!editable(el)) return null;
    // contenteditable 里 activeElement 是根节点；找最外层可编辑根
    if (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") { while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement; }
    return el;
  }
  function isText(el) { return el.tagName === "TEXTAREA" || el.tagName === "INPUT"; }

  // 光标前的文字：textarea 取整个 value 的光标前部分；contenteditable 只看光标所在文本节点
  function caretCtx(el) {
    if (isText(el)) {
      var s = el.selectionStart; if (typeof s !== "number") return null;
      return { kind: "v", before: (el.value || "").slice(0, s), caret: s };
    }
    var sel = window.getSelection(); if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    var n = sel.anchorNode; if (!n || !el.contains(n)) return null;
    if (n.nodeType !== 3) return { kind: "ce", node: n, before: "", caret: sel.anchorOffset };
    return { kind: "ce", node: n, before: n.textContent.slice(0, sel.anchorOffset), caret: sel.anchorOffset };
  }
  // 唤起词只在行首或空格后算数（网址里的 // 不会误弹）；唤起词后面跟的就是搜索词
  // 双斜杠模式：查询里允许出现 "/"（URL 不会误触：// 前必须是行首或空白），上限 40→200，并识别全角 ／／
  var RE_DOUBLE = /(?:^|\s)(\/\/|、、|／／)([^\n]{0,200})$/, RE_SINGLE = /(?:^|\s)(\/)([^\/\n]{0,200})$/;
  function findTrigger(before, mode) {
    var line = before, nl = line.lastIndexOf("\n"); if (nl >= 0) line = line.slice(nl + 1);
    var m = (mode === "single" ? RE_SINGLE : RE_DOUBLE).exec(line); if (!m) return null;
    var len = m[1].length + m[2].length;
    return { start: before.length - len, tok: m[1], q: m[2] };
  }

  // ---- 搜索：收藏永远最前，其余标题命中优先，再按使用次数 ----
  function score(p) { var s = (p.uses || 0) * 10; if (p.last) { var d = (Date.now() - p.last) / 86400000; s += Math.max(0, 5 - d); } return s; }
  function search(q) {
    q = q.trim().toLowerCase(); var toks = q ? q.split(/\s+/) : [], res = [];
    DATA.forEach(function (p, i) {
      var t = (p.title || "").toLowerCase(), hay = t + " " + (p.cat || "").toLowerCase() + " " + (p.content || "").toLowerCase(), tm = 0;
      for (var k = 0; k < toks.length; k++) { if (hay.indexOf(toks[k]) < 0) return; if (t.indexOf(toks[k]) >= 0) tm++; }
      res.push({ p: p, i: i, tm: tm });
    });
    res.sort(function (a, b) {
      var fa = !!(a.p.fav || a.p.pin), fb = !!(b.p.fav || b.p.pin); if (fa !== fb) return fa ? -1 : 1;
      if (b.tm !== a.tm) return b.tm - a.tm;
      var d = score(b.p) - score(a.p); if (d) return d;
      return a.i - b.i;
    });
    return res.slice(0, 8).map(function (r) { return r.p; });
  }

  // ---- 浮层 UI（shadow DOM，不受网页样式影响）----
  var F = '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  var CSS = ".box{position:fixed;box-sizing:border-box;font:13.5px/1.45 " + F + ";color:#211f1a;background:#fffdf8;border:1px solid #d9d3c4;border-radius:12px;box-shadow:0 12px 32px rgba(20,18,14,.18);overflow:hidden;z-index:2147483647}" +
    ".hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #ece7da;font-size:12px;color:#6b675d}" +
    ".logo{width:18px;height:18px;border-radius:5px;background:#c0472f;color:#fff;font-size:12px;display:inline-flex;align-items:center;justify-content:center;font-weight:600;flex:0 0 auto}" +
    ".hd .t{font-weight:600;color:#211f1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".hd .q{margin-left:auto;font-family:ui-monospace,Consolas,monospace;color:#2f6a46;white-space:nowrap}" +
    ".list{max-height:390px;overflow:auto;padding:4px}" +
    ".it{display:block;padding:6px 9px;border-radius:8px;cursor:pointer}" +
    ".it.on{background:#e3ece2;color:#1d4a30}" +
    ".it .r1{display:flex;align-items:center;gap:8px}" +
    ".it .ti{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}" +
    ".it .rc{flex:0 0 auto;font-size:11px;color:#928d82;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".it .tag{flex:0 0 auto;font-size:10.5px;line-height:16px;font-weight:500;color:#2f6a46;border:1px dashed #2f6a46;border-radius:6px;padding:0 5px;letter-spacing:.02em;white-space:nowrap}" +
    ".it .ex{font-size:11.5px;line-height:1.35;color:#928d82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}" +
    ".it.on .ex{color:#4f7a5f}" +
    ".empty{padding:14px;color:#928d82;text-align:center}" +
    ".ft{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-top:1px solid #ece7da;font-size:11px;color:#928d82}" +
    ".form{padding:10px 12px;display:grid;grid-template-columns:auto 1fr;gap:8px 10px;align-items:center;max-height:320px;overflow:auto}" +
    ".form label{font-size:12.5px;color:#6b675d;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}" +
    ".form input{box-sizing:border-box;width:100%;font:13.5px " + F + ";padding:6px 9px;border:1px solid #d9d3c4;border-radius:8px;background:#fff;color:#211f1a;outline:none}" +
    ".form input:focus{border-color:#2f6a46;box-shadow:0 0 0 3px #e3ece2}" +
    ".ok{font:12.5px " + F + ";padding:5px 12px;border-radius:7px;border:none;background:#2f6a46;color:#fff;cursor:pointer}" +
    ".toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,16px);display:flex;align-items:center;justify-content:center;gap:9px;background:#211f1a;color:#fffdf8;padding:9px 14px;border-radius:10px;font:13px " + F + ";opacity:0;transition:.18s;pointer-events:none;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.2);white-space:normal;text-align:center;max-width:min(560px,90vw);overflow-wrap:anywhere}" +
    ".toast.show{opacity:1;transform:translate(-50%,0)}" +
    ".toast .tx{min-width:0}" +
    ".toast .undo{flex:0 0 auto;font:12px " + F + ";line-height:1.5;padding:2px 9px;border-radius:7px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.9}" +
    ".toast .undo:hover{opacity:1;background:rgba(127,127,127,.22)}" +
    ".toast .undo:focus-visible{outline:2px solid currentColor;outline-offset:2px}" +
    ".toast.actionable{pointer-events:auto}" +
    "@media(prefers-color-scheme:dark){.box{background:#1e1c18;color:#ece9df;border-color:#3a362e}.hd{border-color:#2e2b25;color:#9c988c}.hd .t{color:#ece9df}.hd .q{color:#79c398}.it.on{background:#233026;color:#b7e3c6}.it .ex{color:#7c786d}.it.on .ex{color:#8fbf9f}.it .tag{color:#79c398;border-color:#79c398}.ft{border-color:#2e2b25}.form input{background:#141311;color:#ece9df;border-color:#3a362e}.toast{background:#ece9df;color:#211f1a}}";
  var host, box, toastEl, toastTx, undoBtn;
  function ui() {
    if (host) return;
    host = document.createElement("div"); host.id = "andy-prompts-host";
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;";
    var root = host.attachShadow({ mode: "open" });
    var st = document.createElement("style"); st.textContent = CSS; root.appendChild(st);
    box = document.createElement("div"); box.className = "box"; box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "安迪提示词库");
    root.appendChild(box);
    toastEl = document.createElement("div"); toastEl.className = "toast";
    toastTx = document.createElement("span"); toastTx.className = "tx";
    undoBtn = document.createElement("button"); undoBtn.type = "button"; undoBtn.className = "undo";
    undoBtn.textContent = "撤销"; undoBtn.title = "撤销这次插入"; undoBtn.hidden = true;
    undoBtn.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 别抢输入框焦点
    undoBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doUndo(); });
    toastEl.appendChild(toastTx); toastEl.appendChild(undoBtn);
    root.appendChild(toastEl);
    (document.body || document.documentElement).appendChild(host);
  }
  var flashT;
  // ---- 插入撤销：toast 里带「撤销」按钮，6 秒后自动失效 ----
  var lastUndo = null, undoTimer = null;
  function hideToastNow() {
    clearTimeout(flashT);
    if (toastEl) { toastEl.classList.remove("show"); toastEl.classList.remove("actionable"); }
    if (undoBtn) undoBtn.hidden = true;
  }
  // hide=true 时连同整条 toast 一起收起；只清状态时保留当前文案
  function clearUndo(hide) {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    lastUndo = null;
    if (toastEl) toastEl.classList.remove("actionable");
    if (undoBtn) undoBtn.hidden = true;
    if (hide) hideToastNow();
  }
  function setUndo(u) {
    clearUndo(false);
    ui();
    lastUndo = u;
    toastTx.textContent = "已插入「" + String(u.title || "").slice(0, 16) + "」";
    toastEl.classList.add("show");
    toastEl.classList.add("actionable");   // 只有这里允许鼠标点，普通提示仍 pointer-events:none
    undoBtn.hidden = false;
    clearTimeout(flashT);                  // 这条 toast 的生命周期交给 6 秒撤销窗口
    undoTimer = setTimeout(function () { clearUndo(true); }, 6000);
  }
  function flash(msg) {
    ui();
    toastTx.textContent = msg;
    toastEl.classList.remove("actionable");
    undoBtn.hidden = true;
    toastEl.classList.add("show");
    clearTimeout(flashT); flashT = setTimeout(hideToastNow, 1800);
  }
  // 撤销后只把使用次数减 1；不再发 andy-used
  function undoUsed(id) { try { chrome.runtime.sendMessage({ type: "andy-unused", id: id }, function () { void chrome.runtime.lastError; }); } catch (e) {} }
  function doUndo() {
    var u = lastUndo;
    if (!u) return;
    clearUndo(true);   // 先清状态：双击/重复点不会回滚两次
    if (u.kind === "v") {
      try {
        var el = u.el;
        var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, u.prevValue); else el.value = u.prevValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        try {
          el.focus();
          var ss = typeof u.prevSelStart === "number" ? u.prevSelStart : 0;
          var se = typeof u.prevSelEnd === "number" ? u.prevSelEnd : ss;
          el.setSelectionRange(ss, se);
        } catch (e) {}
        undoUsed(u.id);
        flash("已撤销插入");
      } catch (e) { flash("请按 Ctrl+Z 撤销"); }
      return;
    }
    // contenteditable / 富编辑器：只用浏览器原生 undo；硬删 DOM 会绕开 ProseMirror/Slate 自己的 model
    var ok = false;
    try { u.el.focus(); } catch (e) {}
    try { ok = document.execCommand("undo"); } catch (e) { ok = false; }
    if (ok) { undoUsed(u.id); flash("已撤销插入"); }
    else flash("已尝试撤销，如未恢复请在页面按 Ctrl+Z");
  }

  // ---- 浮层状态 ----
  var P = null; // {el, kind, node, start, caret, q, items, idx, mode, item, vars}
  // 一行正文摘要：去掉 markdown 标记；正文开头就是标题的不重复显示；{{占位}} 显示成 [占位]
  function excerpt(s, n, title) {
    var t = (s || "").replace(/\{\{\s*([^{}|:：\n]+?)\s*(?:[:：|][^{}\n]*?)?\s*\}\}/g, "[$1]")
      .replace(/^[ \t]*(#{1,6}|[-*>]|\d+[.、)])[ \t]+/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (title) { var tt = title.trim(); if (tt && t.indexOf(tt) === 0) t = t.slice(tt.length).replace(/^[\s:：，,。.、·|-]+/, ""); }
    return t.slice(0, n || 80);
  }
  function open(el, trig, ctx) { ui(); P = { el: el, kind: ctx.kind, node: ctx.node, start: trig.start, caret: ctx.caret, tok: trig.tok, q: trig.q, idx: 0, mode: "list" }; renderList(); place(); }
  function close() {
    if (!P) return;
    P = null;
    clearUndo(true);
    if (box) {
      var l = box.querySelector(".list"); if (l) l.removeAttribute("aria-activedescendant");
      box.hidden = true;
      box.innerHTML = "";
    }
  }
  function renderList() {
    P.items = search(P.q); if (P.idx >= P.items.length) P.idx = 0;
    box.innerHTML = "";
    var hd = document.createElement("div"); hd.className = "hd";
    hd.innerHTML = '<span class="logo">安</span><span class="t">安迪提示词库</span><span class="q"></span>';
    // 有查询时只显示 //查询（原本的逻辑）；空查询时给一句操作提示，不在同一行挤两段
    hd.querySelector(".q").textContent = P.q ? P.tok + P.q : "继续打字筛选";
    box.appendChild(hd);
    var ul = document.createElement("div"); ul.className = "list";
    ul.setAttribute("role", "listbox");
    ul.setAttribute("aria-label", "提示词结果");
    if (!P.items.length) { var em = document.createElement("div"); em.className = "empty"; em.textContent = DATA.length ? "没有匹配的提示词，打空格继续正常输入" : "库是空的，先打开侧边栏"; ul.appendChild(em); }
    P.items.forEach(function (p, i) {
      var it = document.createElement("div"); it.className = "it" + (i === P.idx ? " on" : "");
      it.id = "andy-opt-" + i;   // listbox 的 aria-activedescendant 指向它
      it.setAttribute("role", "option");
      it.setAttribute("aria-selected", i === P.idx ? "true" : "false");
      it.innerHTML = '<div class="r1"><span class="ti"></span><span class="rc"></span></div><div class="ex"></div>';
      it.querySelector(".ti").textContent = ((p.fav || p.pin) ? "★ " : "") + (p.title || "");
      var rc = it.querySelector(".rc");
      // 含 {{变量}}：分类前放一个真正的「填空」徽标（视觉同侧边栏 .chip.vars），不再靠文字前缀
      if (AndyVars.has(p.content)) {
        var tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "填空";
        tag.title = "内容里有 {{占位}}，选中后先弹填空";
        it.querySelector(".r1").insertBefore(tag, rc);
      }
      rc.textContent = (p.cat || "").split(" · ")[0];
      it.querySelector(".ex").textContent = excerpt(p.content, 90, p.title);
      it.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 别抢输入框焦点
      it.addEventListener("click", function (e) { e.preventDefault(); if (P) { P.idx = i; pick(); } });
      it.addEventListener("mousemove", function () { if (P && P.idx !== i) { P.idx = i; mark(); } });
      ul.appendChild(it);
    });
    box.appendChild(ul);
    // 当前选中项用 aria-activedescendant 暴露给读屏器；无结果时移除
    if (P.items.length) ul.setAttribute("aria-activedescendant", "andy-opt-" + P.idx);
    else ul.removeAttribute("aria-activedescendant");
    var ft = document.createElement("div"); ft.className = "ft";
    ft.textContent = P.items.length
      ? (P.items.length + " 条 · ↑↓ 选择 · Enter/Tab 插入 · Esc 关闭")
      : "0 条 · 打空格继续输入 · Esc 关闭";
    box.appendChild(ft);
    box.hidden = false;
  }
  function mark() {
    var its = box.querySelectorAll(".it");
    for (var i = 0; i < its.length; i++) {
      var on = i === P.idx;
      its[i].classList.toggle("on", on);
      its[i].setAttribute("aria-selected", on ? "true" : "false");
    }
    // 键盘/悬停改变选中项时，同步 listbox 的 aria-activedescendant
    var ul = box.querySelector(".list");
    if (ul) {
      var cur = its[P.idx];
      if (cur && cur.id) ul.setAttribute("aria-activedescendant", cur.id);
      else ul.removeAttribute("aria-activedescendant");
    }
    var onIt = its[P.idx]; if (onIt && onIt.scrollIntoView) onIt.scrollIntoView({ block: "nearest" });
  }
  function place() {
    if (!P || !box) return;
    var r = P.el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var w = Math.min(460, Math.max(300, r.width)); if (w > vw - 16) w = vw - 16;
    box.style.width = w + "px"; box.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + "px";
    var h = box.offsetHeight || 300, below = r.bottom + 6, above = r.top - 6 - h;
    if (below + h <= vh - 8 || above < 8) box.style.top = Math.min(below, Math.max(8, vh - h - 8)) + "px";
    else box.style.top = Math.max(8, above) + "px";
  }
  function pick() {
    if (!P || !P.items.length) return;
    var p = P.items[P.idx], vars = AndyVars.extract(p.content);
    if (vars.length) { P.mode = "vars"; P.item = p; P.vars = vars; renderForm(); place(); return; }
    insert(p, p.content);
  }
  function renderForm() {
    box.innerHTML = "";
    var hd = document.createElement("div"); hd.className = "hd";
    hd.innerHTML = '<span class="logo">安</span><span class="t"></span>'; hd.querySelector(".t").textContent = "填空：" + P.item.title;
    box.appendChild(hd);
    var fm = document.createElement("div"); fm.className = "form";
    P.vars.forEach(function (v, i) {
      var lb = document.createElement("label"); lb.textContent = v.name;
      var inp = document.createElement("input"); inp.type = "text"; inp.value = v.def || ""; inp.placeholder = "填 " + v.name; inp.setAttribute("data-name", v.name);
      inp.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.isComposing || e.keyCode === 229) return;   // 输入法选词的 Enter 不是提交
        if (e.key === "Enter") { e.preventDefault(); var next = fm.querySelectorAll("input")[i + 1]; if (next && !e.ctrlKey && !e.metaKey) { next.focus(); next.select(); } else submitForm(); }
        else if (e.key === "Escape") { e.preventDefault(); backToList(); }
      });
      fm.appendChild(lb); fm.appendChild(inp);
    });
    box.appendChild(fm);
    var ft = document.createElement("div"); ft.className = "ft";
    ft.innerHTML = '<span>Enter 下一项 · 最后一项 Enter 插入 · Esc 返回</span><button class="ok" type="button">插入</button>';
    ft.querySelector(".ok").addEventListener("click", submitForm);
    box.appendChild(ft);
    box.hidden = false;
    setTimeout(function () { var f = fm.querySelector("input"); if (f) { f.focus(); f.select(); } }, 0);
  }
  function submitForm() {
    if (!P || P.mode !== "vars") return;
    var map = {}; var ins = box.querySelectorAll(".form input");
    for (var i = 0; i < ins.length; i++) map[ins[i].getAttribute("data-name")] = ins[i].value;
    insert(P.item, AndyVars.fill(P.item.content, map));
  }
  function backToList() {
    if (!P) return; P.mode = "list"; P.item = null; renderList(); place();
    var el = P.el, kind = P.kind, node = P.node, caret = P.caret;
    try { el.focus(); } catch (e) {}
    try {
      if (kind === "v") el.setSelectionRange(caret, caret);
      else if (node && el.contains(node)) { var r = document.createRange(); r.setStart(node, Math.min(caret, node.nodeType === 3 ? node.textContent.length : node.childNodes.length)); r.collapse(true); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    } catch (e) {}
  }

  // ---- 插入：删掉 "/关键词"，换成提示词全文 ----
  function insert(p, text) {
    var el = P.el, kind = P.kind, node = P.node, start = P.start, caret = P.caret; close();
    try { el.focus(); } catch (e) {}
    // 焦点回来后重新定位一次触发词（编辑器可能重排过节点）
    var ctx = caretCtx(el), trig = ctx ? findTrigger(ctx.before, SET.trigger) : null;
    if (trig) { kind = ctx.kind; node = ctx.node; start = trig.start; caret = ctx.caret; }
    else {
      // 重新定位失败（编辑器重排，或填空表单把焦点带走）：只有打开浮层时记下的位置仍然指着 "//" 才继续；
      // 否则宁可提示重来，也不把提示词插到错误位置、或留下 "//关键词" 残渣
      var okPos = false;
      try {
        if (kind === "v") { var pv = el.value || ""; okPos = start >= 0 && start <= pv.length && /[\/／、]/.test(pv.charAt(start)); }
        else okPos = !!(node && node.nodeType === 3 && el.contains(node) && /[\/／、]/.test(node.textContent.charAt(start)));
      } catch (e) {}
      if (!okPos) { flash("编辑器内容刚变过，没找到 // 关键词，请重新打 // 再选一次"); return; }
    }
    var ok = false;
    if (kind === "v") {
      var v = el.value || "";
      if (start < 0 || !/[\/／、]/.test(v.charAt(start))) { flash("没找到 // 关键词，请重新打 // 再选一次"); return; }
      // 撤销用：插入前的完整值 + 选区（原值可能已被 focus/编辑器改动，这里以真正改动前为准）
      var prevValue = v, prevSelStart = el.selectionStart, prevSelEnd = el.selectionEnd;
      var nv = v.slice(0, start) + text + v.slice(caret);
      var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, nv); else el.value = nv;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
      ok = true;
    } else {
      var sel = window.getSelection();
      // 撤销用：记录插入前 el 与选区（contenteditable 只走原生 undo，这里留档便于诊断）
      var ceRange = null;
      try { if (sel && sel.rangeCount) ceRange = sel.getRangeAt(0).cloneRange(); } catch (e) {}
      try {
        if (node && node.nodeType === 3 && el.contains(node) && /[\/／、]/.test(node.textContent.charAt(start))) {
          var r = document.createRange(); r.setStart(node, start); r.setEnd(node, Math.min(caret, node.textContent.length));
          sel.removeAllRanges(); sel.addRange(r);
        } else if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
          var r2 = document.createRange(); r2.selectNodeContents(el); r2.collapse(false); sel.removeAllRanges(); sel.addRange(r2);
        }
      } catch (e) {}
      var done = false;
      try { done = document.execCommand("insertText", false, text); } catch (e) {}
      if (!done) {
        // 富编辑器（ProseMirror / Slate / Lexical / Draft）直接改 DOM 会绕开它自己的 model，
        // 轻则内容被吞/重复，重则站点报错；这类站点宁可提示去侧边栏复制
        var rich = false;
        try { rich = !!(el.closest && el.closest(".ProseMirror,[data-slate-editor],[data-lexical-editor],.DraftEditor-root")); } catch (e) {}
        if (!rich) {
          try {
            var rg = sel.getRangeAt(0); rg.deleteContents();
            var frag = document.createDocumentFragment(), lines = text.split("\n");
            lines.forEach(function (ln, i) { frag.appendChild(document.createTextNode(ln)); if (i < lines.length - 1) frag.appendChild(document.createElement("br")); });
            rg.insertNode(frag); sel.collapseToEnd();
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            done = true;
          } catch (e) {}
        }
      }
      ok = done;
    }
    if (ok) {
      used(p.id);   // 使用次数立即 +1；点撤销会再发 andy-unused 减回来
      if (kind === "v") setUndo({ kind: "v", el: el, id: p.id, title: p.title, prevValue: prevValue, prevSelStart: prevSelStart, prevSelEnd: prevSelEnd });
      else setUndo({ kind: "ce", el: el, id: p.id, title: p.title, text: text, range: ceRange });
    } else flash("插入失败，请从侧边栏复制");
  }
  function used(id) { try { chrome.runtime.sendMessage({ type: "andy-used", id: id }, function () { void chrome.runtime.lastError; }); } catch (e) {} }

  // ---- 后台提示（备份助手警告、待导入合并失败等）：后台没有界面，转发到当前页弹 toast ----
  if (EXT) try {
    chrome.runtime.onMessage.addListener(function (m) {
      if (!m || m.type !== "andy-toast" || typeof m.text !== "string" || !m.text) return;
      try { flash(m.text); } catch (e) {}
    });
  } catch (e) {}

  // ---- Ctrl+S：把输入框里正在写的内容发到侧边栏保存 ----
  // P0-1：网页里的 Ctrl+S 不带扩展用户手势，侧边栏不可能自动打开——如实说明「存了草稿，按 Alt+P 确认」
  function saveToLib(t) {
    try {
      chrome.runtime.sendMessage({ type: "andy-save", text: t, url: location.href }, function (res) {
        void chrome.runtime.lastError;
        if (!res || !res.ok) { flash("插件刚更新过，刷新本页后再试"); return; }
        flash(res.opened ? "已发到安迪提示词库 · 在右侧确认保存" : "已存为待保存草稿 · 按 Alt+P 打开侧边栏确认");
      });
    } catch (e) { flash("插件刚更新过，刷新本页后再试"); }
  }

  // ---- 事件 ----
  function onInput() {
    var el = activeEditable();
    if (!el) { if (P && P.mode === "list") close(); return; }
    if (P && P.mode === "vars") return;
    if (!P && SET.trigger === "off") return;
    var ctx = caretCtx(el), trig = ctx ? findTrigger(ctx.before, SET.trigger) : null;
    if (!trig) { if (P) close(); return; }
    if (P && P.el === el) { P.q = trig.q; P.tok = trig.tok; P.start = trig.start; P.caret = ctx.caret; P.node = ctx.node; P.kind = ctx.kind; P.idx = 0; renderList(); place(); }
    else open(el, trig, ctx);
    // 没匹配又打了空格：多半是在正常打字，收起
    if (P && !P.items.length && /\s$/.test(trig.q)) close();
  }
  document.addEventListener("input", function (e) {
    if (e.isComposing) return;   // 拼音还没上屏：不搜索、不弹层
    onInput();
  }, true);
  window.addEventListener("keydown", function (e) {
    if (e.isComposing || e.keyCode === 229) return;   // 组合中把 Enter/Esc/↑↓ 交还输入法
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "s" || e.key === "S")) {
      if (P) { e.preventDefault(); e.stopImmediatePropagation(); flash(P.mode === "vars" ? "先按 Esc 收起填空，再 Ctrl+S 保存" : "先按 Esc 关掉列表，再 Ctrl+S 保存"); return; }
      if (host && document.activeElement === host) return;
      var el = activeEditable();
      if (el) { var t = (isText(el) ? el.value : el.innerText) || ""; t = t.replace(/\r/g, "").trim();
        if (t) { e.preventDefault(); e.stopImmediatePropagation(); saveToLib(t); return; } }
    }
    if (!P) return;
    // P2-4：Esc 放在「表单模式直接 return」之前，焦点不在表单输入框（点过标题/页面抢焦点）时也能返回列表
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      if (P.mode === "vars") backToList(); else close();
      return;
    }
    if (P.mode === "vars") return;
    var k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      if (!P.items.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      P.idx = (P.idx + (k === "ArrowDown" ? 1 : P.items.length - 1)) % P.items.length; mark();
    } else if ((k === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || (k === "Tab" && !e.shiftKey)) {
      // P2-14：Shift+Tab 是反向移焦点/缩进，不能当成插入
      if (!P.items.length) { close(); return; }
      e.preventDefault(); e.stopImmediatePropagation(); pick();
    }
  }, true);
  document.addEventListener("mousedown", function (e) { if (P && host && e.target !== host && !host.contains(e.target)) close(); }, true);
  window.addEventListener("scroll", function () { if (P) place(); }, true);
  window.addEventListener("resize", function () { if (P) place(); });
})();
