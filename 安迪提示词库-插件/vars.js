// 共享：{{变量}} 解析与填充（侧边栏 panel.js 和网页内 content.js 都用）
// 写法：{{股票名}}  或带默认值 {{语气:专业克制}}（冒号 / 竖线都行）
// 注意：纯数字的「名字」不当作变量，按字面量保留。否则「{{16:9/3:4/9:16}}」会被解析成
// 变量名 16、默认值 9/3:4/9:16，插入时丢掉开头的 16（真实数据里踩过）。
var AndyVars = (function () {
  var RE = /\{\{\s*([^{}|:：\n]+?)\s*(?:[:：|]\s*([^{}\n]*?))?\s*\}\}/g;
  function isLiteralName(name) { return /^\d+$/.test(name); }
  function extract(text) {
    var out = [], seen = {};
    String(text || "").replace(RE, function (m, name, def) {
      name = name.trim();
      if (isLiteralName(name)) return m;
      if (!seen[name]) { seen[name] = 1; out.push({ name: name, def: (def || "").trim() }); }
      return m;
    });
    return out;
  }
  function fill(text, map) {
    return String(text || "").replace(RE, function (m, name, def) {
      name = name.trim();
      if (isLiteralName(name)) return m;
      var v = map && Object.prototype.hasOwnProperty.call(map, name) ? String(map[name]) : "";
      if (v === "") v = (def || "").trim();
      return v;
    });
  }
  function has(text) { return extract(text).length > 0; }
  return { extract: extract, fill: fill, has: has };
})();
