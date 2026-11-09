// 点工具栏图标 / Alt+P 直接打开侧边栏；网页右键菜单「保存到安迪提示词库」；网页脚本的消息（Ctrl+S 保存、"/" 插入计次）
var MENU_ID = "andy-save-selection";
var MENU_RETRY_ID = "andy-backup-retry";
var PENDING_KEY = "andy-pending";
var STORE_KEY = "andy-prompts-v1";
// 库的所有读改写只在此队列中执行；页面发送字段差量，不能回写陈旧全库。
var storeQueue = Promise.resolve();
function validPrompts(a) {
  return Array.isArray(a) && a.every(function(p) { return p && typeof p.title === "string" && typeof p.content === "string"; });
}
function normalizePrompts(a) {
  a.forEach(function(p) {
    if(!p.id) p.id="p"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    if(!p.cat) p.cat="未分类";
    if(typeof p.fav!=="boolean") p.fav=false;
    if(typeof p.pin!=="boolean") p.pin=false;
    if(typeof p.uses!=="number") p.uses=typeof p.usageCount==="number"?p.usageCount:0;
    if(typeof p.last!=="number") p.last=0;
  });
  return a;
}
function storeRead() { return new Promise(function(resolve,reject) {
  chrome.storage.local.get(STORE_KEY,function(r) { if(chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(r && r[STORE_KEY]); });
}); }
function storeWrite(a) { return new Promise(function(resolve,reject) {
  var o={};o[STORE_KEY]=a;chrome.storage.local.set(o,function() { if(chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(a); });
}); }
function mutateStore(op) {
  var task=storeQueue.then(async function() {
    var a=await storeRead();
    if(op.kind==="init") {
      var missing=a===undefined;
      if(missing) a=op.items;
      if(!validPrompts(a)) throw new Error("库结构错误，未修改数据");
      var before=JSON.stringify(a);
      normalizePrompts(a);
      if(missing || JSON.stringify(a)!==before) await storeWrite(a);
      return a;
    }
    // replace 是「用一份完整新库覆盖」，同时承担启动时修复脏数据的职责。
    // 所以这里必须先核对旧库未被改动、再校验新库；不能因为旧库本身脏就拒绝修复（P0-2/P0-3）。
    if(op.kind==="replace") {
      if(JSON.stringify(a)!==op.before) throw new Error("库已变化，请重新确认恢复操作");
      if(!validPrompts(op.items)) throw new Error("恢复的数据结构错误，未修改数据");
      await storeWrite(op.items);
      return op.items;
    }
    if(!validPrompts(a)) throw new Error("库不可读，未修改数据");
    if(op.kind==="used") { var p=a.find(function(p){return p&&p.id===op.id;});if(!p) throw new Error("该条目已删除");p.uses=(p.uses||0)+1;p.last=Date.now(); }
    // 网页浮层「撤销插入」：只回滚使用次数，不动 last（last 是最近使用时间，硬退回会打乱排序）
    else if(op.kind==="unused") { var un=a.find(function(p){return p&&p.id===op.id;});if(!un) throw new Error("该条目已删除");un.uses=Math.max(0,(un.uses||0)-1); }
    else if(op.kind==="delta") {
      (op.changes||[]).forEach(function(c) {
        var p=a.find(function(p){return p.id===c.id;});
        if(c.add) { if(p) throw new Error("条目编号冲突");a.unshift(c.add);return; }
        if(!p) throw new Error("该条目已删除，请保留编辑内容并重新新增");
        if(c.remove) { if(JSON.stringify(p)!==c.before) throw new Error("条目已变化，请重新确认删除");a=a.filter(function(p){return p.id!==c.id;});return; }
        Object.keys(c.fields).forEach(function(k) { if(JSON.stringify(p[k])!==JSON.stringify(c.before[k])) throw new Error("条目已在另一窗口修改，请保留编辑内容并重新核对");p[k]=c.fields[k]; });
      });
    } else if(op.kind==="merge") {
      var seen={};a.forEach(function(p){seen[p.title+"||"+p.content]=1;});
      op.items.forEach(function(p){var k=p.title+"||"+p.content;if(!seen[k]){a.push(p);seen[k]=1;}});
    } else throw new Error("未知保存操作");
    if(!validPrompts(a)) throw new Error("库结构错误，未修改数据");
    return storeWrite(a);
  });
  storeQueue=task.catch(function(){});return task;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "andy-save") {
    // 内容脚本发来的消息不带用户手势：chrome.sidePanel.open() 在 116+ 必 reject
    //（"may only be called in response to a user gesture"，实测必报），114/115 更没这个方法。
    // 所以这里只存待保存草稿，回包如实说「没打开侧边栏」；打开入口只保留自带手势的三处：
    // 工具栏点击、Alt+P 命令、右键菜单（见下面的 contextMenus.onClicked）。
    var tab = sender && sender.tab;
    var text = String(msg.text || "").replace(/\r/g, "").trim();
    if (text) {
      var o = {};
      o[PENDING_KEY] = { text: text, url: msg.url || (tab && tab.url) || "", at: Date.now() };
      try { chrome.storage.local.set(o); } catch (e) {}
      // 图标上先亮草稿数（storage.onChanged 也会触发，这里同步更新更即时）
      draftCount = 1;
      renderBadge();
    }
    sendResponse({ ok: true, opened: false });
  } else if (msg.type === "andy-backup-now") {
    // 只接受插件自己的页面（侧边栏 / 新标签页打开的 panel.html）发来的请求；网页内容脚本一律拒绝。
    // 不能只看 sender.tab：panel.html 也能在新标签页里打开，那时 sender.tab 是有的
    if (!sender || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ ok: false, err: "来源不受支持" }); return; }
    // 回包 ok 跟实际结果一致：status.ok 才算成功（status 为 null 表示空库没备份，也不该报成功）
    backupNow(function (status) { sendResponse({ ok: !!(status && status.ok), status: status }); });
    return true;
  } else if (msg.type === "andy-used" || msg.type === "andy-unused" || msg.type === "andy-mutate") {
    if(msg.type==="andy-mutate" && sender && sender.tab && !String(sender.url||"").startsWith(chrome.runtime.getURL(""))) { sendResponse({ok:false,err:"保存来源不受支持"});return; }
    // andy-used / andy-unused 沿用原来的来源处理：manifest 没有 externally_connectable，能发进来的只有本扩展的
    // content script（sender.tab 存在）和扩展页面，网页无法直接发；撤销只是把 uses 减 1，不会删数据。
    // andy-unused 允许两种来源：网页内容脚本（sender.tab 存在）和扩展页面（侧边栏/新标签页，
    // sender.url 是 chrome-extension://）。侧边栏插入后也有撤销按钮，若只认 sender.tab 会被误拒。
    if (msg.type === "andy-unused") {
      var fromContent = !!(sender && sender.tab);
      var fromExtPage = !!(sender && String(sender.url || "").startsWith(chrome.runtime.getURL("")));
      if (!fromContent && !fromExtPage) { sendResponse({ok:false,err:"来源不受支持"}); return; }
    }
    var storeOp = msg.type === "andy-used" ? {kind:"used",id:msg.id}
                : msg.type === "andy-unused" ? {kind:"unused",id:msg.id}
                : msg.op;
    mutateStore(storeOp).then(function(a){sendResponse({ok:true,items:a});},function(e){sendResponse({ok:false,err:e.message});});
    return true;
  }
});

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: MENU_ID, title: "保存到安迪提示词库", contexts: ["selection"] }, function () { void chrome.runtime.lastError; });
    // 右键工具栏图标 → 手动重试；登记修好之后不用等库变化，点一下就能把红「!」清掉
    try { chrome.contextMenus.create({ id: MENU_RETRY_ID, title: "重新备份提示词库到硬盘", contexts: ["action"] }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === MENU_RETRY_ID) { backupNow(); return; }
  if (info.menuItemId !== MENU_ID) return;
  // 先开侧边栏（必须在用户手势里同步调用），再取选中文字
  if (tab && chrome.sidePanel && chrome.sidePanel.open) {
    try { chrome.sidePanel.open({ windowId: tab.windowId }).catch(function () {}); } catch (e) {}
  }
  function save(text) {
    text = (text || "").replace(/\r/g, "").trim();
    if (!text) return;
    var o = {}; o[PENDING_KEY] = { text: text, url: (tab && tab.url) || "", at: Date.now() };
    chrome.storage.local.set(o);
  }
  // info.selectionText 会把换行压成空格；能注入脚本就从页面拿原文保留换行
  if (tab && tab.id && chrome.scripting && /^https?:/.test(tab.url || "")) {
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, func: function () { return String(window.getSelection ? window.getSelection() : ""); } },
      function (res) {
        var t = (!chrome.runtime.lastError && res && res[0] && res[0].result) || info.selectionText;
        save(t);
      }
    );
  } else {
    save(info.selectionText);
  }
});

