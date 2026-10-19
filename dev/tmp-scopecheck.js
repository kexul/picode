// 临时检查：找出 media/chat.js 里引用了、但作用域链上没有声明的名字（静默异常那种）。
// 两遍：先建作用域树、把声明全收进去（函数声明提升），再查引用。用完就删。
const fs = require('fs');
const ts = require('D:/projects/picode/node_modules/typescript');

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);

const GLOBALS = new Set(`window document console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
fetch EventSource Promise JSON Math Date Array Object String Number Boolean Error RegExp Map Set WeakMap WeakSet
navigator location performance alert confirm prompt Image Uint8Array Uint32Array Uint16Array Int8Array Float32Array ArrayBuffer DataView
atob btoa URL URLSearchParams Node Element HTMLElement CustomEvent MutationObserver IntersectionObserver ResizeObserver history
Audio requestIdleCallback crypto TextDecoder TextEncoder Intl isNaN parseInt parseFloat undefined NaN Infinity arguments this
localStorage sessionStorage getComputedStyle MessageEvent Blob FileReader File FormData KeyboardEvent MouseEvent PointerEvent DragEvent
ClipboardEvent structuredClone queueMicrotask visualViewport WebSocket XMLHttpRequest indexedDB caches self globalThis top parent frames
encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape Symbol Proxy Reflect BigInt SharedArrayBuffer Atomics Function
scrollTo scrollBy open close print process require module exports __dirname __filename
Range DOMRect DOMRectReadOnly getSelection Text AbortController ReadableStream NodeList
`.split(/\s+/).filter(Boolean));

function makeScope(parent, fn) {
  return { parent, names: new Set(), fn: fn === true };
}

function bindingNames(name, out) {
  if (!name) return;
  if (ts.isIdentifier(name)) { out.push(name.text); return; }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) bindingNames(el.name, out);
    }
  }
}

const scopes = new Map();   // 声明节点 -> 它所在的作用域
const funcScopeOf = new Map();

function pass(scope, funcScope, visit) {
  // scope: 当前作用域；funcScope: 最近函数作用域（var 声明落这里）
  visit(nodeHook, blockHook);
  function nodeHook(node) {
    // 函数
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      const names = [];
      for (const p of node.parameters || []) bindingNames(p.name, names);
      const inner = makeScope(scope, true);
      for (const n of names) inner.names.add(n);
      if (ts.isFunctionExpression(node) && node.name) inner.names.add(node.name.text);
      funcScopeOf.set(node, inner);
      // 函数体里的 var 由 funcScope 收：用参数把 funcScope 传下去不方便，直接在递归里替换
      ts.forEachChild(node, (child) => { /* 占位 */ });
      // 手工递归：参数默认值在函数作用域里求值
      for (const p of node.parameters || []) {
        if (p.initializer) walk(p.initializer, inner, inner);
        if (p.type) walk(p.type, inner, inner);
      }
      if (node.body) walk(node.body, inner, inner);
      return 'skip';
    }
    if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node)) {
      const inner = makeScope(scope);
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        const names = [];
        bindingNames(node.variableDeclaration.name, names);
        for (const n of names) inner.names.add(n);
      }
      walkChildren(node, inner, funcScope);
      return 'skip';
    }
    if (ts.isVariableDeclaration(node)) {
      const isVar = node.parent && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0;
      const target = isVar ? funcScope : scope;
      const names = [];
      bindingNames(node.name, names);
      for (const n of names) target.names.add(n);
      if (node.initializer) walk(node.initializer, scope, funcScope);
      if (node.type) walk(node.type, scope, funcScope);
      return 'skip';
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      // 已经在上面处理了
    }
    if (ts.isClassDeclaration(node) && node.name) {
      scope.names.add(node.name.text);
    }
    return undefined;
  }
  function blockHook() { return undefined; }

  function walkChildren(node, s, f) {
    ts.forEachChild(node, (child) => { walk(child, s, f); });
  }
  function walk(node, s, f) {
    const r = nodeHook.call(null, node, s, f);
    if (r !== 'skip') { ts.forEachChild(node, (child) => { walk(child, s, f); }); }
  }

  // 第一遍要处理顶层函数声明：在进入函数之前先把名字记到父作用域
  // 上面的 nodeHook 在函数分支里没做这件事，补在这里统一处理
  // 用包装：先递归声明阶段
  return null;
}

// —— 为了简单，改成显式两遍实现 —— //
const globalScope = makeScope(null, true);
const scopeAt = new Map();      // 节点 -> 该节点内部（函数体）的作用域
const parentScopeAt = new Map(); // 节点 -> 该节点所在作用域

function hoist(node, scope, funcScope) {
  // 从 node 的子节点扫起：node 自己的 Block 就是本作用域，别把自己当成嵌套块跳掉
  ts.forEachChild(node, (root) => {
  // 把本作用域里所有声明收进来（函数声明提升、var 提升）
  const entries = [];
  (function scan(n, s, f) {
    if (!n) { return; }
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) {
      if (n.name) { s.names.add(n.name.text); }
      return; // 不进函数体（它有自己的作用域）
    }
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
      || ts.isGetAccessor(n) || ts.isSetAccessor(n)) { return; }
    if (ts.isVariableDeclaration(n)) {
      const isVar = n.parent && (n.parent.flags & ts.NodeFlags.BlockScoped) === 0;
      { const names = []; bindingNames(n.name, names); const target = isVar ? f : s; for (const x of names) target.names.add(x); }
      return;
    }
    if (ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isCatchClause(n)) { return; }
    ts.forEachChild(n, (c) => scan(c, s, f));
  })(root, scope, funcScope);
  });
}

