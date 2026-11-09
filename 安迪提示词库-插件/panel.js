(function(){
  "use strict";
  // 数据存在 chrome.storage.local（浏览器本地，不上传）；首次安装用 seed.json 灌入内置提示词。
  var DEFAULT = [];
  var ORDER = ["A股内容创作","股民私聊 · 转化","内容创作 · 运营","生图 · 海报 · 信息图","照片处理","网页 · UI 设计","代码 · 工程","技能 · 自动化","通用协作 · 执行纪律","复盘 · 记忆 · 上下文","规划 · 效率","片段 · 原则","未分类"];
  var STORE_KEY="andy-prompts-v1";
  // 视图：统一用 820px 断点（与 CSS 保持一致）。窄侧栏强制紧凑列表，宽屏才按用户偏好（qm-view）走。
  var NARROW_MQ = window.matchMedia ? window.matchMedia("(max-width:820px)") : null;
  function isNarrow(){ return NARROW_MQ ? NARROW_MQ.matches : window.innerWidth<=820; }
  var prefView="card";
  try{var sv=localStorage.getItem("qm-view"); if(sv==="compact"||sv==="card") prefView=sv;}catch(e){}
  function currentView(){ return isNarrow() ? "compact" : prefView; }
  var state={cat:"__all__",q:"",sort:"smart",view:currentView(),kbIdx:0}; // 排序固定：收藏置顶，其余越常用越靠前
  function applyView(){ state.view=currentView(); }
  var DATA=[];
  var lastSaved="";
  // 根数据不是数组：保留原始值，渲染错误态卡片；绝不自动覆盖，给用户导出 / 两段式恢复的出口
  var corruptMode=false, corruptRaw=null;

  function uid(){return "p"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
  function clone(o){return JSON.parse(JSON.stringify(o));}
  // 归一化：旧数据/外部导入可能缺 id、字段类型不对，甚至混入 null / 字符串 / 数组。
  // stats 可选：boot 用它算出「结构上真正被修正了多少条、丢弃了多少条无效元素」，用于判断要不要写回、toast 报真实条数。
  function ensureIds(a,stats){
    if(!Array.isArray(a)) return [];
    return a.filter(function(p){
      if(p && typeof p==="object" && !Array.isArray(p)) return true;
      if(stats) stats.dropped=(stats.dropped||0)+1;
      return false;
    }).map(function(p){
      var before=""; if(stats){ try{ before=JSON.stringify(p); }catch(e){} }
      // 标题/正文强制成字符串：旧数据或外部导入里出现数字/null 时，渲染层 (s||"").replace / p.content.length 会直接抛错
      p.title = typeof p.title==="string" ? p.title : String(p.title==null?"":p.title);
      p.content = typeof p.content==="string" ? p.content : String(p.content==null?"":p.content);
      if(!p.id)p.id=uid();
      p.cat = typeof p.cat==="string" ? p.cat : (p.cat==null ? "" : String(p.cat));
      if(!p.cat)p.cat="未分类";
      if(typeof p.fav!=="boolean")p.fav=false;
      if(typeof p.pin!=="boolean")p.pin=false;
      if(typeof p.uses!=="number"||!isFinite(p.uses))p.uses=(typeof p.usageCount==="number"?p.usageCount:0);
      if(typeof p.last!=="number"||!isFinite(p.last))p.last=0;
      if(stats){ try{ if(before!==JSON.stringify(p)) stats.items=(stats.items||0)+1; }catch(e){} }
      return p;
    });
  }
  function find(id){for(var i=0;i<DATA.length;i++)if(DATA[i]&&DATA[i].id===id)return DATA[i];return null;}

  // ---- 存取 ----
  var EXT = typeof chrome!=="undefined" && chrome.storage && chrome.storage.local; // 非插件环境（直接开 html 调试）退回 localStorage
  var ready=false; // boot 完成前忽略 storage 变化事件，避免空列表先闪一下
  function seedUrl(){ return EXT&&chrome.runtime&&chrome.runtime.getURL ? chrome.runtime.getURL("seed.json") : "seed.json"; }
  function loadSeed(){
    return fetch(seedUrl(),{cache:"no-store"}).then(function(r){return r.json();})
      .then(function(a){ DEFAULT = Array.isArray(a)?a:[]; })
      .catch(function(e){ DEFAULT=[]; console.warn("内置提示词 seed.json 加载失败：",e); });
  }
  function storeGet(cb){
    if(EXT){
      try{
        chrome.storage.local.get(STORE_KEY,function(res){
          var last=""; try{ last=chrome.runtime.lastError?(chrome.runtime.lastError.message||"未知错误"):""; }catch(e){ last=String(e&&e.message||e); }
          if(last){ toastError("读取失败："+last); cb(undefined); return; }
          cb(res&&res[STORE_KEY]);
        });
      }catch(e){ toastError("读取失败："+String(e&&e.message||e)); cb(undefined); }
    }
    else {
      var raw=null; try{ raw=localStorage.getItem(STORE_KEY); }catch(e){}
      if(raw===null||raw===undefined){ cb(undefined); return; } // 本地调试时「没有 key」等同于首次安装
      var a; try{ a=JSON.parse(raw); }catch(e){ a=String(raw); } // 坏 JSON 也算异常根数据，交给错误态卡片自救
      cb(a);
    }
  }
  // 一次性修数据：老 seed 里「比例 {{16:9/3:4/9:16}}」会被 {{变量}} 解析器当成变量名「16」，
  // 插入后正文变成「9/3:4/9:16」，丢掉开头的 16。把库里残存的坏写法换成 {{比例:16:9/3:4/9:16}}，只改这一处字面量。
  // 只在内存里改并返回真实修正条数；是否写回、写回成功后写标记，全部由 boot 统一决定。
  var FIX_RATIO_KEY="andy-fix-ratio-var";
  var RATIO_BAD="{{16:9/3:4/9:16}}", RATIO_GOOD="{{比例:16:9/3:4/9:16}}";
  function fixBrokenVar(a){
    var n=0;
    (Array.isArray(a)?a:[]).forEach(function(p){
      if(p&&typeof p==="object"&&typeof p.content==="string"&&p.content.indexOf(RATIO_BAD)>=0){ p.content=p.content.split(RATIO_BAD).join(RATIO_GOOD); n++; }
    });
    return n;
  }
  function markFixDone(){
    if(!EXT) return;
    var o={}; o[FIX_RATIO_KEY]=1;
    try{ chrome.storage.local.set(o,function(){ void chrome.runtime.lastError; }); }catch(e){}
  }
  // 启动：有库就直接用本地数据；只有真·首次安装（storage 里没有 key）才让后台用 seed 初始化。
  // 数组先归一化（ensureIds）+ 内存迁移（fixBrokenVar），只有和原始 JSON 不一致才用 replace 一次性写回；
  // 写回成功才写 FIX 标记；失败不写标记、toast 错误，但照样渲染修正后的数据，让用户能先导出。
  function boot(cb){
    loadSeed().then(function(){
      storeGet(function(a){
        if(!EXT){
          if(Array.isArray(a)){ DATA=ensureIds(a); fixBrokenVar(DATA); lastSaved=JSON.stringify(DATA); ready=true; cb(DATA); }
          else if(a===undefined){ DATA=ensureIds(clone(DEFAULT)); lastSaved=JSON.stringify(DATA); persist(function(){ ready=true; cb(DATA); }); }
          else { corruptMode=true; corruptRaw=a; DATA=[]; lastSaved=""; ready=true; cb(DATA); }
          return;
        }
        if(a===undefined){ sendMutation({kind:"init",items:clone(DEFAULT)},function(){ ready=true; cb(DATA); }); return; }
        if(!Array.isArray(a)){ corruptMode=true; corruptRaw=a; DATA=[]; lastSaved=""; ready=true; cb(DATA); return; }
        var rawJson="";
        try{ rawJson=JSON.stringify(a)||""; }catch(e){ rawJson=""; }
        var stats={items:0,dropped:0};
        DATA=ensureIds(a,stats);
        afterNormalize(rawJson,stats,cb);
      });
    }).catch(function(e){ console.warn("启动失败：",e); ready=true; cb(DATA); });
  }
  function afterNormalize(rawJson,stats,cb){
    chrome.storage.local.get(FIX_RATIO_KEY,function(res){
      var marker=!!(res&&res[FIX_RATIO_KEY]);
      // 不因为 marker 已存在就跳过：旧版本曾经「先写 marker 后保存」，marker 在而正文仍是坏写法的情况
      // 会永久卡住（R-05）。这就一次纯内存扫描，成本极低；storage 已经修过时 fixed 自然为 0。
      var fixed=0;
      try{ fixed=fixBrokenVar(DATA); }catch(e){ fixed=0; }
      var norm=""; try{ norm=JSON.stringify(DATA); }catch(e){ norm=""; }
      lastSaved=norm||"[]"; // lastSaved 必须是归一化后的形状，否则后续 delta 会继续产生假冲突
      if(!rawJson||!norm||norm===rawJson){ ready=true; cb(DATA); return; } // 没有需要写回的修正
      sendMutation({kind:"replace",before:rawJson,items:DATA},function(err){
        if(err){
          // 不写标记：下次启动会重试。数据已在内存里修好，渲染出去让用户先导出备份。
          toastError("提示词库自动修复未能保存："+((err&&err.message)||err)+"；已按修复后的数据显示，建议先导出备份",7200);
          ready=true; cb(DATA); return;
        }
        if(!marker) markFixDone();
        var parts=[];
        if(stats&&stats.items) parts.push("结构 "+stats.items+" 条");
        if(fixed) parts.push("{{比例}} "+fixed+" 条");
        if(stats&&stats.dropped) parts.push("移除无效记录 "+stats.dropped+" 条");
        toast("已自动修复提示词库"+(parts.length?("（"+parts.join("、")+"）"):""),3600);
        ready=true; cb(DATA);
      });
    });
  }
  // 失败也必须回调 cb(err)：以前直接 return，boot 的 render 永远不执行，侧边栏会空白且没有自救入口
  function sendMutation(op,cb){
    function handle(r,thrown){
      var err = thrown ? String((thrown&&thrown.message)||thrown) : "";
      if(!err){ try{ err = chrome.runtime.lastError ? (chrome.runtime.lastError.message||"扩展上下文已失效，请刷新插件") : ""; }catch(e){ err=String(e&&e.message||e); } }
      if(!err && (!r||!r.ok)) err=(r&&r.err)||"保存失败";
      if(err){
        toastError(/上下文|context|invalidated/i.test(err) ? "插件已更新，请关掉侧边栏重新打开" : err, /上下文|context|invalidated/i.test(err)?9000:6500);
        storeGet(function(a){ if(Array.isArray(a)){DATA=ensureIds(a);lastSaved=JSON.stringify(DATA);} ready=true; render(); if(cb)cb(new Error(err)); });
        return;
      }
      DATA=ensureIds(r.items);lastSaved=JSON.stringify(DATA);ready=true;render();if(cb)cb(null);
    }
    try{ chrome.runtime.sendMessage({type:"andy-mutate",op:op},function(r){ handle(r); }); }
    catch(e){ handle(null,e); }
  }
  function persist(cb,before,replace,onErr){
    // 老数据里可能混入 null / 字符串 / 数组（外部导入、旧版本、手工改 storage）：
    // 不过滤的话 old.find / old.forEach 会同步抛 TypeError，保存/收藏/删除全部静默失效。
    function safeOld(){
      if(Array.isArray(before)) return before;
      try{ var v=JSON.parse(lastSaved||"[]"); return Array.isArray(v)?v:[]; }catch(e){ return []; }
    }
    var old=safeOld().filter(function(p){return p&&typeof p==="object"&&!Array.isArray(p);});
    var s=""; try{ s=JSON.stringify(DATA); }catch(e){ s="[]"; }
    var changes=[];
    if(EXT){
      DATA.forEach(function(p){
        if(!p||typeof p!=="object"||Array.isArray(p)) return;
        var prev=old.find(function(x){return x&&x.id===p.id;});
        if(!prev){changes.push({id:p.id,add:p});return;}
        var fields={},expected={};Object.keys(p).forEach(function(k){if(JSON.stringify(p[k])!==JSON.stringify(prev[k])){fields[k]=p[k];expected[k]=prev[k];}});
        if(Object.keys(fields).length)changes.push({id:p.id,fields:fields,before:expected});
      });
      old.forEach(function(p){ if(!p||typeof p!=="object") return; if(!find(p.id))changes.push({id:p.id,remove:true,before:JSON.stringify(p)}); });
      lastSaved=s;sendMutation(replace?{kind:"replace",before:JSON.stringify(old),items:DATA}:{kind:"delta",changes:changes},
        (cb||onErr)?function(err){ if(!err){ if(cb)cb(); } else if(onErr){ onErr(err); } }:undefined);
    } else {try{localStorage.setItem(STORE_KEY,s);lastSaved=s;if(cb)cb();}catch(e){ var er=new Error("保存失败"); if(onErr)onErr(er); else toastError("保存失败"); }}
  }
  // 侧边栏和标签页同时开着时，一边改了另一边跟着刷新
  if(EXT) chrome.storage.onChanged.addListener(function(ch,area){
    if(!ready) return;
    if(area!=="local"||!ch[STORE_KEY]) return;
    var nv=ch[STORE_KEY].newValue; if(!Array.isArray(nv)) return;
    var s=JSON.stringify(nv); if(s===lastSaved) return;
    lastSaved=s; DATA=ensureIds(nv); render();
  });

  // theme：跟随系统 / 浅色 / 深色 三态（system 时移除 data-theme，让 CSS prefers-color-scheme 生效）
  var root=document.documentElement;
  var THEME_KEY="qm-theme", themePref="system";
  function themeText(){
    return "外观："+(themePref==="light"?"浅色":themePref==="dark"?"深色":"跟随系统");
  }
  function renderThemeLbl(){
    var el=document.getElementById("themeLbl"); if(el) el.textContent=themeText();
    var btn=document.getElementById("theme"); if(btn) btn.title=themeText()+" · 点击切换（跟随系统 / 浅色 / 深色）";
  }
  function applyTheme(pref,persist){
    themePref=(pref==="light"||pref==="dark")?pref:"system";
    try{
      if(themePref==="system") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme",themePref);
    }catch(e){}
    if(persist){ try{ localStorage.setItem(THEME_KEY,themePref); }catch(e){} }
    renderThemeLbl();
  }
  var savedTheme=null; try{ savedTheme=localStorage.getItem(THEME_KEY); }catch(e){}
  applyTheme(savedTheme==="light"||savedTheme==="dark"?savedTheme:"system",false);
  document.getElementById("theme").addEventListener("click",function(){
    toggleMenu(false);
    var next={system:"light",light:"dark",dark:"system"}[themePref]||"system";
    applyTheme(next,true);
  });

  // ---- helpers ----
  function escapeHtml(s){return String(s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  function highlight(text,q){
    if(!q) return escapeHtml(text);
    var i=text.toLowerCase().indexOf(q.toLowerCase()); if(i<0) return escapeHtml(text);
    return escapeHtml(text.slice(0,i))+'<mark style="background:var(--accent-soft);color:var(--accent-ink);border-radius:3px;padding:0 1px">'+escapeHtml(text.slice(i,i+q.length))+'</mark>'+escapeHtml(text.slice(i+q.length));
  }
  function catOrder(counts){
    var cats=ORDER.filter(function(c){return counts[c];});
    Object.keys(counts).forEach(function(c){if(ORDER.indexOf(c)<0)cats.push(c);});
    return cats;
  }
  // 紧凑行右侧小字：分类取第一段（"网页 · UI 设计"→"网页"），给标题留够位置
  function rowSub(p){ var c=(p.cat||"").split(" · ")[0]; return c+(p.uses?"·"+p.uses+"次":""); }
  // 正文摘要：一行灰字，让人不用点开就知道这条是干什么的；{{占位}} 显示成 [占位]
  function excerpt(s,n,title){
    var t=(s||"").replace(/\{\{\s*([^{}|:：\n]+?)\s*(?:[:：|][^{}\n]*?)?\s*\}\}/g,"[$1]")
      .replace(/^[ \t]*(#{1,6}|[-*>]|\d+[.、)])[ \t]+/gm,"").replace(/\*\*/g,"").replace(/\s+/g," ").trim();
    if(title){ var tt=title.trim(); if(tt&&t.indexOf(tt)===0) t=t.slice(tt.length).replace(/^[\s:：，,。.、·|-]+/,""); } // 正文开头就是标题的，不重复显示
    return t.slice(0,n||90);
  }
  function fmtWhen(ts){
    // 备份状态里的 at 可能是字符串/undefined/NaN：非数字一律返回空串，避免出现「NaN 个月前」
    var n=typeof ts==="number"?ts:Number(ts);
    if(ts===null||ts===undefined||ts===""||!isFinite(n)||n<=0) return "";
    var d=Math.floor((Date.now()-n)/1000);
    if(d<0) return "刚刚";
    if(d<60) return "刚刚"; if(d<3600) return Math.floor(d/60)+" 分钟前";
    if(d<86400) return Math.floor(d/3600)+" 小时前";
    var days=Math.floor(d/86400); if(days<30) return days+" 天前";
    return Math.floor(days/30)+" 个月前";
  }

  // ---- 智能识别：标题 & 分类（离线启发式）----
  function smartTitle(content){
    var text=String(content==null?"":content).replace(/\r/g,"").trim(); if(!text) return "";
    var segs=text.split(/[\n。！？!?]+/).map(function(s){return s.trim();}).filter(Boolean);
    if(!segs.length) return ""; // 纯标点（！！!、。。。）：交给调用方用正文开头兜底，绝不能抛 TypeError
    var roleRe=/^(你是|您是|你将|你会|作为|扮演|假设你|请扮演|as an?\b|you are|i want you|system[:：])/i;
    var pick="";
    for(var i=0;i<segs.length;i++){ if(segs[i]&&!roleRe.test(segs[i])){pick=segs[i];break;} }
    if(!pick) pick=segs[0]||"";
    if(!pick) return "";
    pick=pick.replace(/^[#>\-\*\d\.\s、，：:）\)]+/,"");
    pick=pick.replace(/^(请你?|帮我|帮忙|我需要你?|需要你?|麻烦你?|现在|来)+/,"");
    pick=pick.replace(/[，,、；;：:].*$/,"");
    pick=pick.trim();
    if(pick.length>18) pick=pick.slice(0,18);
    if(!pick) pick=(segs[0]||"").slice(0,16);
    return pick;
  }
  var CAT_KW=[
    ["A股内容创作",["a股","牛股","涨停","龙虎榜","大盘","个股","板块","财经","百家号","题材","主力","资金","k线","研报","盘面","炒股","简报"]],
    ["股民私聊 · 转化",["私域","私聊","微信","加粉","引流","转化","成交","朋友圈","社群","话术","客户","粉丝","变现","付费","咨询","股民"]],
    ["内容创作 · 运营",["文章","标题","文案","爆款","公众号","小红书","选题","润色","改写","口播","脚本","运营","涨粉"]],
    ["生图 · 海报 · 信息图",["生图","出图","海报","封面","配图","插画","信息图","视觉","画面","midjourney","stable diffusion","文生图","banner","主图","构图"]],
    ["照片处理",["修图","精修","照片","人像","磨皮","调色","抠图","美颜","retouch","后期","瑕疵","肤色","液化"]],
    ["网页 · UI 设计",["网页","页面","落地页","前端","布局","组件","tailwind","css","html","设计稿","h5","交互","视觉稿","官网","ui"]],
    ["代码 · 工程",["代码","函数","bug","重构","脚本","报错","调试","git","工程","review","接口","部署","单元测试","编译","算法"]],
    ["技能 · 自动化",["skill","技能","自动化","计划任务","定时","批量","工作流","钩子","hook","mcp"]],
    ["通用协作 · 执行纪律",["执行","纪律","验收","证据","不要假设","先确认","检查","任务理解","执行计划","子代理","codex","claude code"]],
    ["复盘 · 记忆 · 上下文",["复盘","上下文","记忆","交接","handoff","context","会话","总结经验","背景设定","偏好"]],
    ["规划 · 效率",["规划","提效","效率","优先级","计划","目标","拆解","时间","流程"]],
    ["片段 · 原则",["原则","准则","规范","口诀","要点","checklist","清单"]]
  ];
  function guessCat(content){
    var t=(content||"").toLowerCase(); if(!t) return "";
    var best="",bestN=0;
    CAT_KW.forEach(function(pair){
      var n=0; pair[1].forEach(function(kw){ if(t.indexOf(kw)>=0) n++; });
      if(n>bestN){bestN=n;best=pair[0];}
    });
    return bestN>0?best:"";
  }

  // ---- 排序 ----
  // 收藏 = 一个概念（旧数据的 fav / pin 都算收藏），永远排最前；其余按使用次数，次数相同最近用过的靠前
  function isFav(p){ return !!(p.fav||p.pin); }
  function score(p){
    var s=(p.uses||0)*10;
    if(p.last){ var days=(Date.now()-p.last)/86400000; s += Math.max(0, 5-days); }
    return s;
  }
  function sortList(list){
    var idx={}; DATA.forEach(function(p,i){idx[p.id]=i;});
    var mode=state.sort;
    return list.slice().sort(function(a,b){
      var fa=isFav(a),fb=isFav(b); if(fa!==fb) return fa?-1:1;
      if(mode==="used"){ if((b.uses||0)!==(a.uses||0)) return (b.uses||0)-(a.uses||0); }
      else if(mode==="recent"){ if((b.last||0)!==(a.last||0)) return (b.last||0)-(a.last||0); }
      else if(mode==="added"){ return idx[a.id]-idx[b.id]; }
      else { var d=score(b)-score(a); if(d) return d; }
      return idx[a.id]-idx[b.id];
    });
  }

  // ---- toast ----
  var toastT, toastErrT;
  var toastActionEl=document.getElementById("toastAction");
  function hideToastAction(){
    if(!toastActionEl) return;
    toastActionEl.hidden=true; toastActionEl.onclick=null; toastActionEl.textContent="";
  }
  // action 可选：{label:"撤销", onClick:fn}；按钮随 toast 到期自动失效，点击后先清按钮防重复
  function toast(msg,ms,action){
    var t=document.getElementById("toast"); document.getElementById("toastMsg").textContent=msg||"已复制到剪贴板";
    if(toastActionEl){
      if(action&&action.onClick){
        toastActionEl.hidden=false;
        toastActionEl.textContent=action.label||"操作";
        toastActionEl.onclick=function(e){
          if(e&&e.stopPropagation) e.stopPropagation();
          hideToastAction();
          try{ action.onClick(); }catch(err){}
        };
      } else { hideToastAction(); }
    }
    t.classList.add("show"); clearTimeout(toastT);
    var dur=ms||1600;
    toastT=setTimeout(function(){ t.classList.remove("show"); hideToastAction(); },dur);
  }
  // 独立错误条：与普通 toast 完全隔离（成功提示不会清掉/覆盖错误；新错误替换旧错误）
  function toastError(msg,ms){
    var box=document.getElementById("toastError"); if(!box) return;
    var m=document.getElementById("toastErrorMsg"); if(m) m.textContent=msg||"操作失败";
    box.hidden=false; box.classList.add("show");
    clearTimeout(toastErrT);
    toastErrT=setTimeout(function(){ box.classList.remove("show"); box.hidden=true; }, ms||6500);
  }
  function isIme(e){ return !!(e&&(e.isComposing||e.keyCode===229||e.which===229)); }

  // ---- copy（记录使用频率，不整屏重排以免卡片跳动）----
  function copyText(txt,btn,p,msg){
    function ok(){
      if(btn){btn.classList.add("done");var s=btn.querySelector("span"),old=s?s.textContent:"";if(s)s.textContent="已复制";
        setTimeout(function(){btn.classList.remove("done");if(s)s.textContent=old;},1400);}
      toast(msg||"已复制 · 已计入常用");
      if(p) countUse(p);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(ok).catch(function(){fb(txt,ok);});}
    else fb(txt,ok);
  }
  function fb(txt,ok){var ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.top="-1000px";
    document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand("copy");ok();}catch(e){toast("复制失败，请手动选择");}document.body.removeChild(ta);}
  function markUsed(p){
    var card=document.querySelector('.card[data-id="'+p.id+'"]'); if(!card) return;
    var rc=card.querySelector('.rc'); if(rc) rc.textContent=rowSub(p);
    var meta=card.querySelector('.card-meta'); if(!meta) return;
    meta.classList.remove("empty");
    var u=meta.querySelector('.uses'); if(u)u.textContent="用过 "+p.uses+" 次";
    var w=meta.querySelector('.when'); if(w)w.textContent=fmtWhen(p.last);
  }
  function countUse(p){ if(EXT){sendMutation({kind:"used",id:p.id},function(err){if(!err)markUsed(find(p.id)||p);});}else{p.uses=(p.uses||0)+1;p.last=Date.now();persist();markUsed(p);} }

  // ---- 直接插入到当前网页的输入框（ChatGPT / Claude / DeepSeek / 豆包 / Kimi …）----
  // 这段函数会被注入到网页里执行，必须自包含、不引用外部变量
  function injectInsert(text){
    function visible(el){ if(!el) return false; var r=el.getBoundingClientRect(); if(r.width<40||r.height<14) return false; var cs=getComputedStyle(el); return cs.visibility!=="hidden"&&cs.display!=="none"; }
    function editable(el){ if(!el||el===document.body||el===document.documentElement) return false; var tag=el.tagName;
      if(tag==="TEXTAREA") return !el.disabled&&!el.readOnly;
      if(tag==="INPUT") return /^(text|search|url|)$/i.test(el.getAttribute("type")||"")&&!el.disabled&&!el.readOnly;
      return !!el.isContentEditable; }
    var el=document.activeElement;
    while(el&&el.shadowRoot&&el.shadowRoot.activeElement) el=el.shadowRoot.activeElement;
    if(!editable(el)||!visible(el)){
      var sels=['#prompt-textarea','.ProseMirror[contenteditable="true"]','textarea','[contenteditable="true"]','[contenteditable=""]','[contenteditable="plaintext-only"]','[role="textbox"]'];
      var found=null;
      for(var i=0;i<sels.length&&!found;i++){ var list=document.querySelectorAll(sels[i]);
        for(var j=list.length-1;j>=0;j--){ if(editable(list[j])&&visible(list[j])){found=list[j];break;} } }
      el=found;
    }
    if(!el) return {ok:false,reason:"noinput"};
    try{window.focus();}catch(e){}
    try{el.focus();}catch(e){}
    var tag=el.tagName;
    if(tag==="TEXTAREA"||tag==="INPUT"){
      var v=el.value||"", s=el.selectionStart, e2=el.selectionEnd;
      if(typeof s!=="number"){s=v.length;e2=v.length;}
      // 撤销凭证：临时属性 + 原值/原选区；10 秒后自动移除，避免长期挂在页面上
      var key=String(Date.now().toString(36)+Math.random().toString(36).slice(2,10)).replace(/[^a-zA-Z0-9]/g,"");
      try{ el.setAttribute("data-andy-undo",key); }catch(e){}
      var nv=v.slice(0,s)+text+v.slice(e2);
      var proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      var desc=Object.getOwnPropertyDescriptor(proto,"value");
      if(desc&&desc.set) desc.set.call(el,nv); else el.value=nv;
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
      try{el.setSelectionRange(s+text.length,s+text.length);}catch(e){}
      setTimeout(function(){ try{ if(el.getAttribute("data-andy-undo")===key) el.removeAttribute("data-andy-undo"); }catch(e){} },10000);
      return {ok:true,how:"value",undo:{kind:"v",key:key,prevValue:v,selStart:s,selEnd:e2}};
    }
    var ceKey=String(Date.now().toString(36)+Math.random().toString(36).slice(2,10)).replace(/[^a-zA-Z0-9]/g,"");
    try{ el.setAttribute("data-andy-undo",ceKey); }catch(e){}
    var done=false;
    try{ done=document.execCommand("insertText",false,text); }catch(e){}
    if(!done){
      try{
        var sel=window.getSelection(); if(!sel.rangeCount||!el.contains(sel.anchorNode)){ var r=document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
        var rg=sel.getRangeAt(0); rg.deleteContents();
        var frag=document.createDocumentFragment(), lines=text.split("\n");
        lines.forEach(function(ln,i){ frag.appendChild(document.createTextNode(ln)); if(i<lines.length-1) frag.appendChild(document.createElement("br")); });
        rg.insertNode(frag); sel.collapseToEnd();
        el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text}));
        done=true;
      }catch(e){}
    }
    if(done){
      setTimeout(function(){ try{ if(el.getAttribute("data-andy-undo")===ceKey) el.removeAttribute("data-andy-undo"); }catch(e){} },10000);
      return {ok:true,how:"ce",undo:{kind:"ce",key:ceKey}};
    }
    try{ if(el.getAttribute("data-andy-undo")===ceKey) el.removeAttribute("data-andy-undo"); }catch(e){}
    return {ok:false,reason:"insertfail"};
  }
  // 撤销侧边栏插入：作为 chrome.scripting.executeScript 的 func 注入网页执行，必须自包含。
  // kind==='v' 直接恢复原值与选区；kind==='ce' 用原生 execCommand('undo')，不硬删 DOM。
  function injectUndo(undo){
    function editable(el){ if(!el||el===document.body||el===document.documentElement) return false; var tag=el.tagName;
      if(tag==="TEXTAREA") return !el.disabled&&!el.readOnly;
      if(tag==="INPUT") return /^(text|search|url|)$/i.test(el.getAttribute("type")||"")&&!el.disabled&&!el.readOnly;
      return !!el.isContentEditable; }
    function deepActive(){ var el=document.activeElement; while(el&&el.shadowRoot&&el.shadowRoot.activeElement) el=el.shadowRoot.activeElement; return el; }
    if(!undo||!undo.key) return {ok:false,reason:"noinput"};
    var el=null;
    try{ el=document.querySelector('[data-andy-undo="'+undo.key+'"]'); }catch(e){}
    if(!el){
      el=deepActive();
      if(!editable(el)) return {ok:false,reason:"noinput"};
    }
    if(undo.kind==="v"){
      if(el.tagName!=="TEXTAREA"&&el.tagName!=="INPUT") return {ok:false,reason:"mismatch"};
      try{
        var proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        var desc=Object.getOwnPropertyDescriptor(proto,"value");
        if(desc&&desc.set) desc.set.call(el,undo.prevValue); else el.value=undo.prevValue;
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        try{ el.setSelectionRange(undo.selStart,undo.selEnd); }catch(e){}
        el.removeAttribute("data-andy-undo");
        return {ok:true};
      }catch(e){ return {ok:false,reason:"mismatch"}; }
    }
    if(undo.kind==="ce"){
      if(!el.isContentEditable) return {ok:false,reason:"mismatch"};
      try{ el.focus(); }catch(e){}
      var ok=false; try{ ok=document.execCommand("undo"); }catch(e){}
      try{ el.removeAttribute("data-andy-undo"); }catch(e){}
      return {ok:!!ok};
    }
    return {ok:false,reason:"mismatch"};
  }
  var SITE_NAMES={"chatgpt.com":"ChatGPT","chat.openai.com":"ChatGPT","claude.ai":"Claude","chat.deepseek.com":"DeepSeek","gemini.google.com":"Gemini","aistudio.google.com":"AI Studio",
    "kimi.moonshot.cn":"Kimi","www.kimi.com":"Kimi","www.doubao.com":"豆包","yuanbao.tencent.com":"元宝","tongyi.aliyun.com":"通义","www.tongyi.com":"通义","chatglm.cn":"智谱","grok.com":"Grok","x.com":"X",
    "poe.com":"Poe","www.perplexity.ai":"Perplexity","copilot.microsoft.com":"Copilot","notebooklm.google.com":"NotebookLM","github.com":"GitHub","baijiahao.baidu.com":"百家号","mp.weixin.qq.com":"公众号"};
  function siteName(url){ try{var h=new URL(url).hostname; return SITE_NAMES[h]||h.replace(/^www\./,"");}catch(e){return "当前页面";} }
  function pageInsert(text,cb){
    if(!EXT||!chrome.tabs||!chrome.scripting){cb({ok:false,reason:"noapi"});return;}
    try{
      chrome.tabs.query({active:true,currentWindow:true},function(tabs){
        var t=tabs&&tabs[0];
        if(chrome.runtime.lastError||!t||!t.id||!/^https?:/.test(t.url||"")){cb({ok:false,reason:"nopage"});return;}
        chrome.scripting.executeScript({target:{tabId:t.id},func:injectInsert,args:[text]},function(res){
          if(chrome.runtime.lastError||!res||!res[0]){cb({ok:false,reason:"inject"});return;}
          var r=res[0].result||{ok:false,reason:"noresult"}; r.site=siteName(t.url); r.tabId=t.id; cb(r);
        });
      });
    }catch(e){cb({ok:false,reason:"exception"});}
  }
  // ---- {{变量}} 填空：内容里有占位就先弹小框填，再插入 / 复制 ----
  var varOverlay=document.getElementById("varOverlay"),varFields=document.getElementById("varFields"),varCb=null;
  function closeVars(){ varOverlay.hidden=true; varFields.innerHTML=""; varCb=null; }
  function submitVars(){
    if(!varCb) return; var map={};
    varFields.querySelectorAll("input").forEach(function(i){map[i.getAttribute("data-name")]=i.value;});
    var cb=varCb, text=AndyVars.fill(varCb.content,map); closeVars(); cb.fn(text);
  }
  function withVars(p,fn){
    var vars=AndyVars.extract(p.content);
    if(!vars.length){fn(p.content);return;}
    varCb={content:p.content,fn:fn}; varFields.innerHTML="";
    document.getElementById("varTitle").textContent="填空："+p.title;
    vars.forEach(function(v,i){
      var f=document.createElement("div");f.className="field";
      var lb=document.createElement("label");lb.textContent=v.name;
      var inp=document.createElement("input");inp.type="text";inp.value=v.def||"";inp.placeholder="填 "+v.name;inp.setAttribute("data-name",v.name);
      inp.addEventListener("keydown",function(e){
        if(isIme(e)) return;   // 输入法选词的 Enter 不是提交
        if(e.key==="Enter"){e.preventDefault();var next=varFields.querySelectorAll("input")[i+1];if(next&&!e.ctrlKey)next.focus();else submitVars();}
      });
      f.appendChild(lb);f.appendChild(inp);varFields.appendChild(f);
    });
    varOverlay.hidden=false; setTimeout(function(){var f=varFields.querySelector("input");if(f){f.focus();f.select();}},30);
  }
  document.getElementById("varOk").addEventListener("click",submitVars);
  document.getElementById("varCancel").addEventListener("click",closeVars);
  varOverlay.addEventListener("click",function(e){if(e.target===varOverlay)closeVars();});

  // 侧边栏插入后的撤销：在目标 tab 执行 injectUndo，成功后再回滚使用次数
  function undoInsert(p,r){
    if(!EXT||!chrome.scripting||!r||!r.undo||r.tabId===undefined||r.tabId===null) return;
    var tabId=r.tabId, undo=r.undo;
    try{
      chrome.scripting.executeScript({target:{tabId:tabId},func:injectUndo,args:[undo]},function(res){
        var last=""; try{ last=chrome.runtime.lastError?(chrome.runtime.lastError.message||"注入失败"):""; }catch(e){ last=String(e&&e.message||e); }
        var ok=!last && res && res[0] && res[0].result && res[0].result.ok;
        if(!ok){ toastError("撤销失败，请在页面按 Ctrl+Z"); return; }
        try{
          chrome.runtime.sendMessage({type:"andy-unused",id:p.id},function(resp){
            var le=""; try{ le=chrome.runtime.lastError?chrome.runtime.lastError.message:""; }catch(e){}
            if(le || (resp&&resp.ok===false)) toastError("插入已撤销，但使用次数未能回滚："+((resp&&resp.err)||le||"未知原因"));
            else toast("已撤销插入",2600);
          });
        }catch(e){ toast("已撤销插入",2600); }
      });
    }catch(e){ toastError("撤销失败，请在页面按 Ctrl+Z"); }
  }

  // 用一条提示词：优先插到当前页输入框，插不了就复制
  function useItem(p,card){
    if(card){card.classList.add("flash");setTimeout(function(){card.classList.remove("flash");},450);}
    withVars(p,function(text){
      pageInsert(text,function(r){
        if(r.ok){
          countUse(p); // 先即时计入使用次数（撤销成功后再发 andy-unused 回滚）
          if(r.undo&&r.tabId!==undefined&&r.tabId!==null){
            toast("已插入到 "+r.site,6000,{label:"撤销",onClick:function(){ undoInsert(p,r); }});
          } else {
            toast("已插入到 "+r.site);
          }
          return;
        }
        var cb=card&&card.querySelector(".copy");
        var msg=r.reason==="noinput"?"页面上没找到输入框 · 已复制":"已复制到剪贴板";
        copyText(text,cb,p,msg);
      });
    });
  }

  // ---- rail ----
  var rail=document.getElementById("rail");
  function railBtn(key,label,n,cur,icon){
    var b=document.createElement("button");b.className="cat";b.setAttribute("data-cat",key);
    if(cur)b.setAttribute("aria-current","true");
    b.innerHTML='<span class="cg">'+(icon?'<span class="ci">'+icon+'</span>':'')+'<span class="cl">'+escapeHtml(label)+'</span></span><span class="n">'+n+'</span>';
    // 搜索态下点分类：先清空搜索再切分类，避免「点了没反应」
    b.addEventListener("click",function(){
      if(state.q){ state.q=""; var qi=document.getElementById("q"); if(qi) qi.value=""; }
      state.cat=key; render();
    });
    return b;
  }

  // ---- render ----
  var grid=document.getElementById("grid");
  // 初次加载骨架：boot 完成后的 render 会替换掉；坏数据/空态由 render* 清空 grid，不会残留骨架
  function showSkeleton(){
    if(!grid) return;
    grid.innerHTML="";
    for(var i=0;i<3;i++){
      var sk=document.createElement("div"); sk.className="skeleton-card"; sk.setAttribute("aria-hidden","true");
      var l1=document.createElement("div"); l1.className="skeleton-line w60";
      var l2=document.createElement("div"); l2.className="skeleton-line w90";
      var l3=document.createElement("div"); l3.className="skeleton-line w75";
      sk.appendChild(l1); sk.appendChild(l2); sk.appendChild(l3); grid.appendChild(sk);
    }
  }
  showSkeleton();
  // 列表非空时才出现的「点行插入」提示，让效率核心可被发现
  var useHintEl=document.getElementById("useHint");
  function setUseHint(show){ if(useHintEl) useHintEl.hidden=!show; }
  // 搜索框 combobox 状态同步
  function updateSearchA11y(count){
    var qEl=document.getElementById("q"); if(!qEl) return;
    qEl.setAttribute("aria-expanded", count>0?"true":"false");
    if(!count) qEl.removeAttribute("aria-activedescendant");
  }
  function setActiveDescendant(){
    var qEl=document.getElementById("q"); if(!qEl) return;
    var cards=grid.querySelectorAll(".card");
    var c=cards[state.kbIdx];
    if(c&&c.id) qEl.setAttribute("aria-activedescendant",c.id);
    else qEl.removeAttribute("aria-activedescendant");
  }
  // 键盘 ↑↓ 高亮：只改现有卡片的 class，不重新 render，避免打断输入
  function applyKbFocus(doScroll){
    var cards=grid.querySelectorAll(".card"); if(!cards.length) return;
    state.kbIdx=Math.max(0,Math.min(state.kbIdx,cards.length-1));
    for(var i=0;i<cards.length;i++){
      var on=i===state.kbIdx;
      cards[i].classList.toggle("kb-focus",on);
      cards[i].setAttribute("aria-selected",on?"true":"false");
    }
    setActiveDescendant();
    if(doScroll && cards[state.kbIdx] && cards[state.kbIdx].scrollIntoView){
      try{ cards[state.kbIdx].scrollIntoView({block:"nearest"}); }catch(e){}
    }
  }
  function currentList(){
    var q=state.q.trim().toLowerCase();
    // 有搜索词时全库搜，不受当前分类/收藏筛选限制，避免「明明有却搜不到」
    if(q){ return DATA.filter(function(p){ return (p.title+" "+p.content).toLowerCase().indexOf(q)>=0; }); }
    if(state.cat==="__fav__"){ return DATA.filter(isFav); } // 伪分类：收藏
    return DATA.filter(function(p){ return state.cat==="__all__" || p.cat===state.cat; });
  }
  function render(){
    updateViewLbl();
    if(corruptMode){ updateSearchA11y(0); renderCorruptState(); return; } // 根数据坏掉：只渲染错误态卡片，不碰原始数据
    rail.hidden=false;
    var q=state.q.trim(); // 搜索态最优先：决定分类控件是否可用、是否显示「搜索结果」
    var counts={}; DATA.forEach(function(p){counts[p.cat]=(counts[p.cat]||0)+1;});
    var favN=DATA.filter(isFav).length;
    // 不再把空分类静默跳回「全部」：保留当前分类，渲染可操作空态（查看全部 / 新增提示词）
    // 大屏：左侧分类栏；窄侧边栏：分类下拉（收藏/最近不再做筛选项——收藏永远置顶，其余按次数排）
    rail.innerHTML="";
    var lbl2=document.createElement("div");lbl2.className="rail-label";lbl2.textContent="分类";rail.appendChild(lbl2);
    rail.appendChild(railBtn("__all__","全部",DATA.length,state.cat==="__all__"));
    rail.appendChild(railBtn("__fav__","★ 收藏",favN,state.cat==="__fav__"));
    catOrder(counts).forEach(function(c){rail.appendChild(railBtn(c,c,counts[c],state.cat===c));});
    var cs=document.getElementById("catSel");
    if(cs){ cs.disabled=!!q; cs.title=q?"搜索时始终搜索全库":"按分类筛选"; cs.innerHTML="";
      var o0=document.createElement("option");o0.value="__all__";o0.textContent="全部分类";cs.appendChild(o0);
      var of=document.createElement("option");of.value="__fav__";of.textContent="★ 收藏（"+favN+"）";cs.appendChild(of);
      catOrder(counts).forEach(function(c){var o=document.createElement("option");o.value=c;o.textContent=c+"（"+counts[c]+"）";cs.appendChild(o);});
      if(state.cat!=="__all__"&&state.cat!=="__fav__"&&!counts[state.cat]){var om=document.createElement("option");om.value=state.cat;om.textContent=state.cat+"（0）";cs.appendChild(om);}
      cs.value=state.cat; }

    document.getElementById("brandsub").textContent="高频提示词 · 共 "+DATA.length+" 条";
    resetMenuLabel();

    var list=sortList(currentList());
    // 键盘选中下标安全 clamp：列表重排/变短后不越界
    if(!list.length) state.kbIdx=0;
    else if(!(state.kbIdx>=0&&state.kbIdx<list.length)) state.kbIdx=0;
    var vt=state.cat==="__all__"?"全部提示词":(state.cat==="__fav__"?"收藏":state.cat);
    document.getElementById("viewTitle").textContent=q?"搜索结果":vt;
    document.getElementById("count").textContent=(q?("搜索结果 · "):"")+list.length+" 条";
    var favInList=list.filter(isFav).length, secFavDone=false, secRestDone=false;
    var restLabel="常用靠前";
    function section(text){var d=document.createElement("div");d.className="sec";d.textContent=text;grid.appendChild(d);}
    var compact=currentView()==="compact";
    state.view=compact?"compact":"card";
    grid.classList.toggle("compact",compact);
    updateViewLbl();
    grid.innerHTML="";
    updateSearchA11y(list.length);
    setUseHint(list.length>0);
    if(!list.length){ renderEmptyState(q); return; }

    list.forEach(function(p,i){
      var fav=isFav(p);
      // 收藏筛选下全部条目本来都是收藏，不再重复插「★ 收藏 · N」分组标题
      if(state.cat!=="__fav__"&&favInList){
        if(fav&&!secFavDone){secFavDone=true;section("★ 收藏 · "+favInList);}
        else if(!fav&&!secRestDone){secRestDone=true;section(restLabel);}
      }
      var card=document.createElement("article");card.className="card"+(fav?" fav":"");card.setAttribute("data-id",p.id);
      var safeId=String(p.id==null?"":p.id).replace(/[^A-Za-z0-9_-]/g,"");
      card.id="card-"+(safeId||String(i));
      card.setAttribute("role","option");
      card.setAttribute("aria-selected",i===state.kbIdx?"true":"false");
      var head=document.createElement("div");head.className="card-head";
      var chip=document.createElement("span");chip.className="chip";chip.textContent=p.cat;
      var acts=document.createElement("div");acts.className="card-actions";
      // 收藏 = 置顶（一个按钮一个概念）
      var sb=document.createElement("button");sb.className="mini star"+(fav?" on":"");sb.title=fav?"取消收藏":"收藏（置顶）";sb.setAttribute("aria-label","收藏");
      sb.innerHTML='<svg viewBox="0 0 24 24" fill="'+(fav?"currentColor":"none")+'" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 20.6l1-5.8L3.5 9.7l5.9-.9z"/></svg>';
      sb.addEventListener("click",function(){var v=!isFav(p);p.fav=v;p.pin=v;persist();render();toast(v?"已收藏 · 置顶显示":"已取消收藏");});
      var eb=document.createElement("button");eb.className="mini";eb.title="编辑";eb.setAttribute("aria-label","编辑");
      eb.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>';
      eb.addEventListener("click",function(){openEditor(p.id);});
      // 删除：第一次点变成「确认删除」，3 秒内再点才真删（不用弹窗）
      var db=document.createElement("button");db.className="mini del";db.title="删除";db.setAttribute("aria-label","删除");
      var delIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';
      db.innerHTML=delIcon; var armT=null;
      db.addEventListener("click",function(){
        if(db.classList.contains("arm")){ clearTimeout(armT); delItem(p.id); return; }
        db.classList.add("arm"); db.textContent="确认删除";
        armT=setTimeout(function(){db.classList.remove("arm");db.innerHTML=delIcon;},3000);
      });
      var cb=document.createElement("button");cb.className="copy";cb.title="只复制，不插入";
      cb.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制</span>';
      cb.addEventListener("click",function(){withVars(p,function(text){copyText(text,cb,p);});});
      if(AndyVars.has(p.content)){var vc=document.createElement("span");vc.className="chip vars";vc.title="内容里有 {{占位}}，用的时候弹出填空";vc.textContent="填空";head.appendChild(chip);head.appendChild(vc);}
      acts.appendChild(sb);acts.appendChild(eb);acts.appendChild(db);acts.appendChild(cb);
      if(!chip.parentNode) head.appendChild(chip);
      head.appendChild(acts);
      var h=document.createElement("h3");h.innerHTML=highlight(p.title,q);
      var body=document.createElement("div");body.className="body";body.innerHTML=highlight(p.content,q);
      var hasVars=AndyVars.has(p.content);
      if(compact){
        // 紧凑行：★ 收藏 + 标题 + 「填空」徽标 + 分类/次数 + 展开箭头；展开后才显示正文和全部按钮
        card.classList.add("compact");
        var row=document.createElement("div");row.className="row";
        var tx=document.createElement("div");tx.className="tx";
        var ttl=document.createElement("div");ttl.className="ttl";
        if(fav){var fs=document.createElement("span");fs.className="cfav";fs.textContent="★";fs.title="已收藏 · 置顶显示";ttl.appendChild(fs);}
        ttl.appendChild(h);
        if(hasVars){var vb=document.createElement("span");vb.className="cvars";vb.textContent="填空";vb.title="内容里有 {{占位}}，用的时候弹出填空";ttl.appendChild(vb);}
        var ex=document.createElement("div");ex.className="ex";ex.textContent=excerpt(p.content,90,p.title);
        tx.appendChild(ttl);tx.appendChild(ex);
        var rc=document.createElement("span");rc.className="rc";rc.textContent=rowSub(p);
        var tg=document.createElement("button");tg.className="mini tog";tg.title="展开全文 / 收起";tg.setAttribute("aria-label","展开");
        tg.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
        tg.addEventListener("click",function(e){e.stopPropagation();card.classList.toggle("open");});
        row.appendChild(tx);row.appendChild(rc);row.appendChild(tg);
        card.appendChild(row);card.appendChild(head);card.appendChild(body);
        // 行本身可聚焦：Enter / 空格插入（只有事件目标就是行时才触发，避免和内部按钮打架）
        card.tabIndex=0;
        card.setAttribute("aria-label",(fav?"已收藏 · ":"")+(hasVars?"含变量占位 · ":"")+p.title+" · 按 Enter 或空格插入到当前网页输入框");
        card.addEventListener("keydown",function(e){
          if(e.target!==card) return;
          if(e.key==="Enter"||e.key===" "||e.key==="Spacebar"){ e.preventDefault(); useItem(p,card); }
        });
      } else {
        card.appendChild(head);card.appendChild(h);card.appendChild(body);
      }
      var meta=document.createElement("div");meta.className="card-meta"+((p.uses||p.last)?"":" empty");
      var uses=document.createElement("span");uses.className="uses";uses.textContent=p.uses?("用过 "+p.uses+" 次"):"";
      var when=document.createElement("span");when.className="when";when.textContent=p.last?fmtWhen(p.last):"";
      meta.appendChild(uses);meta.appendChild(when);
      card.appendChild(meta);
      // 悬停就能预览正文；点整行 = 插入到当前网页输入框
      card.title=excerpt(p.content,220,p.title)+(p.content.length>220?"…":"")+"\n\n"+
        (compact?"点整行或按 Enter / 空格插入到当前网页输入框 · 点 ▾ 展开全文":"（点击整行插入到当前网页输入框）");
      card.addEventListener("click",function(e){
        if(e.target.closest(".card-actions")||e.target.closest(".expand")||e.target.closest(".tog")) return;
        if(window.getSelection && String(window.getSelection()).trim()) return;
        useItem(p,card);
      });
      if(i===state.kbIdx) card.classList.add("kb-focus");
      grid.appendChild(card);
      requestAnimationFrame(function(){
        if(!compact && body.scrollHeight>body.clientHeight+4){
          var ex=document.createElement("button");ex.className="expand";ex.textContent="展开全文 ↓";
          ex.addEventListener("click",function(){
            if(body.classList.contains("short")){body.classList.remove("short");ex.textContent="展开全文 ↓";}
            else{body.classList.add("short");ex.textContent="收起 ↑";}
          });
          card.insertBefore(ex, meta);
        }
      });
    });
    updateSearchA11y(list.length);
    setActiveDescendant();
  }

  // ---- 空态：把「死路」变成可操作的下一步（不新增 HTML id，全用 DOM 创建）----
  function renderEmptyState(q){
    var box=document.createElement("div"); box.className="empty-state";
    var title=document.createElement("div"); title.className="es-title";
    var desc=document.createElement("div"); desc.className="es-desc";
    var acts=document.createElement("div"); acts.className="es-actions";
    function addBtn(label,primary,fn){
      var b=document.createElement("button"); b.type="button"; b.className="btn"+(primary?" btn-primary":"");
      b.textContent=label; b.addEventListener("click",fn); acts.appendChild(b); return b;
    }
    if(!DATA.length && !q){
      title.textContent="提示词库还是空的";
      desc.textContent=DEFAULT.length
        ?("从内置 "+DEFAULT.length+" 条开始，或导入一份 JSON；也可以自己新增。")
        :"可以导入一份 JSON，或自己新增；内置提示词这次没有加载出来。";
      addBtn("恢复内置"+(DEFAULT.length?(" "+DEFAULT.length+" 条"):"") ,true,function(){ restoreDefaults(); });
      addBtn("导入 JSON",false,function(){ toggleMenu(false); var f=document.getElementById("fileInput"); if(f){ f.value=""; f.click(); } });
      addBtn("新增提示词",false,function(){ openEditor(null); });
    } else if(q){
      title.textContent="没有匹配的提示词";
      desc.textContent="没有匹配「"+q+"」的提示词，试试更短的关键词。";
      addBtn("清空搜索",true,function(){ state.q=""; var qi=document.getElementById("q"); if(qi) qi.value=""; render(); });
    } else if(state.cat==="__fav__"){
      title.textContent="还没有收藏的提示词";
      desc.textContent="点卡片右上角 ★ 收藏，它就会置顶出现在这里。";
      addBtn("查看全部",true,function(){ state.cat="__all__"; render(); });
    } else {
      title.textContent="这个分类还没有提示词";
      desc.textContent=(state.cat==="__all__"?"这里":"「"+state.cat+"」里")+"还没有提示词；可以新增一条，或先看看全部。";
      addBtn("查看全部",false,function(){ state.cat="__all__"; render(); });
      addBtn("新增提示词",true,function(){ openEditor(null); });
    }
    box.appendChild(title); box.appendChild(desc); box.appendChild(acts);
    grid.appendChild(box);
  }

  // ---- 错误态：根数据不是数组（R-02）----
  // 后台/面板都不覆盖原始数据：只给「导出原始数据」和「两段式清空并恢复内置」两个出口，不用 window.confirm。
  function renderCorruptState(){
    rail.hidden=true;
    setUseHint(false);
    var cs=document.getElementById("catSel"); if(cs){ cs.disabled=true; }
    document.getElementById("brandsub").textContent="数据异常 · 原始数据未改动";
    document.getElementById("viewTitle").textContent="提示词库数据异常";
    document.getElementById("count").textContent="";
    resetMenuLabel();
    grid.classList.remove("compact");
    grid.innerHTML="";
    var box=document.createElement("div"); box.className="corrupt-card";
    var h=document.createElement("div"); h.className="corrupt-title"; h.textContent="提示词库数据格式异常";
    var kind="null";
    if(corruptRaw!==null&&corruptRaw!==undefined) kind=Array.isArray(corruptRaw)?"数组":typeof corruptRaw;
    var p=document.createElement("div"); p.className="corrupt-text";
    p.textContent="读到的根数据是「"+kind+"」，不是提示词数组。原始数据没有被改动，仍完整保存在浏览器里；面板不会自动写入，避免把仅剩的数据覆盖掉。请先导出留底，再用下面的按钮清空并恢复内置；清空前也会自动再导出一份原始数据。";
    var acts=document.createElement("div"); acts.className="corrupt-actions";
    var ex=document.createElement("button"); ex.type="button"; ex.className="btn"; ex.textContent="导出原始数据（JSON）";
    ex.addEventListener("click",function(){
      if(downloadJson(corruptRaw,"andy-prompts-损坏原始数据-"+dateStr()+".json")) toast("已导出原始数据到下载目录",2600);
    });
    var rs=document.createElement("button"); rs.type="button"; rs.className="btn btn-primary";
    function baseLbl(){ return "清空并恢复内置"+(DEFAULT.length?(" "+DEFAULT.length+" 条"):""); }
    rs.textContent=baseLbl();
    var armedAt=0, armT=null;
    function revert(){ armedAt=0; clearTimeout(armT); rs.textContent=baseLbl(); }
    rs.addEventListener("click",function(){
      if(Date.now()>armedAt){
        if(!DEFAULT.length){ toast("内置提示词没加载出来，暂时无法恢复",4200); return; }
        armedAt=Date.now()+3000;
        rs.textContent="再点一次确认清空并恢复";
        clearTimeout(armT); armT=setTimeout(revert,3000);
        return;
      }
      clearTimeout(armT); armedAt=0;
      corruptReset();
    });
    acts.appendChild(ex); acts.appendChild(rs);
    box.appendChild(h); box.appendChild(p); box.appendChild(acts);
    grid.appendChild(box);
  }

  // ---- editor ----
  var overlay=document.getElementById("overlay"),editingId=null,editingBefore=null;
  var fTitle=document.getElementById("fTitle"),fCat=document.getElementById("fCat"),fContent=document.getElementById("fContent");
  var titleAuto=false, catAuto=false, dirty=false, discardArmAt=0;
  // 编辑框里的「收藏」按钮：新增时就能直接标星，存出去就置顶
  var mStar=document.getElementById("mStar"), editFav=false;
  function setEditFav(v){ editFav=!!v; mStar.classList.toggle("on",editFav); mStar.querySelector("span").textContent=editFav?"已收藏":"收藏"; mStar.title=editFav?"点击取消收藏":"收藏 = 置顶显示"; }
  mStar.addEventListener("click",function(){ setEditFav(!editFav); });
  function fillCatList(){
    var counts={};DATA.forEach(function(p){counts[p.cat]=1;});ORDER.forEach(function(c){counts[c]=1;});
    var dl=document.getElementById("catList");dl.innerHTML="";
    catOrder(counts).forEach(function(c){var o=document.createElement("option");o.value=c;dl.appendChild(o);});
  }
  function autoDetect(force){
    var c=fContent.value;
    if(force||!fTitle.value.trim()||titleAuto){ var t=smartTitle(c); if(t){fTitle.value=t;titleAuto=true;} }
    if(force||!fCat.value.trim()||catAuto){ var g=guessCat(c); if(g){fCat.value=g;catAuto=true;} }
  }
  function openEditor(id){
    if(id&&!find(id)){toast("该条目已删除");return;}
    editingBefore=id?clone(find(id)):null;
    editingId=id||null; fillCatList(); titleAuto=false; catAuto=false; dirty=false; discardArmAt=0;
    setEditFav(id?isFav(find(id)):false);
    if(id){var p=find(id);fTitle.value=p.title;fCat.value=p.cat;fContent.value=p.content;document.getElementById("mTitle").textContent="编辑提示词";
      overlay.hidden=false; setTimeout(function(){fTitle.focus();},30);}
    else{fTitle.value="";fCat.value=(state.cat.indexOf("__")===0?"":state.cat);fContent.value="";document.getElementById("mTitle").textContent="新增提示词";
      overlay.hidden=false; setTimeout(function(){fContent.focus();},30);}
  }
  function isDirty(){
    if(overlay.hidden) return false;
    if(dirty) return true;
    // 新增时哪怕只自动识别出标题/分类，也算有未保存内容，避免误关丢草稿
    if(!editingId) return !!(fTitle.value.trim()||fCat.value.trim()||fContent.value.trim());
    return false;
  }
  // R-07：Esc / 点遮罩第一次只提示，2.5 秒内再来一次才真的关；保存成功走 closeEditor(true) 强制关闭。
  function closeEditor(force,msg){
    if(!force && isDirty()){
      var now=Date.now();
      if(now>discardArmAt){
        discardArmAt=now+2500;
        toast(msg||"再按一次 Esc 放弃未保存的修改",2500);
        return;
      }
    }
    var wasOpen=!overlay.hidden;
    discardArmAt=0; dirty=false; overlay.hidden=true; editingId=null; editingBefore=null;
    // pending 在编辑中到达时会留在 storage 不覆盖草稿；关掉编辑框后自动载入
    if(wasOpen) setTimeout(checkPending,60);
  }
  function saveEditor(){
    if(corruptMode){ toast("提示词库数据异常，请先用错误提示里的「清空并恢复内置」修复",4200); return; }
    var t=fTitle.value.trim(),c=fContent.value.trim(),cat=fCat.value.trim();
    if(!c){toast("提示词内容不能为空");fContent.focus();return;}
    if(!t){ try{ t=smartTitle(c); }catch(e){ t=""; } if(!t) t=c.replace(/\s+/g," ").slice(0,20); if(!t) t="未命名提示词"; }
    if(!cat){cat=guessCat(c)||"未分类";}
    var before=clone(DATA);
    if(editingId){var p=find(editingId);if(!p){toast("该条目已删除，请保留编辑内容并重新新增");return;}
      before=before.map(function(x){return x.id===editingId?Object.assign({},x,{title:editingBefore.title,content:editingBefore.content,cat:editingBefore.cat,fav:editingBefore.fav,pin:editingBefore.pin}):x;});
      p.title=t;p.content=c;p.cat=cat;p.fav=editFav;p.pin=editFav;}
    else{DATA.unshift({id:uid(),title:t,content:c,cat:cat,fav:editFav,pin:editFav,uses:0,last:0});}
    var wasEdit=!!editingId;
    persist(function(){closeEditor(true);render();toast(wasEdit?"已保存修改":("已新增 · 归类到「"+cat+"」"+(editFav?" · 已收藏置顶":"")));},before);
  }
  // 任何输入都算脏；重新编辑时撤销上一次的「再按一次」计时
  [fTitle,fCat,fContent].forEach(function(el){ el.addEventListener("input",function(){ dirty=true; discardArmAt=0; }); });
  fContent.addEventListener("input",function(){autoDetect(false);});
  fTitle.addEventListener("input",function(){titleAuto=false;});
  fCat.addEventListener("input",function(){catAuto=false;});
  document.getElementById("mDetect").addEventListener("click",function(){autoDetect(true);toast("已按内容重新识别标题和分类");});
  document.getElementById("addBtn").addEventListener("click",function(){openEditor(null);});
  document.getElementById("mSave").addEventListener("click",saveEditor);
  document.getElementById("mCancel").addEventListener("click",function(){closeEditor(false,"再点一次「取消」放弃未保存的修改");});
  overlay.addEventListener("click",function(e){if(e.target===overlay)closeEditor();});
  [fTitle,fCat,fContent].forEach(function(el){el.addEventListener("keydown",function(e){if(isIme(e))return;if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();saveEditor();}});});

  function delItem(id){var p=find(id);if(!p)return;
    DATA=DATA.filter(function(x){return x.id!==id;});persist();render();toast("已删除「"+(p.title||"提示词").slice(0,12)+"」");}

  // ---- data menu ----
  var dataMenu=document.getElementById("dataMenu"),dataBtn=document.getElementById("dataBtn");
  function toggleMenu(show){
    var s=show===undefined?dataMenu.hidden:show;
    // 窄栏里菜单图标靠近左侧，230px 菜单会被视口左边缘裁掉：改为贴边全宽下拉，并按图标底部定 top
    if(s && window.innerWidth<=520){
      try{ var r=dataBtn.getBoundingClientRect(); dataMenu.style.top=Math.round((r.bottom||0)+6)+"px"; }catch(e){}
    }
    dataMenu.hidden=!s; dataBtn.setAttribute("aria-expanded",String(s));
  }
  dataBtn.addEventListener("click",function(e){e.stopPropagation();toggleMenu();});
  document.addEventListener("click",function(){if(!dataMenu.hidden)toggleMenu(false);});
  dataMenu.addEventListener("click",function(e){e.stopPropagation();});

  document.getElementById("openTabBtn").addEventListener("click",function(){
    toggleMenu(false);
    if(EXT&&chrome.tabs) chrome.tabs.create({url:chrome.runtime.getURL("panel.html")});
    else window.open(location.href,"_blank");
  });

  function dateStr(){var d=new Date();function p(n){return(n<10?"0":"")+n;}return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());}
  // 统一的 JSON 下载：正常导出和「导出损坏原始数据」共用
  function downloadJson(obj,name){
    try{
      var blob=new Blob([JSON.stringify(obj,null,2)],{type:"application/json"});
      var url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      return true;
    }catch(e){ toastError("导出失败："+String(e&&e.message||e)); return false; }
  }
  document.getElementById("exportBtn").addEventListener("click",function(){
    toggleMenu(false);
    var now=new Date().toISOString();
    function pid(){return "prompt-"+Date.now()+"-"+Math.random().toString(36).slice(2,15);}
    var items=DATA.map(function(p){
      var id=(p.id&&/^prompt-/.test(p.id))?p.id:pid();
      return{id:id,title:p.title,content:p.content,category:p.cat,promptType:"text",shortcut:"",tags:[],favorite:!!p.fav,usageCount:p.uses||0,createdAt:now,updatedAt:now,lastUsedAt:p.last?new Date(p.last).toISOString():null};
    });
    var payload={app:"安迪提示词库",version:1,exportedAt:now,settings:{shortcutExpansionEnabled:false,shortcutTrigger:"@"},items:items};
    if(downloadJson(payload,"andy-prompts-"+dateStr()+".json")) toast("已导出 "+DATA.length+" 条");
  });
  var fileInput=document.getElementById("fileInput");
  document.getElementById("importBtn").addEventListener("click",function(){toggleMenu(false);fileInput.value="";fileInput.click();});
  fileInput.addEventListener("change",function(){var f=fileInput.files[0];if(f)importFile(f);});

  // ---- 导入预览：先解析统计，确认后才写库；取消/遮罩/Esc 不改数据 ----
  var importOverlay=document.getElementById("importOverlay"),importSummary=document.getElementById("importSummary"),importList=document.getElementById("importList");
  var importCancelBtn=document.getElementById("importCancel"),importOkBtn=document.getElementById("importOk");
  var importPending=null, importBusy=false;
  function closeImportPreview(){
    importPending=null; importBusy=false;
    if(importOverlay) importOverlay.hidden=true;
    if(importOkBtn){ importOkBtn.disabled=false; importOkBtn.textContent="确认导入"; }
  }
  function importTitle(p){
    var t=String(p&&p.title!=null?p.title:"").trim();
    return t||String(p&&p.content!=null?p.content:"").slice(0,20);
  }
  function showImportPreview(items,skipped,bad){
    importPending={items:items,skipped:skipped,bad:bad};
    importBusy=false;
    if(importSummary){
      importSummary.textContent="将导入 "+items.length+" 条（按正文去重后的新条目） / 跳过重复 "+skipped+" 条 / 忽略无效 "+bad+" 条";
    }
    if(importList){
      importList.innerHTML="";
      var preview=items.slice(0,5);
      preview.forEach(function(p){ var li=document.createElement("li"); li.textContent=importTitle(p); importList.appendChild(li); });
      if(items.length>preview.length){ var more=document.createElement("li"); more.className="more"; more.textContent="…还有 "+(items.length-preview.length)+" 条"; importList.appendChild(more); }
      if(!items.length){ var none=document.createElement("li"); none.className="more"; none.textContent="没有可导入的新条目"; importList.appendChild(none); }
    }
    if(importOkBtn){ importOkBtn.disabled=!items.length; importOkBtn.textContent="确认导入"; }
    if(importOverlay){
      importOverlay.hidden=false;
      setTimeout(function(){ try{ (items.length?importOkBtn:importCancelBtn).focus(); }catch(e){} },30);
    }
  }
  function confirmImportPreview(){
    if(!importPending||importBusy||!importPending.items.length) return;
    importBusy=true;
    if(importOkBtn){ importOkBtn.disabled=true; importOkBtn.textContent="导入中…"; }
    var items=importPending.items, skipped=importPending.skipped, bad=importPending.bad;
    var before=clone(DATA);
    items.forEach(function(p){ DATA.push(p); });
    persist(function(){
      importBusy=false; closeImportPreview(); render();
      toast("已合并导入 "+items.length+" 条"+(skipped?("，跳过重复 "+skipped+" 条"):"")+(bad?("，忽略无效 "+bad+" 条"):""),3200);
    },before,false,function(err){
      importBusy=false;
      DATA=before;
      if(importOkBtn){ importOkBtn.disabled=false; importOkBtn.textContent="确认导入"; }
      render();
      toastError("导入失败："+((err&&err.message)||err));
    });
  }
  if(importCancelBtn) importCancelBtn.addEventListener("click",closeImportPreview);
  if(importOkBtn) importOkBtn.addEventListener("click",confirmImportPreview);
  if(importOverlay) importOverlay.addEventListener("click",function(e){ if(e.target===importOverlay) closeImportPreview(); });

  function importFile(file){
    if(!file) return;
    if(file.size > 25*1024*1024){ toastError("文件太大（超过 25MB），已取消导入"); return; }
    function toStr(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }
    var r=new FileReader();
    r.onload=function(){
      var incoming=[];
      try{
        var text=String(r.result||"");
        if(text.charCodeAt(0)===0xFEFF) text=text.slice(1); // 去 BOM
        var obj=JSON.parse(text);
        if(Array.isArray(obj))incoming=obj;
        else if(obj&&Array.isArray(obj.items))incoming=obj.items;
        else{toastError("无法识别的文件格式");return;}
      }catch(e){toastError("导入失败：不是有效 JSON");return;}
      var seen={};DATA.forEach(function(p){seen[toStr(p.content).trim()]=1;});
      var items=[],skipped=0,bad=0;
      incoming.forEach(function(p){
        // 每条单独兜底：一条坏数据不能让整批预览/导入中途抛错
        try{
          if(!p||typeof p!=="object"||Array.isArray(p)){bad++;return;}
          var content=toStr(p.content).trim().split(RATIO_BAD).join(RATIO_GOOD); if(!content){bad++;return;}
          if(seen[content]){skipped++;return;} seen[content]=1;
          var title="";
          try{ title=toStr(p.title).trim()||smartTitle(content); }catch(e){ title=""; }
          if(!title) title=content.slice(0,20);
          if(!title) title="未命名提示词";
          var cat=toStr(p.category!=null?p.category:p.cat).trim().slice(0,40)||"未分类";
          var uses=typeof p.usageCount==="number"?p.usageCount:(typeof p.uses==="number"?p.uses:0);
          var last=typeof p.last==="number"?p.last:(Date.parse(p.lastUsedAt)||0);
          if(typeof last!=="number"||!isFinite(last)) last=0;
          items.push({id:uid(),title:title,content:content,cat:cat,fav:!!(p.favorite||p.fav),pin:!!p.pin,uses:uses,last:last});
        }catch(e){ bad++; }
      });
      showImportPreview(items,skipped,bad);
    };
    r.readAsText(file);
  }
  // 网页输入框里唤起提示词的方式：打 //（默认，Claude/Notion 自己的 / 菜单不会撞上）→ 打 / → 关
  var SET_KEY="andy-settings", SETTINGS={trigger:"double"};
  // 菜单文案缩短到一行；完整说明放 title，避免窄侧栏两行折行
  var TRIG_LBL={double:"网页里唤起：打 //",single:"网页里唤起：打 /",off:"网页里唤起：已关闭"};
  var TRIG_TOAST={double:"在任意网页输入框行首打 // 就能选提示词（中文输入法下打 、、 也行）",single:"已改为打一个 /：注意 Claude、Notion 自己的 / 菜单会同时弹出",off:"已关闭网页唤起（Ctrl+S 保存和侧边栏插入不受影响）"};
  function normSet(s){ s=s||{}; var t=s.trigger; if(!t) t=(s.slash===false)?"off":"double"; return {trigger:t}; }
  function slashLbl(){
    var el=document.getElementById("slashLbl"); if(!el) return;
    var key=TRIG_LBL[SETTINGS.trigger]?SETTINGS.trigger:"double";
    el.textContent=TRIG_LBL[key];
    el.title=TRIG_TOAST[key]||"";
    var btn=document.getElementById("slashBtn"); if(btn) btn.title=el.title||"点击切换唤起方式";
  }
  function loadSettings(){
    if(EXT){ chrome.storage.local.get(SET_KEY,function(res){ SETTINGS=normSet(res&&res[SET_KEY]); slashLbl(); }); }
    else { try{SETTINGS=normSet(JSON.parse(localStorage.getItem(SET_KEY)||"null"));}catch(e){} slashLbl(); }
  }
  document.getElementById("slashBtn").addEventListener("click",function(){
    SETTINGS.trigger={double:"single",single:"off",off:"double"}[SETTINGS.trigger]||"double"; slashLbl();
    if(EXT){ var o={}; o[SET_KEY]=SETTINGS; chrome.storage.local.set(o); } else { try{localStorage.setItem(SET_KEY,JSON.stringify(SETTINGS));}catch(e){} }
    toast(TRIG_TOAST[SETTINGS.trigger]);
  });
  // 「恢复内置」改两段式按钮文案：第一次点变成确认文案，3 秒内再点才执行（不再用 window.confirm，side panel 里可能被吞）。
  var resetArmedUntil=0, resetArmT=null;
  function resetLabelBase(){ return DEFAULT.length?("恢复内置 "+DEFAULT.length+" 条"):"恢复内置（未加载）"; }
  function resetMenuLabel(){
    var el=document.getElementById("resetLbl"); if(!el) return;
    if(resetArmedUntil>Date.now()){ el.textContent="再点一次确认覆盖"; return; }
    el.textContent=resetLabelBase();
  }
  function armReset(){
    resetArmedUntil=Date.now()+3000;
    resetMenuLabel();
    clearTimeout(resetArmT);
    resetArmT=setTimeout(function(){ resetArmedUntil=0; resetMenuLabel(); },3000);
  }
  // 根数据坏掉时后台的乐观锁/校验都过不了，只能直接写 storage（写前已自动导出原始数据）
  function directWrite(items,cb){
    if(EXT){
      var o={}; o[STORE_KEY]=items;
      try{
        chrome.storage.local.set(o,function(){
          var err=""; try{ err=chrome.runtime.lastError?(chrome.runtime.lastError.message||"写入失败"):""; }catch(e){ err=String(e&&e.message||e); }
          cb(err?new Error(err):null);
        });
      }catch(e){ cb(new Error(String(e&&e.message||e))); }
    } else { try{ localStorage.setItem(STORE_KEY,JSON.stringify(items)); cb(null); }catch(e){ cb(new Error("保存失败")); } }
  }
  function corruptReset(){
    if(!DEFAULT.length){ toastError("内置提示词没加载出来，暂时无法恢复"); return; }
    if(corruptRaw!==null&&corruptRaw!==undefined) downloadJson(corruptRaw,"andy-prompts-损坏原始数据-"+dateStr()+".json");
    var items=ensureIds(clone(DEFAULT));
    directWrite(items,function(err){
      if(err){ toastError("恢复内置失败："+(err.message||err)); return; }
      DATA=items; corruptMode=false; corruptRaw=null; lastSaved=JSON.stringify(DATA); ready=true;
      state.cat="__all__"; state.q=""; var qi=document.getElementById("q"); if(qi) qi.value="";
      render();
      toast("已清空异常数据并恢复内置 "+DATA.length+" 条",3200);
    });
  }
  // 抽成共用执行体：菜单（两段式确认）和空态（空库直接执行）都走这里
  function restoreDefaults(){
    if(!DEFAULT.length){ toastError("内置提示词没加载出来，已禁用「恢复内置」以免清空你的库"); return false; }
    if(corruptMode){ corruptReset(); return true; }
    // 空库也允许恢复内置（R-02 的「被挡住」问题）
    var before=clone(DATA);DATA=ensureIds(clone(DEFAULT));
    persist(function(){state.cat="__all__";state.q="";var qi=document.getElementById("q");if(qi)qi.value="";resetMenuLabel();render();toast("已恢复内置 "+DEFAULT.length+" 条");},before,true,
      function(err){ toastError("恢复内置失败："+((err&&err.message)||err)); });
    return true;
  }
  document.getElementById("resetBtn").addEventListener("click",function(){
    var now=Date.now();
    if(now>resetArmedUntil){
      // seed.json 没加载出来时 DEFAULT=[]，再点「恢复内置」就会把整库 replace 成空数组，必须挡住
      if(!DEFAULT.length){ toast("内置提示词没加载出来，已禁用「恢复内置」以免清空你的库",4200); return; }
      armReset();
      toast("再点一次「恢复内置」确认覆盖当前 "+DATA.length+" 条",3000);
      return; // 菜单保持打开，方便再点一次
    }
    clearTimeout(resetArmT); resetArmedUntil=0;
    toggleMenu(false);
    restoreDefaults();
  });

  // ---- 分类下拉（窄屏）----
  var catSel=document.getElementById("catSel");
  if(catSel) catSel.addEventListener("change",function(){
    // 搜索态下 catSel 是 disabled；这里仍兜底「先清搜索再切分类」，兼容辅助技术触发 change
    if(state.q){ state.q=""; var qi=document.getElementById("q"); if(qi) qi.value=""; }
    state.cat=catSel.value; render();
  });

  // ---- 视图切换（在 ≡ 菜单里）：窄栏强制紧凑，宽屏才用 qm-view 偏好 ----
  function updateViewLbl(){
    // 窄栏没有卡片视图：菜单里的「切换视图」直接隐藏，避免死项
    var vb=document.getElementById("viewBtn"); if(vb) vb.hidden=isNarrow();
    var el=document.getElementById("viewLbl"); if(!el) return;
    el.textContent=currentView()==="compact"?"切换为卡片视图":"切换为紧凑列表";
  }
  var viewBtn=document.getElementById("viewBtn");
  if(viewBtn) viewBtn.addEventListener("click",function(){
    toggleMenu(false);
    if(isNarrow()){ toast("窄栏固定为紧凑列表，拉宽窗口后可切换卡片视图",3000); return; }
    prefView=prefView==="compact"?"card":"compact";
    try{localStorage.setItem("qm-view",prefView);}catch(e){}
    applyView(); updateViewLbl(); render();
  });
  // 宽度变化（拖窗口 / 把侧栏拉宽）后统一走一次 applyView + render，避免 600/820 两套断点打架
  var viewportT=null;
  function onViewportChange(){
    clearTimeout(viewportT);
    viewportT=setTimeout(function(){ applyView(); updateViewLbl(); render(); },120);
  }
  window.addEventListener("resize",onViewportChange);
  if(NARROW_MQ){
    if(NARROW_MQ.addEventListener) NARROW_MQ.addEventListener("change",onViewportChange);
    else if(NARROW_MQ.addListener) NARROW_MQ.addListener(onViewportChange);
  }

  // ---- search + 快捷键 ----
  var qInput=document.getElementById("q");
  var searchT=null;
  qInput.addEventListener("input",function(e){
    state.q=e.target.value; state.kbIdx=0;
    clearTimeout(searchT);
    searchT=setTimeout(function(){ searchT=null; render(); },90); // 防抖合并连续输入
  });
  function flushSearchDebounce(){
    if(searchT){ clearTimeout(searchT); searchT=null; return true; }
    return false;
  }
  // 搜索框：↑↓ 在结果间移动高亮（不移动光标），Enter 用当前高亮项
  qInput.addEventListener("keydown",function(e){
    if(isIme(e)) return;   // 中文选词/组合中的方向键与回车交给输入法
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){
      flushSearchDebounce(); render(); // 先落盘当前搜索词，避免在旧列表上移动高亮
      var kl=sortList(currentList()); if(!kl.length) return;
      e.preventDefault();
      var d=(e.key==="ArrowDown")?1:-1;
      state.kbIdx=((state.kbIdx||0)+d+kl.length)%kl.length;
      applyKbFocus(true);
      return;
    }
    if(e.key==="Enter"){
      e.preventDefault();
      flushSearchDebounce(); render(); // Enter 前取消 debounce，用当前搜索词渲染后的数据
      var list=sortList(currentList());
      if(!list.length){ toast("没有匹配的提示词"); return; }
      var idx=(state.kbIdx>=0&&state.kbIdx<list.length)?state.kbIdx:0;
      var cards=grid.querySelectorAll(".card");
      useItem(list[idx],cards[idx]||null);
    }
    else if(e.key==="Escape"&&qInput.value){ e.preventDefault(); flushSearchDebounce(); qInput.value=""; state.q=""; state.kbIdx=0; render(); }
  });
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&!importOverlay.hidden){closeImportPreview();return;}
    if(e.key==="Escape"&&!varOverlay.hidden){closeVars();return;}
    if(e.key==="Escape"&&!overlay.hidden){closeEditor();return;}
    if(isIme(e)) return;
    if(!overlay.hidden||!varOverlay.hidden||!importOverlay.hidden) return;   // 弹层打开时不响应 / 和 n，避免覆盖正在编辑的内容
    var tag=(e.target&&e.target.tagName||"").toLowerCase(), typing=tag==="input"||tag==="textarea"||tag==="select";
    if(typing) return;
    if(e.key==="/"){e.preventDefault();qInput.focus();}
    else if(e.key==="n"||e.key==="N"){e.preventDefault();openEditor(null);}
  });

  // ---- 网页上右键「保存到安迪提示词库」→ background 写 pending → 这里弹出编辑框预填 ----
  // R-06：编辑中（有未保存改动）pending 不覆盖草稿——留在 storage 里，关掉编辑框后再自动载入。
  var PENDING_KEY="andy-pending";
  function applyPending(text){
    openEditor(null);
    fContent.value=text||"";
    autoDetect(true);
    dirty=true; // 外部内容尚未保存，避免下一个 pending 再把它覆盖掉
    toast("已抓取选中文字，看下标题分类再保存");
  }
  function checkPending(){
    if(!EXT) return;
    chrome.storage.local.get(PENDING_KEY,function(res){
      var pd=res&&res[PENDING_KEY]; if(!pd||!pd.text) return;
      if(!varOverlay.hidden) closeVars();
      if(!overlay.hidden && isDirty()){
        toast("已抓取选中文字，但当前编辑还没保存；先保存或取消，随后会自动载入",4200);
        return; // 不 remove：pending 留在 storage，等 closeEditor 后的 checkPending 再取
      }
      chrome.storage.local.remove(PENDING_KEY,function(){ void chrome.runtime.lastError; });
      applyPending(pd.text);
    });
  }
  if(EXT) chrome.storage.onChanged.addListener(function(ch,area){ if(area==="local"&&ch[PENDING_KEY]&&ch[PENDING_KEY].newValue) checkPending(); });

  // 一键回到顶部：右下角常驻按钮（往下滚一点就出现）+ 点顶栏的标题也回顶部
  var toTop=document.getElementById("toTop");
  function scrollTopNow(){ var se=document.scrollingElement||document.documentElement; try{se.scrollTo({top:0,behavior:"smooth"});}catch(e){se.scrollTop=0;} }
  function syncToTop(){ var y=(document.scrollingElement||document.documentElement).scrollTop||window.scrollY||0; if(toTop) toTop.classList.toggle("show",y>200); }
  if(toTop){
    window.addEventListener("scroll",syncToTop,{passive:true});
    document.addEventListener("scroll",syncToTop,{passive:true,capture:true});
    toTop.addEventListener("click",scrollTopNow);
    syncToTop();
  }
  var brandEl=document.querySelector(".brand");
  if(brandEl){ brandEl.title="回到顶部"; brandEl.style.cursor="pointer"; brandEl.addEventListener("click",scrollTopNow); }
  // ---- 硬盘备份状态：顶部 slim banner（不健康时才出现）+ ≡ 菜单里的状态行 ----
  var BK_KEY="andy-backup-status";
  var backupBanner=document.getElementById("backupBanner"),backupBannerMsg=document.getElementById("backupBannerMsg"),backupBannerBtn=document.getElementById("backupBannerBtn");
  var backupBannerMode="";
  function setBackupBanner(mode,msg,btnLabel){
    if(!backupBanner) return;
    // 首屏引导显示/加载期间不显示备份横幅，避免首屏两条横幅叠在一起
    if(onboardVisible||onboardPending) mode="";
    backupBannerMode=mode||"";
    if(!mode){ backupBanner.hidden=true; backupBanner.className="backup-banner"; return; }
    backupBanner.hidden=false;
    backupBanner.className="backup-banner "+(mode==="setup"?"warn":"danger");
    if(backupBannerMsg) backupBannerMsg.textContent=msg||"";
    if(backupBannerBtn) backupBannerBtn.textContent=btnLabel||"处理";
  }
  if(backupBannerBtn) backupBannerBtn.addEventListener("click",function(e){
    // 阻止冒泡到 document 的「点外部关闭菜单」：否则刚打开 ≡ 菜单就会被立刻关掉
    e.stopPropagation();
    if(backupBannerMode==="setup"){
      // 打开 ≡ 菜单并聚焦备份行，给出可执行指引
      toggleMenu(true);
      var b=document.getElementById("backupBtn"); if(b){ try{ b.focus(); }catch(e){} }
      toast("点菜单里的「备份」可重试；仍提示未启用，就双击项目里的 修复备份.cmd 一次",5600);
      return;
    }
    toggleMenu(false); retryBackup(false);
  });
  function backupLbl(){
    var el=document.getElementById("backupLbl");
    if(!EXT){ setBackupBanner(""); return; }
    if(!el) return;
    chrome.storage.local.get(BK_KEY,function(res){
      var st=res&&res[BK_KEY]; if(!el || chrome.runtime.lastError) return;
      if(!st){ el.textContent="备份：还没跑过 · 点此重试"; el.style.color=""; el.title=""; setBackupBanner(""); return; }
      // 备份助手没登记时不算「失败」，也不标红：红「!」留给真正的备份错误
      if(st.needsSetup===true){
        el.textContent="备份未启用 · 点此检查"; el.style.color=""; el.title="硬盘备份助手还没登记：双击项目里的 修复备份.cmd 一次即可";
        setBackupBanner("setup","硬盘备份还没启用 · 点此设置","去设置"); return;
      }
      var when=fmtWhen(st.at);
      if(st.ok){ el.textContent="备份：正常 · "+(st.count||0)+" 条"+(when?(" · "+when):""); el.style.color=""; el.title=st.dir?("已自动备份到 "+st.dir):"已自动备份"; setBackupBanner(""); }
      else { el.textContent="备份失败"+(when?(" · "+when):"")+" · 点此重试"; el.style.color="var(--danger)"; el.title=st.hint||st.err||""; setBackupBanner("error","硬盘备份失败 · 点此重试","重试"); }
    });
  }
  function retryBackup(silent){
    if(!EXT) return;
    if(!silent) toast("正在重新备份到硬盘…");
    try{
      chrome.runtime.sendMessage({type:"andy-backup-now"},function(r){
        var last=""; try{ last=chrome.runtime.lastError?(chrome.runtime.lastError.message||"扩展上下文已失效"):""; }catch(e){ last=String(e&&e.message||e); }
        if(last) toastError("备份重试失败："+last);
        else if(r && r.status && r.status.ok===false) toastError("备份重试失败："+((r.status.hint||r.status.err)||"未知原因"));
        else if(r && r.ok===false) toastError("备份重试失败："+((r.err)||"备份助手未响应"));
        setTimeout(backupLbl,1200);
      });
    }catch(e){ toastError("备份重试失败："+String(e&&e.message||e)); setTimeout(backupLbl,1200); }
  }
  var backupBtn=document.getElementById("backupBtn");
  if(backupBtn) backupBtn.addEventListener("click",function(){toggleMenu(false);retryBackup(false);});
  if(EXT) chrome.storage.onChanged.addListener(function(ch,area){ if(area==="local"&&ch[BK_KEY]) backupLbl(); });
  function syncBackup(){
    // R-29：打开面板只刷新状态，不再自动重试备份；要重试由用户点「备份」按钮触发，避免失败时红「!」反复闪。
    backupLbl();
  }

  // ---- 首次使用引导：andy-onboarded 不存在时显示一次；≡ 菜单「使用帮助」可重开 ----
  var ONBOARD_KEY="andy-onboarded";
  var onboardVisible=false, onboardPending=false, onboardLoaded=false;
  function onboardCard(){ return document.getElementById("onboard"); }
  function showOnboard(){
    var el=onboardCard(); if(!el) return;
    el.hidden=false; onboardVisible=true;
    setBackupBanner(""); // 与备份 banner 协调：不同时显示两条横幅
  }
  function hideOnboard(){
    var el=onboardCard(); if(el) el.hidden=true;
    onboardVisible=false;
    backupLbl(); // 关闭后恢复备份 banner
  }
  function markOnboarded(){
    if(EXT){ var o={}; o[ONBOARD_KEY]=1; try{ chrome.storage.local.set(o,function(){ void chrome.runtime.lastError; }); }catch(e){} }
    else { try{ localStorage.setItem(ONBOARD_KEY,"1"); }catch(e){} }
  }
  function initOnboard(){
    if(onboardLoaded) return; onboardLoaded=true;
    if(corruptMode) return; // 坏数据错误态不显示引导
    onboardPending=true;
    function done(v){
      onboardPending=false;
      if(v===undefined||v===null) showOnboard();
      else backupLbl(); // 已看过：恢复被抑制的备份 banner
    }
    if(EXT){ chrome.storage.local.get(ONBOARD_KEY,function(res){ done(res&&res[ONBOARD_KEY]); }); }
    else { var v=null; try{ v=localStorage.getItem(ONBOARD_KEY); }catch(e){} done(v); }
  }
  var onbDismiss=document.getElementById("onbDismiss");
  if(onbDismiss) onbDismiss.addEventListener("click",function(){
    markOnboarded(); hideOnboard();
    toast("以后可在 ≡ →「使用帮助」再看到这三步",3200);
  });
  var helpBtn=document.getElementById("helpBtn");
  if(helpBtn) helpBtn.addEventListener("click",function(){
    toggleMenu(false);
    showOnboard();
  });

  boot(function(d){DATA=d;render();checkPending();loadSettings();initOnboard();syncBackup();
    // 打开侧边栏就能直接打字搜索；有弹层（编辑/填空）时不抢焦点
    if(isNarrow()&&overlay.hidden&&varOverlay.hidden) setTimeout(function(){qInput.focus();},50);
  });
})();