// ---- 自动往硬盘再存一份：库有变化 3 秒后交给本机备份助手（backup-host\），写进登记时指定的备份目录 ----
// 状态分三种：
//   成功 → 清掉红「!」，标题显示条数与实际目录
//   未启用（助手没登记 / 登记里没有当前插件 ID）→ 不显示红「!」，只写 needsSetup:true，侧边栏显示「备份未启用 · 点此检查」
//   其他失败 → 红「!」，鼠标停上去看原因
var HOST = "com.andy.prompt_backup", BK_STATUS = "andy-backup-status", PROFILE_KEY = "andy-profile-id", bkT = null;
var bkRunning = false, bkAgain = false;

// 扩展实例标识：多 Chrome profile / 多 Windows 用户可能共用同一个备份目录，host 按 profile 分目录（协议 v2）。
// 首次生成 16 位小写 hex，之后一直复用；扩展只负责稳定地把它带上（分目录由 host 做）。
function newProfileId() {
  var s = "";
  try {
    var c = (typeof crypto !== "undefined" && crypto) ? crypto : (typeof self !== "undefined" && self.crypto ? self.crypto : null);
    if (c && c.getRandomValues) { var buf = new Uint8Array(8); c.getRandomValues(buf); for (var i = 0; i < 8; i++) s += ("0" + buf[i].toString(16)).slice(-2); }
  } catch (e) {}
  if (s.length !== 16) s = (Date.now().toString(16) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 16);
  return s.toLowerCase();
}
// 后台没有自己的界面：把提示发到当前标签页的内容脚本，由它弹 toast（备份助手警告、待导入合并失败等）
function toastHost(text) {
  var s = String(text || "").trim(); if (!s) return;
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
      void chrome.runtime.lastError;
      var t = tabs && tabs[0]; if (!t || typeof t.id !== "number") return;
      try { chrome.tabs.sendMessage(t.id, { type: "andy-toast", text: s }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    });
  } catch (e) {}
}
// Chrome 的原话（Failed to connect / Native host has exited…）看不出能做什么，翻成一句能照着做的提示。
// 注意区分几种完全不同的故障：
//   Specified native messaging host not found = 注册表指向的登记文件不存在（助手目录被删/从没登记），跟 Python 无关
//   forbidden = 登记还在，但 allowed_origins 里没有当前扩展 ID
//   Native host has exited / Failed to connect = 登记还在，但启动器跑不起来（多半是 Python 3 被卸载/换位置）
//   Error when communicating = host 往 stdout 多写了东西（协议污染）
//   code=backup_dir = host 明确报告备份目录不可写（盘不存在/无权限/被占用）；其他 code 见 backup-host 协议 v2
function backupErrText(raw, code) {
  var s = String(raw || "");
  if (code === "backup_dir" || /备份目录不可写|backup_dir/.test(s)) return "备份目录不可写：检查备份盘/目录是否存在且有权限，或重新运行 backup-host\\登记备份助手.ps1 指定目录";
  if (code === "not_registered") return "备份助手没登记备份目录（backup_dir.txt 缺失）：重新运行 backup-host\\登记备份助手.ps1 一次";
  if (code === "bad_profile") return "插件实例 ID 异常：重装或重新加载插件后再试一次";
  if (code === "bad_request") return "备份助手看不懂这次请求：插件和 backup-host 版本不匹配，重新运行 backup-host\\登记备份助手.ps1 更新助手";
  if (code === "empty") return "库是空的，没有可备份的数据";
  if (code === "busy") return "备份助手正忙（另一个备份还没结束），稍后会自动重试";
  if (code === "internal") return "备份助手内部出错：运行 修复备份.cmd 看自检输出";
  if (/specified native messaging host not found|native messaging host not found/i.test(s)) return "备份助手登记文件不见了：双击 修复备份.cmd（或右键 backup-host\\登记备份助手.ps1 →「使用 PowerShell 运行」）一次，再刷新插件";
  if (/forbidden|Access to the specified native messaging host/i.test(s)) return "备份助手的登记里没有当前插件 ID：插件文件夹被移动/改名后 ID 会变。运行 修复备份.cmd 会按当前目录自动重新登记";
  if (/Error when communicating/i.test(s)) return "备份助手回话格式不对（有别的程序往 stdout 写了东西）：重新运行 backup-host\\登记备份助手.ps1，或运行 修复备份.cmd 看自检输出";
  if (/Invalid native messaging host name/i.test(s)) return "备份助手的 host 名不对：应该是 com.andy.prompt_backup，重新运行 backup-host\\登记备份助手.ps1";
  if (/备份助手没有回应/.test(s)) return "备份助手没有回应：重新运行 backup-host\\登记备份助手.ps1 登记一次再点重试；还不行就运行 修复备份.cmd 看自检输出";
  if (/Failed to connect|Native host has exited|exited|terminated|crash|closed/i.test(s)) return "备份助手启动后立刻退出：多半是 Python 3 被卸载或换了位置，装好 Python 3 后运行 backup-host\\登记备份助手.ps1";
  // Python 解释器缺失只认明确的解释器报错：不能用泛化「找不到」，否则 D 盘不存在的 [WinError 3] 会被误报成装 Python（RB-04）
  if (/python was not found|Requested Python version|is not recognized as an internal or external command/i.test(s)) return "找不到 Python 3：装一个 Python 3（微软商店版也行），再运行 backup-host\\登记备份助手.ps1";
  return s || "未知原因";
}
// 只是「没登记 / 没授权」，不是数据出问题：这种情况不显示红「!」
function isSetupMissing(raw) {
  return /specified native messaging host not found|native messaging host not found|forbidden|Access to the specified native messaging host/i.test(String(raw || ""));
}
// 状态里始终带 lastOkAt/lastOkCount：失败时保留上一次成功的时间与条数，面板才能说清「从哪天开始停」
function makeStatus(prev, fields) {
  if (fields.ok) {
    fields.lastOkAt = fields.at;
    fields.lastOkCount = fields.count || 0;
    fields.needsSetup = false;
  } else {
    // 旧版本状态只有 ok/at/count（没有 lastOkAt）：上一次成功过就沿用它的时间，别让升级后的首次
    // 失败被误判成「从没成功过」（否则会错误地隐藏红「!」）
    var hadOk = !!(prev && (prev.lastOkAt || prev.ok));
    fields.lastOkAt = hadOk ? (prev.lastOkAt || prev.at || 0) : 0;
    fields.lastOkCount = hadOk ? (prev.lastOkCount != null ? prev.lastOkCount : (prev.count || 0)) : 0;
    fields.needsSetup = isSetupMissing(fields.err) && !fields.lastOkAt;
  }
  return fields;
}
// ---- 图标徽标：备份失败「!」优先，其次是 Ctrl+S 待保存草稿数 ----
// 这里维护的是模块状态，不拿 badge 文本当唯一事实（侧边栏消费 pending 时只会改 storage）
var bkBadge = "", bkTitle = "", draftCount = 0;
function draftHasText(v) { return !!(v && typeof v === "object" && String(v.text || "").trim()); }
// 备份状态 → 徽标占用（badge 为空 = 不占用徽标）
function statusBadge(st) {
  if (!st) return { badge: "", title: "" };
  if (st.ok) return { badge: "", title: "已备份 " + (st.lastOkCount || st.count || 0) + " 条" + (st.dir ? " 到 " + st.dir : "") };
  if (st.needsSetup) return { badge: "", title: "备份未启用 · 点此检查" };
  return { badge: "!", title: "硬盘备份失败（" + (st.hint || st.err || "原因见侧边栏") + "）" };
}
// 唯一的 setBadgeText 入口：备份失败 > 待保存草稿 > 清空
function renderBadge() {
  try {
    if (bkBadge === "!") {
      chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setTitle({ title: "安迪提示词库：" + (bkTitle || "硬盘备份失败") });
      return;
    }
    if (draftCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#2f6a46" });
      chrome.action.setBadgeText({ text: String(draftCount) });
      chrome.action.setTitle({ title: "安迪提示词库：有 " + draftCount + " 条待保存草稿 · 按 Alt+P 打开侧边栏确认" });
      return;
    }
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: bkTitle ? ("安迪提示词库（" + bkTitle + "）") : "安迪提示词库（点图标打开侧边栏）" });
  } catch (e) {}
}
function applyBackupBadge(st) {
  var b = statusBadge(st);
  bkBadge = b.badge;
  bkTitle = b.title;
  renderBadge();
}
// done(status)：status 为最近一次备份结果；没有数据可备份时传 null（不写状态、不覆盖上次成功记录）。
// 同一时间只跑一次；备份途中又有库变化，结束后再补跑一次，避免并发写盘。
function backupNow(done) {
  if (bkRunning) { bkAgain = true; if (done) done(null); return; }
  bkRunning = true;
  function finish(status) {
    bkRunning = false;
    if (done) done(status || null);
    if (bkAgain) { bkAgain = false; setTimeout(function () { backupNow(); }, 3000); }
  }
  chrome.storage.local.get([STORE_KEY, BK_STATUS, PROFILE_KEY], function (res) {
    var a = res && res[STORE_KEY];
    var prev = (res && res[BK_STATUS]) || null;
    // 空库：没有可写的数据；不写状态、也不覆盖上次成功记录（否则面板会把「上次成功 N 条」抹掉）
    if (!Array.isArray(a) || !a.length) { finish(null); return; }
    var profile = (res && typeof res[PROFILE_KEY] === "string") ? res[PROFILE_KEY] : "";
    if (!profile) {
      // 首次运行 / 状态被清：生成并落盘，下一次备份开始就稳定复用（host 按它分目录）
      profile = newProfileId();
      var po = {}; po[PROFILE_KEY] = profile;
      try { chrome.storage.local.set(po); } catch (e) {}
    }
    try {
      chrome.runtime.sendNativeMessage(HOST, { prompts: a, profile: profile }, function (r) {
        var lastErr = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        var code = (r && typeof r === "object" && typeof r.code === "string") ? r.code : "";
        var raw = lastErr ? lastErr : (!r ? "备份助手没有回应" : (!r.ok ? (r.err || "备份助手拒绝了这次写入") : ""));
        // 回包说成功，但条数和发出去的不一致 → 按失败处理，两个计数都写进状态（RB-19）
        if (!raw && r && typeof r.count === "number" && r.count !== a.length) raw = "备份条数不一致：发出 " + a.length + " 条，助手确认 " + r.count + " 条";
        var fields = { at: Date.now(), ok: !raw, err: raw, hint: raw ? backupErrText(raw, code) : "",
                       count: a.length, dir: (!raw && r && r.dir) || "", py: (!raw && r && r.py) || "" };
        if (r && typeof r === "object" && typeof r.count === "number") fields.hostCount = r.count;
        var status = makeStatus(prev, fields);
        var o = {}; o[BK_STATUS] = status;
        try { chrome.storage.local.set(o); } catch (e) {}
        applyBackupBadge(status);
        if (!raw) {
          handleInboxReply(r, profile);
          var notes = inboxNotices(r);
          if (notes) toastHost(notes);
        }
        finish(status);
      });
    } catch (e) {
      var st = makeStatus(prev, { at: Date.now(), ok: false, err: String((e && e.message) || e),
                                  hint: backupErrText(e && e.message, ""), count: a.length, dir: "", py: "" });
      var o2 = {}; o2[BK_STATUS] = st;
      try { chrome.storage.local.set(o2); } catch (e2) {}
      applyBackupBadge(st);
      finish(st);
    }
  });
}