// 递归建立作用域结构
function build(node, scope, funcScope) {
  if (!node) { return; }
  parentScopeAt.set(node, scope);
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    if (ts.isFunctionDeclaration(node) && node.name) { /* 已由父作用域扫到 */ }
    const inner = makeScope(scope, true);
    scopeAt.set(node, inner);
    for (const p of node.parameters || []) {
      const names = [];
      bindingNames(p.name, names);
      for (const n of names) inner.names.add(n);
    }
    if (ts.isFunctionExpression(node) && node.name) inner.names.add(node.name.text);
    // 函数体（Block）本身也建一层：它里面的 let/const
    for (const p of node.parameters || []) {
      if (p.initializer) build(p.initializer, inner, inner);
    }
    if (node.body) {
      const bodyInner = ts.isBlock(node.body) ? makeScope(inner) : inner;
      if (ts.isBlock(node.body)) { scopeAt.set(node.body, bodyInner); hoist(node.body, bodyInner, inner); }
      const target = ts.isBlock(node.body) ? bodyInner : inner;
      ts.forEachChild(node.body, (c) => build(c, target, inner));
    }
    return;
  }
  if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const inner = makeScope(scope);
    scopeAt.set(node, inner);
    hoist(node, inner, funcScope);
    if (ts.isForStatement(node)) {
      if (node.initializer) build(node.initializer, inner, funcScope);
      if (node.condition) build(node.condition, inner, funcScope);
      if (node.incrementor) build(node.incrementor, inner, funcScope);
      if (node.statement) build(node.statement, inner, funcScope);
      return;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      build(node.initializer, inner, funcScope);
      build(node.expression, inner, funcScope);
      build(node.statement, inner, funcScope);
      return;
    }
    ts.forEachChild(node, (c) => build(c, inner, funcScope));
    return;
  }
  if (ts.isCatchClause(node)) {
    const inner = makeScope(scope);
    scopeAt.set(node, inner);
    hoist(node, inner, funcScope);
    if (node.variableDeclaration) {
      const names = [];
      bindingNames(node.variableDeclaration.name, names);
      for (const n of names) inner.names.add(n);
      build(node.variableDeclaration.initializer, inner, funcScope);
    }
    if (node.block) build(node.block, inner, funcScope);
    return;
  }
  if (ts.isVariableDeclaration(node)) {
    if (node.initializer) build(node.initializer, scope, funcScope);
    return;
  }
  ts.forEachChild(node, (c) => build(c, scope, funcScope));
}

function isReference(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isMethodDeclaration(p) && p.name === node) return false;
  if (ts.isLabeledStatement(p) && p.label === node) return false;
  if ((ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === node) return false;
  if (ts.isParameter(p) && p.name === node) return false;
  if (ts.isVariableDeclaration(p) && p.name === node) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === node) return false;
  if (ts.isCatchClause(p) && p.variableDeclaration && p.variableDeclaration.name === node) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === node) return true;
  return true;
}

function scopesFor(found) {
  let s = found;
  const out = [];
  while (s) { out.push(s); s = s.parent; }
  return out;
}

function check(node, scope, funcScope) {
  if (!node) { return; }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const inner = scopeAt.get(node) || scope;
    if (node.body && scopeAt.get(node.body)) {
      ts.forEachChild(node.body, (c) => check(c, scopeAt.get(node.body), inner));
      return;
    }
    for (const p of node.parameters || []) {
      if (p.initializer) check(p.initializer, inner, inner);
    }
    if (node.body) ts.forEachChild(node.body, (c) => check(c, inner, inner));
    return;
  }
  if ((ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node))
    && scopeAt.get(node)) {
    ts.forEachChild(node, (c) => check(c, scopeAt.get(node), funcScope));
    return;
  }
  if (ts.isVariableDeclaration(node)) {
    if (node.initializer) check(node.initializer, scope, funcScope);
    return;
  }
  if (ts.isIdentifier(node) && isReference(node)) {
    const has = scopesFor(scope).some((s) => s.names.has(node.text));
    if (!has && !GLOBALS.has(node.text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      console.log(line + ': ' + node.text);
    }
    return;
  }
  ts.forEachChild(node, (c) => check(c, scope, funcScope));
}

// 顶层：先扫全局作用域的声明（函数、var），再把每个声明节点的内部作用域建好
hoist(sf, globalScope, globalScope);
for (const st of sf.statements) {
  if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      const names = [];
      bindingNames(d.name, names);
      for (const n of names) globalScope.names.add(n);
    }
  }
}
build(sf, globalScope, globalScope);
ts.forEachChild(sf, (c) => check(c, globalScope, globalScope));