// ---- 备份目录「待导入」：协议 v2 两阶段（host 先不移动文件，扩展合并成功后再 ack 让它移走）----
// 合并规则同侧边栏「导入 JSON」：标题+正文相同的跳过（天然幂等，重发不会重复入库）。
function inboxItems(items) {
  var a = [];
  (Array.isArray(items) ? items : []).forEach(function (p) {
    if (!p || typeof p !== "object") return;
    var title = String(p.title || "").trim(), content = String(p.content || "").trim();
    if (!content) return;
    a.push({ id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: title || content.slice(0, 20), content: content,
      cat: String(p.category || p.cat || "未分类").trim(), fav: !!(p.favorite || p.fav), pin: !!p.pin,
      uses: typeof p.usageCount === "number" ? p.usageCount : (p.uses || 0), last: p.last || 0 });
  });
  return a;
}
function mergeInbox(items) {
  var a = inboxItems(items);
  if (!a.length) return Promise.resolve(null);
  return mutateStore({ kind: "merge", items: a });
}
// 合并成功后告诉 host：这些文件可以移到「已导入」了（带 profile，多实例不串）
function ackInbox(names, profile) {
  var list = (Array.isArray(names) ? names : []).filter(function (n) { return typeof n === "string" && n; });
  if (!list.length) return;
  try {
    chrome.runtime.sendNativeMessage(HOST, { cmd: "ack", names: list, profile: profile || "" }, function (r) {
      if (chrome.runtime.lastError) { toastHost("待导入已合并，但通知备份助手移文件失败：" + chrome.runtime.lastError.message); return; }
      if (r && r.ok === false) { toastHost("待导入已合并，但备份助手没确认移走文件：" + (r.err || "未知原因")); return; }
      var notes = inboxNotices(r);
      if (notes) toastHost(notes);
    });
  } catch (e) { toastHost("待导入已合并，但通知备份助手移文件失败：" + ((e && e.message) || e)); }
}
// 逐文件合并；全部成功才 ack。任一文件失败就整批不 ack（文件留在待导入，下次备份 host 重发，标题+正文去重保证幂等）
function mergeInboxV2(files, profile) {
  var names = [];
  var chain = Promise.resolve();
  files.forEach(function (f) {
    names.push(String((f && f.name) || ""));
    var items = inboxItems(f && f.items);
    if (!items.length) return;
    chain = chain.then(function () { return mutateStore({ kind: "merge", items: items }); });
  });
  chain.then(function () { ackInbox(names, profile); }, function (e) {
    toastHost("待导入条目合并失败：" + ((e && e.message) || e) + " · 文件已保留，下次备份会重试");
  });
}
// host 的跳过/警告不能静默（inboxSkipped 是 [{name,size,count}]，warnings 是字符串数组）
function inboxNotices(r) {
  var notes = [];
  if (r && r.inboxSkipped) {
    var sk = r.inboxSkipped, list = Array.isArray(sk) ? sk : [sk];
    list.forEach(function (x) {
      if (x == null) return;
      if (typeof x === "object" && x.name) {
        var big = (x.count != null && x.count > 0);
        notes.push("待导入文件 " + x.name + (big ? "（" + x.count + " 条）" : "") + (big ? " 过大或条数过多，已跳过，未导入" : " 无法解析或没有有效条目，已跳过，未导入"));
      } else notes.push("待导入文件被跳过：" + String(x));
    });
  }
  if (r && r.warnings) {
    if (Array.isArray(r.warnings)) notes = notes.concat(r.warnings.map(String));
    else notes.push(String(r.warnings));
  }
  return notes.filter(function (n) { return n && String(n).trim(); }).join("；");
}
function handleInboxReply(r, profile) {
  if (!r || !Array.isArray(r.inbox) || !r.inbox.length) return;
  var v2 = Number(r.version) >= 2;
  var allFiles = v2 && r.inbox.every(function (f) { return f && Array.isArray(f.items); });
  if (allFiles) { mergeInboxV2(r.inbox, profile); return; }
  // 旧 host（扁平数组）：按旧逻辑合并，不发 ack —— 旧 host 已经在回包前把文件移到「已导入」了
  mergeInbox(r.inbox).then(null, function (e) { console.warn("导入未保存：", (e && e.message) || e); });
}
chrome.storage.onChanged.addListener(function (ch, area) {
  if (area !== "local" || !ch[STORE_KEY]) return;
  clearTimeout(bkT); bkT = setTimeout(backupNow, 3000);
});
// Ctrl+S 待保存草稿：pending 有内容 → 图标显示草稿数；侧边栏 checkPending 用 remove 消费后会走到这里自动清掉
chrome.storage.onChanged.addListener(function (ch, area) {
  if (area !== "local" || !ch[PENDING_KEY]) return;
  draftCount = draftHasText(ch[PENDING_KEY].newValue) ? 1 : 0;
  renderBadge();
});
// 注意用匿名函数包一层：onInstalled 会传 details，直接挂 backupNow 会被当成回调对象（done），
// 备份完成时调用对象直接抛 TypeError，反而在 chrome://extensions 里报红
chrome.runtime.onStartup.addListener(function () { backupNow(); });
chrome.runtime.onInstalled.addListener(function () { backupNow(); });
// service worker 每次被唤醒（点图标开侧边栏、网页里 Ctrl+S 等）时，若上一次备份是失败的，自动再试一次：
// 把备份助手修好之后，红「!」不用等库变化，自己就会消失
chrome.storage.local.get([PENDING_KEY, BK_STATUS], function (res) {
  var st = res && res[BK_STATUS];
  // service worker 可能刚被重启：先从存储恢复「草稿徽标 / 备份失败徽标」，否则图标会白着、草稿提醒丢失
  draftCount = draftHasText(res && res[PENDING_KEY]) ? 1 : 0;
  var b = statusBadge(st || null);
  bkBadge = b.badge;
  bkTitle = b.title;
  renderBadge();
  // 上次失败过 → 每次被唤醒都自动再试一次，修好登记后红「!」会自己消失；
  // 从没备份过（新装 / 状态被清）也补一次，让「已备份」状态从第一天就准确。
  // needsSetup = 助手根本没登记：不再每次唤醒都 spawn 一次宿主，等用户点「点此检查」或装好助手后由库变化触发。
  if (!st || (st.ok === false && st.needsSetup !== true)) backupNow();
});
