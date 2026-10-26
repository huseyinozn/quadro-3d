// A small Jinja2 engine with Python semantics, set up the way Klipper uses it for G-code macros:
// statements in {% %}, expressions in { } (Environment('{%', '%}', '{', '}')), comments in {# #}.
// It covers what printer macros use: Python literals and operators (including "%" string formatting),
// str/list/dict methods, filters, tests, if/elif/else, for loops, set, namespace().

export class TemplateError extends Error {}
export const UNDEF = Object.freeze({ __undef: true, toString: () => "" });
export const isUndef = (v) => v === UNDEF || v === undefined;

// ---------- Python values ----------
// dicts keep insertion order and non-string keys; everything else maps onto JS (number, string, bool, null, array)
export class PyDict {
  constructor(entries) { this.m = new Map(entries || []); }
  static from(obj) {
    if (obj instanceof PyDict) return new PyDict(obj.m);
    return new PyDict(Object.entries(obj || {}));
  }
  get(k, d = null) { const key = normKey(this.m, k); return this.m.has(key) ? this.m.get(key) : d; }
  has(k) { return this.m.has(normKey(this.m, k)); }
  set(k, v) { this.m.set(normKey(this.m, k), v); }
}
function normKey(m, k) {
  if (m.has(k)) return k;
  if (typeof k === "number" && m.has(String(k))) return String(k);
  if (typeof k === "string" && k.trim() !== "" && !isNaN(Number(k)) && m.has(Number(k))) return Number(k);
  return k;
}
export class PyFloat { constructor(v) { this.v = v; } valueOf() { return this.v; } toString() { return fmtFloat(this.v); } }
const num = (v) => (v instanceof PyFloat ? v.v : v);
const isNum = (v) => typeof v === "number" || v instanceof PyFloat || typeof v === "boolean";
const isFloat = (v) => v instanceof PyFloat;
const F = (v) => new PyFloat(v);
function fmtFloat(v) {
  if (!isFinite(v)) return isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1);
  let s = String(v);
  if (s.includes("e")) s = s.replace(/e\+?(-?)(\d)$/, "e$10$2");
  return s;
}
export function pyStr(v) {
  if (isUndef(v)) return "";
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (v instanceof PyFloat) return fmtFloat(v.v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : fmtFloat(v);
  if (typeof v === "string") return v;
  return pyRepr(v);
}
export function pyRepr(v) {
  if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  if (Array.isArray(v)) return (v.tuple ? "(" : "[") + v.map(pyRepr).join(", ") + (v.tuple && v.length === 1 ? ",)" : v.tuple ? ")" : "]");
  if (v instanceof PyDict) return "{" + [...v.m].map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  if (v instanceof Namespace) return "<Namespace " + pyRepr(PyDict.from(v.d)) + ">";
  if (v && typeof v === "object" && !(v instanceof PyFloat)) {
    if (typeof v.__repr__ === "function") return v.__repr__();
    return "{" + Object.entries(v).filter(([, x]) => typeof x !== "function").map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  }
  return pyStr(v);
}
export function truthy(v) {
  if (isUndef(v) || v === null || v === false) return false;
  if (v instanceof PyFloat) return v.v !== 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (v instanceof PyDict) return v.m.size > 0;
  return true;
}
function pyEq(a, b) {
  if (isUndef(a) || isUndef(b)) return isUndef(a) && isUndef(b);
  if (isNum(a) && isNum(b)) return num(+a) === num(+b);
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (a instanceof PyDict && b instanceof PyDict) return a.m.size === b.m.size && [...a.m].every(([k, v]) => b.has(k) && pyEq(v, b.get(k)));
  return a === b;
}
function cmp(a, b) {
  if (isNum(a) && isNum(b)) return num(+a) - num(+b);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return a.length - b.length; }
  throw new TemplateError("TypeError: '<' not supported between instances of '" + typeName(a) + "' and '" + typeName(b) + "'");
}
function typeName(v) {
  if (isUndef(v)) return "Undefined";
  if (v === null) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (v instanceof PyFloat) return "float";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return v.tuple ? "tuple" : "list";
  if (v instanceof PyDict) return "dict";
  return "object";
}
function contains(container, item) {
  if (typeof container === "string") return typeof item === "string" && container.includes(item);
  if (Array.isArray(container)) return container.some((x) => pyEq(x, item));
  if (container instanceof PyDict) return container.has(item);
  if (container && typeof container.__contains__ === "function") return container.__contains__(item);
  if (container && typeof container === "object") return Object.prototype.hasOwnProperty.call(container, pyStr(item));
  if (isUndef(container)) throw new TemplateError("TypeError: argument of type 'Undefined' is not iterable");
  return false;
}
export function iter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v instanceof PyDict) return [...v.m.keys()];
  if (isUndef(v)) return [];
  if (v && typeof v.__iter__ === "function") return v.__iter__();
  if (v && typeof v === "object") return Object.keys(v);
  throw new TemplateError("TypeError: '" + typeName(v) + "' object is not iterable");
}
function getattr(obj, name) {
  if (isUndef(obj) || obj === null) return UNDEF;
  if (obj instanceof Namespace) return name in obj.d ? obj.d[name] : UNDEF;
  const method = methodOf(obj, name);
  if (method) return method;
  if (obj instanceof PyDict) return obj.has(name) ? obj.get(name) : UNDEF;
  if (typeof obj === "object" && typeof obj.__getattr__ === "function") return obj.__getattr__(name);
  if (typeof obj === "object" && !(obj instanceof PyFloat) && Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  return UNDEF;
}
function getitem(obj, key) {
  if (isUndef(obj) || obj === null) return UNDEF;
  if (Array.isArray(obj) || typeof obj === "string") {
    let i = num(key);
    if (typeof i !== "number") return getattr(obj, pyStr(key));
    if (i < 0) i += obj.length;
    return i >= 0 && i < obj.length ? obj[i] : UNDEF;
  }
  if (obj instanceof PyDict) return obj.has(key) ? obj.get(key) : UNDEF;
  if (typeof obj === "object" && typeof obj.__getitem__ === "function") return obj.__getitem__(key);
  if (typeof obj === "object") { const k = pyStr(key); return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : UNDEF; }
  return UNDEF;
}
export class Namespace { constructor(d) { this.d = d; } }
const bound = (fn) => Object.assign(fn, { __pycall: true });
function methodOf(obj, name) {
  if (typeof obj === "string") {
    const s = obj, M = {
      upper: () => s.toUpperCase(), lower: () => s.toLowerCase(), strip: (c) => strip(s, c, 3), lstrip: (c) => strip(s, c, 1), rstrip: (c) => strip(s, c, 2),
      split: (sep = null, n = -1) => splitPy(s, sep, n), startswith: (p) => (Array.isArray(p) ? p.some((x) => s.startsWith(x)) : s.startsWith(p)),
      endswith: (p) => (Array.isArray(p) ? p.some((x) => s.endsWith(x)) : s.endsWith(p)), replace: (a, b) => s.split(a).join(b), find: (x) => s.indexOf(x),
      join: (l) => iter(l).map(pyStr).join(s), capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(), title: () => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
      isdigit: () => /^\d+$/.test(s), count: (x) => s.split(x).length - 1, format: (...a) => { let i = 0; return s.replace(/\{(\d*)\}/g, (_, n) => pyStr(a[n === "" ? i++ : Number(n)])); },
      zfill: (w) => s.padStart(w, "0"),
    };
    return M[name] ? bound(M[name]) : null;
  }
  if (Array.isArray(obj)) {
    const l = obj, M = {
      append: (x) => { l.push(x); return null; }, extend: (x) => { l.push(...iter(x)); return null; }, pop: (i = -1) => l.splice(i < 0 ? l.length + i : i, 1)[0],
      insert: (i, x) => { l.splice(i, 0, x); return null; }, index: (x) => { const i = l.findIndex((y) => pyEq(y, x)); if (i < 0) throw new TemplateError("ValueError: not in list"); return i; },
      count: (x) => l.filter((y) => pyEq(y, x)).length, remove: (x) => { l.splice(l.findIndex((y) => pyEq(y, x)), 1); return null; }, copy: () => l.slice(), reverse: () => { l.reverse(); return null; },
      sort: () => { l.sort(cmp); return null; },
    };
    return M[name] ? bound(M[name]) : null;
  }
  if (obj instanceof PyDict) {
    const d = obj, M = {
      get: (k, def = null) => d.get(k, def), keys: () => [...d.m.keys()], values: () => [...d.m.values()],
      items: () => [...d.m].map(([k, v]) => Object.assign([k, v], { tuple: true })), copy: () => new PyDict(d.m),
      update: (other, kw) => { if (other !== undefined && !isUndef(other)) for (const [k, v] of entries(other)) d.set(k, v); if (kw) for (const [k, v] of Object.entries(kw)) d.set(k, v); return null; },
      pop: (k, def) => { if (d.has(k)) { const v = d.get(k); d.m.delete(normKey(d.m, k)); return v; } if (def === undefined) throw new TemplateError("KeyError: " + pyRepr(k)); return def; },
      setdefault: (k, def = null) => { if (!d.has(k)) d.set(k, def); return d.get(k); },
    };
    return M[name] ? bound(M[name]) : null;
  }
  if (obj && typeof obj === "object" && !(obj instanceof PyFloat) && !(obj instanceof Namespace) && typeof obj.__getattr__ !== "function") {
    // status objects behave like dicts inside templates (Klipper deep-copies get_status() results)
    const M = { get: (k, def = null) => { const v = getitem(obj, k); return isUndef(v) ? def : v; }, keys: () => Object.keys(obj), values: () => Object.values(obj), items: () => Object.entries(obj).map((e) => Object.assign(e, { tuple: true })) };
    if (M[name] && !Object.prototype.hasOwnProperty.call(obj, name)) return bound(M[name]);
  }
  return null;
}
function entries(v) {
  if (v instanceof PyDict) return [...v.m];
  if (Array.isArray(v)) return v.map((p) => [p[0], p[1]]);
  if (v && typeof v === "object") return Object.entries(v);
  return [];
}
function strip(s, chars, side) {
  const set = chars == null ? null : new Set(chars);
  const keep = (c) => (set ? !set.has(c) : !/\s/.test(c));
  let a = 0, b = s.length;
  if (side & 1) while (a < b && !keep(s[a])) a++;
  if (side & 2) while (b > a && !keep(s[b - 1])) b--;
  return s.slice(a, b);
}
function splitPy(s, sep, n) {
  if (sep === null || sep === undefined) { const parts = s.trim().split(/\s+/); return parts[0] === "" ? [] : parts; }
  const parts = s.split(sep);
  if (n >= 0 && parts.length > n + 1) return [...parts.slice(0, n), parts.slice(n).join(sep)];
  return parts;
}
// "%s %d %.2f" % args
export function percentFormat(fmt, args) {
  const list = Array.isArray(args) && args.tuple ? args : [args];
  let i = 0;
  const out = fmt.replace(/%(\(([^)]+)\))?([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sdifeEgGxXorc%])/g, (m, _, key, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    let v = key ? getitem(args, key) : list[i++];
    if (v === undefined) throw new TemplateError("TypeError: not enough arguments for format string");
    let s;
    const p = prec === undefined ? undefined : Number(prec);
    switch (conv) {
      case "s": s = pyStr(v); if (p !== undefined) s = s.slice(0, p); break;
      case "r": s = pyRepr(v); break;
      case "d": case "i": { const x = toNumber(v, conv); s = String(Math.trunc(x)); break; }
      case "f": case "F": s = toNumber(v, conv).toFixed(p === undefined ? 6 : p); break;
      case "e": case "E": s = toNumber(v, conv).toExponential(p === undefined ? 6 : p).replace(/e([+-])(\d)$/, "e$10$2"); if (conv === "E") s = s.toUpperCase(); break;
      case "g": case "G": s = String(Number(toNumber(v, conv).toPrecision(p === undefined ? 6 : p || 1))); break;
      case "x": case "X": s = Math.trunc(toNumber(v, conv)).toString(16); if (conv === "X") s = s.toUpperCase(); break;
      case "o": s = Math.trunc(toNumber(v, conv)).toString(8); break;
      case "c": s = typeof v === "string" ? v : String.fromCharCode(num(v)); break;
    }
    if (flags.includes("+") && /[dieEfFgG]/.test(conv) && !s.startsWith("-")) s = "+" + s;
    else if (flags.includes(" ") && /[dieEfFgG]/.test(conv) && !s.startsWith("-")) s = " " + s;
    const w = width === undefined ? 0 : Number(width);
    if (s.length < w) s = flags.includes("-") ? s.padEnd(w) : flags.includes("0") && /[dieEfFgGxX]/.test(conv) ? (s[0] === "-" || s[0] === "+" ? s[0] + s.slice(1).padStart(w - 1, "0") : s.padStart(w, "0")) : s.padStart(w);
    return s;
  });
  if (i < list.length && !(Array.isArray(args) && args.tuple === undefined && list.length === 1)) {
    if (i < list.length && list.length > 1) throw new TemplateError("TypeError: not all arguments converted during string formatting");
  }
  return out;
}
function toNumber(v, conv) {
  if (isNum(v)) return num(+v);
  throw new TemplateError("TypeError: %" + conv + " format: a real number is required, not " + typeName(v));
}

// ---------- Python literal parsing (ast.literal_eval) ----------
export function literalEval(text) {
  const p = new Parser(tokenize(String(text).trim(), 0).tokens);
  const node = p.parseExpr();
  if (!p.atEnd()) throw new TemplateError("invalid literal");
  return evalLiteral(node);
}
function evalLiteral(n) {
  switch (n.t) {
    case "lit": return n.v;
    case "list": return n.items.map(evalLiteral);
    case "tuple": return Object.assign(n.items.map(evalLiteral), { tuple: true });
    case "dict": return new PyDict(n.pairs.map(([k, v]) => [evalLiteral(k), evalLiteral(v)]));
    case "unary": if (n.op === "-") { const v = evalLiteral(n.a); return isFloat(v) ? F(-v.v) : -v; } if (n.op === "+") return evalLiteral(n.a); break;
    case "bin": if (n.op === "+" || n.op === "-") { const a = evalLiteral(n.a), b = evalLiteral(n.b); if (isNum(a) && isNum(b)) { const r = n.op === "+" ? num(a) + num(b) : num(a) - num(b); return isFloat(a) || isFloat(b) ? F(r) : r; } } break;
  }
  throw new TemplateError("malformed node or string");
}

// ---------- lexer ----------
const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "else", "elif", "for", "endfor", "endif", "set", "true", "false", "none", "True", "False", "None"]);
function tokenize(src, start, stopAtBrace = false) {
  const tokens = [];
  let i = start, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (stopAtBrace && c === "}" && depth === 0) return { tokens, end: i };
    if (stopAtBrace === "%" && c === "%" && src[i + 1] === "}" && depth === 0) return { tokens, end: i };
    if (stopAtBrace === "%" && c === "-" && src[i + 1] === "%" && src[i + 2] === "}" && depth === 0) return { tokens, end: i, trimRight: true };
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1]))) {
      const m = /^(\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+|\d+)/.exec(src.slice(i));
      const t = m[0];
      tokens.push({ k: "num", v: /[.eE]/.test(t) ? F(Number(t)) : Number(t) }); i += t.length; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { const e = src[j + 1]; s += e === "n" ? "\n" : e === "t" ? "\t" : e; j += 2; } else s += src[j++];
      }
      if (j >= src.length) throw new TemplateError("unterminated string");
      tokens.push({ k: "str", v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      tokens.push({ k: KEYWORDS.has(m[0]) ? "kw" : "name", v: m[0] }); i += m[0].length; continue;
    }
    const two = src.substr(i, 2);
    if (["==", "!=", "<=", ">=", "//", "**"].includes(two)) { tokens.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/%~<>=()[]{},:.|".includes(c)) {
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) depth--;
      tokens.push({ k: "op", v: c }); i++; continue;
    }
    throw new TemplateError("unexpected char '" + c + "'");
  }
  if (stopAtBrace) throw new TemplateError("unexpected end of template, expected '}'");
  return { tokens, end: i };
}

// ---------- parser ----------
class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  atEnd() { return this.i >= this.t.length; }
  is(k, v) { const t = this.peek(); return t && t.k === k && (v === undefined || t.v === v); }
  isOp(v) { return this.is("op", v); }
  isKw(v) { return this.is("kw", v); }
  next() { return this.t[this.i++]; }
  expect(k, v) { const t = this.next(); if (!t || t.k !== k || (v !== undefined && t.v !== v)) throw new TemplateError("expected '" + (v || k) + "'" + (t ? " got '" + t.v + "'" : "")); return t; }
  parseExpr(noCond) {
    const a = this.parseOr();
    if (!noCond && this.isKw("if")) {
      this.next(); const c = this.parseOr();
      let b = { t: "lit", v: UNDEF };
      if (this.isKw("else")) { this.next(); b = this.parseExpr(); }
      return { t: "cond", c, a, b };
    }
    return a;
  }
  parseOr() { let a = this.parseAnd(); while (this.isKw("or")) { this.next(); a = { t: "or", a, b: this.parseAnd() }; } return a; }
  parseAnd() { let a = this.parseNot(); while (this.isKw("and")) { this.next(); a = { t: "and", a, b: this.parseNot() }; } return a; }
  parseNot() { if (this.isKw("not")) { this.next(); return { t: "not", a: this.parseNot() }; } return this.parseCompare(); }
  parseCompare() {
    let a = this.parseConcat();
    const ops = [];
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.v)) { this.next(); ops.push([t.v, this.parseConcat()]); }
      else if (this.isKw("in")) { this.next(); ops.push(["in", this.parseConcat()]); }
      else if (this.isKw("not") && this.peek(1) && this.peek(1).k === "kw" && this.peek(1).v === "in") { this.next(); this.next(); ops.push(["notin", this.parseConcat()]); }
      else break;
    }
    return ops.length ? { t: "cmp", a, ops } : a;
  }
  parseConcat() { let a = this.parseAdd(); while (this.isOp("~")) { this.next(); a = { t: "bin", op: "~", a, b: this.parseAdd() }; } return a; }
  parseAdd() { let a = this.parseMul(); while (this.isOp("+") || this.isOp("-")) { const op = this.next().v; a = { t: "bin", op, a, b: this.parseMul() }; } return a; }
  parseMul() { let a = this.parsePow(); while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) { const op = this.next().v; a = { t: "bin", op, a, b: this.parsePow() }; } return a; }
  parsePow() { let a = this.parseUnary(); while (this.isOp("**")) { this.next(); a = { t: "bin", op: "**", a, b: this.parseUnary() }; } return a; }
  parseUnary() {
    if (this.isOp("-") || this.isOp("+")) { const op = this.next().v; return { t: "unary", op, a: this.parseUnary() }; }
    return this.parsePostfix(this.parsePrimary());
  }
  parsePostfix(n) {
    for (;;) {
      if (this.isOp(".")) { this.next(); const t = this.next(); n = { t: "attr", o: n, name: String(t.v) }; }
      else if (this.isOp("[")) {
        this.next();
        let a = null, b = null, slice = false;
        if (!this.isOp(":")) a = this.parseExpr();
        if (this.isOp(":")) { slice = true; this.next(); if (!this.isOp("]")) b = this.parseExpr(); }
        this.expect("op", "]");
        n = slice ? { t: "slice", o: n, a, b } : { t: "item", o: n, k: a };
      } else if (this.isOp("(")) { n = { t: "call", f: n, ...this.parseArgs() }; }
      else if (this.isOp("|")) {
        this.next(); let name = this.expect("name").v;
        while (this.isOp(".")) { this.next(); name += "." + this.expect("name").v; }
        const args = this.isOp("(") ? this.parseArgs() : { args: [], kw: {} };
        n = { t: "filter", name, a: n, ...args };
      } else if (this.isKw("is")) {
        this.next(); let neg = false;
        if (this.isKw("not")) { this.next(); neg = true; }
        const t = this.next(); const name = String(t.v).toLowerCase();
        let args = [];
        if (this.isOp("(")) args = this.parseArgs().args;
        else if (this.peek() && (["num", "str", "name"].includes(this.peek().k) || this.isOp("[") || this.isOp("{"))) args = [this.parsePostfix(this.parsePrimary())];
        n = { t: "test", name, a: n, args, neg };
      } else break;
    }
    return n;
  }
  parseArgs() {
    this.expect("op", "(");
    const args = [], kw = {};
    while (!this.isOp(")")) {
      if (this.is("name") && this.peek(1) && this.peek(1).k === "op" && this.peek(1).v === "=") { const k = this.next().v; this.next(); kw[k] = this.parseExpr(); }
      else args.push(this.parseExpr());
      if (this.isOp(",")) this.next(); else break;
    }
    this.expect("op", ")");
    return { args, kw };
  }
  parsePrimary() {
    const t = this.next();
    if (!t) throw new TemplateError("unexpected end of expression");
    if (t.k === "num" || t.k === "str") {
      let v = t.v;
      while (t.k === "str" && this.is("str")) v += this.next().v;   // implicit concatenation
      return { t: "lit", v };
    }
    if (t.k === "kw") {
      if (t.v === "true" || t.v === "True") return { t: "lit", v: true };
      if (t.v === "false" || t.v === "False") return { t: "lit", v: false };
      if (t.v === "none" || t.v === "None") return { t: "lit", v: null };
      throw new TemplateError("unexpected '" + t.v + "'");
    }
    if (t.k === "name") return { t: "name", name: t.v };
    if (t.v === "(") {
      if (this.isOp(")")) { this.next(); return { t: "tuple", items: [] }; }
      const first = this.parseExpr();
      if (this.isOp(",")) {
        const items = [first];
        while (this.isOp(",")) { this.next(); if (this.isOp(")")) break; items.push(this.parseExpr()); }
        this.expect("op", ")"); return { t: "tuple", items };
      }
      this.expect("op", ")"); return first;
    }
    if (t.v === "[") {
      const items = [];
      while (!this.isOp("]")) { items.push(this.parseExpr()); if (this.isOp(",")) this.next(); else break; }
      this.expect("op", "]"); return { t: "list", items };
    }
    if (t.v === "{") {
      const pairs = [];
      while (!this.isOp("}")) { const k = this.parseExpr(); this.expect("op", ":"); pairs.push([k, this.parseExpr()]); if (this.isOp(",")) this.next(); else break; }
      this.expect("op", "}"); return { t: "dict", pairs };
    }
    throw new TemplateError("unexpected '" + t.v + "'");
  }
}

// ---------- template compiler: text / {expr} / {% stmt %} / {# comment #} ----------
export function compile(src, name = "template") {
  const parts = [];
  let i = 0, text = "";
  const pushText = () => { if (text) parts.push({ t: "text", v: text }); text = ""; };
  while (i < src.length) {
    if (src[i] === "{" && src[i + 1] === "#") {
      const end = src.indexOf("#}", i + 2); if (end < 0) throw new TemplateError("unterminated comment");
      pushText(); i = end + 2; continue;
    }
    if (src[i] === "{" && src[i + 1] === "%") {
      let j = i + 2, lt = false;
      if (src[j] === "-") { lt = true; j++; }
      if (lt) text = text.replace(/\s+$/, "");
      pushText();
      const { tokens, end, trimRight } = tokenize(src, j, "%");
      parts.push({ t: "stmt", tokens });
      i = end + (trimRight ? 3 : 2);
      if (trimRight) while (i < src.length && /\s/.test(src[i])) i++;
      continue;
    }
    if (src[i] === "{") {
      pushText();
      const { tokens, end } = tokenize(src, i + 1, true);
      const p = new Parser(tokens), expr = p.parseExpr();
      if (!p.atEnd()) throw new TemplateError("unexpected '" + p.peek().v + "' in expression");
      parts.push({ t: "expr", e: expr });
      i = end + 1; continue;
    }
    text += src[i++];
  }
  pushText();
  // build the statement tree
  let pos = 0;
  function block(stops) {
    const body = [];
    while (pos < parts.length) {
      const p = parts[pos];
      if (p.t !== "stmt") { body.push(p); pos++; continue; }
      const kw = p.tokens[0] && p.tokens[0].v;
      if (stops.includes(kw)) return { body, stop: kw, stmt: p };
      pos++;
      const ps = new Parser(p.tokens.slice(1));
      if (kw === "if") {
        const branches = [{ c: ps.parseExpr(), body: null }];
        let r = block(["elif", "else", "endif"]);
        branches[0].body = r.body;
        while (r.stop === "elif") { pos++; const pe = new Parser(r.stmt.tokens.slice(1)); const c = pe.parseExpr(); r = block(["elif", "else", "endif"]); branches.push({ c, body: r.body }); }
        let orelse = [];
        if (r.stop === "else") { pos++; r = block(["endif"]); orelse = r.body; }
        if (r.stop !== "endif") throw new TemplateError("missing endif in " + name);
        pos++;
        body.push({ t: "if", branches, orelse });
      } else if (kw === "for") {
        const targets = [ps.expect("name").v];
        while (ps.isOp(",")) { ps.next(); targets.push(ps.expect("name").v); }
        ps.expect("kw", "in");
        const it = ps.parseExpr(true);
        let cond = null;
        if (ps.isKw("if")) { ps.next(); cond = ps.parseExpr(true); }
        let r = block(["else", "endfor"]);
        const loopBody = r.body;
        let orelse = [];
        if (r.stop === "else") { pos++; r = block(["endfor"]); orelse = r.body; }
        if (r.stop !== "endfor") throw new TemplateError("missing endfor in " + name);
        pos++;
        body.push({ t: "for", targets, it, cond, body: loopBody, orelse });
      } else if (kw === "set") {
        const target = [ps.expect("name").v];
        while (ps.isOp(".")) { ps.next(); target.push(ps.expect("name").v); }
        const names = [target];
        while (ps.isOp(",")) { ps.next(); names.push([ps.expect("name").v]); }
        ps.expect("op", "=");
        const value = ps.parseExpr();
        body.push({ t: "set", names, value });
      } else throw new TemplateError("unknown tag '" + kw + "' in " + name);
    }
    if (stops.length) throw new TemplateError("unexpected end of template " + name);
    return { body };
  }
  const tree = block([]).body;
  return { name, tree };
}

// ---------- evaluation ----------
class Scope {
  constructor(parent, vars) { this.parent = parent; this.vars = vars || Object.create(null); }
  lookup(n) { for (let s = this; s; s = s.parent) if (n in s.vars) return s.vars[n]; return UNDEF; }
}
const FILTERS = {
  abs: (v) => (isFloat(v) ? F(Math.abs(v.v)) : Math.abs(num(v))),
  float: (v, d = F(0)) => { if (isNum(v)) return F(num(+v)); const x = parseFloat(pyStr(v).trim()); return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$|^\s*[-+]?(inf|nan)\s*$/i.test(pyStr(v)) ? F(x) : d; },
  int: (v, d = 0) => { if (isNum(v)) return Math.trunc(num(+v)); const s = pyStr(v).trim(); if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10); const f = parseFloat(s); return isNaN(f) ? d : Math.trunc(f); },
  round: (v, p = 0, method = "common") => { const k = 10 ** num(p), x = num(v) * k; const r = method === "ceil" ? Math.ceil(x) : method === "floor" ? Math.floor(x) : Math.sign(x) * Math.round(Math.abs(x)); return F(r / k); },
  lower: (v) => pyStr(v).toLowerCase(), upper: (v) => pyStr(v).toUpperCase(), capitalize: (v) => { const s = pyStr(v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); },
  title: (v) => pyStr(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()), trim: (v) => pyStr(v).trim(),
  default: (v, d = "", boolean = false) => (isUndef(v) || (truthy(boolean) && !truthy(v)) ? d : v),
  length: (v) => (v instanceof PyDict ? v.m.size : iter(v).length), count: (v) => (v instanceof PyDict ? v.m.size : iter(v).length),
  list: (v) => iter(v).slice(), string: (v) => pyStr(v), join: (v, sep = "", attribute) => iter(v).map((x) => pyStr(attribute ? getattr(x, attribute) : x)).join(sep),
  min: (v) => iter(v).reduce((a, b) => (cmp(b, a) < 0 ? b : a)), max: (v) => iter(v).reduce((a, b) => (cmp(b, a) > 0 ? b : a)),
  sum: (v, attribute, start = 0) => iter(v).reduce((a, b) => num(a) + num(attribute ? getattr(b, attribute) : b), start),
  first: (v) => iter(v)[0] ?? UNDEF, last: (v) => { const l = iter(v); return l.length ? l[l.length - 1] : UNDEF; },
  sort: (v, reverse = false) => { const l = iter(v).slice().sort(cmp); return truthy(reverse) ? l.reverse() : l; },
  reverse: (v) => (typeof v === "string" ? [...v].reverse().join("") : iter(v).slice().reverse()), unique: (v) => iter(v).filter((x, i, a) => a.findIndex((y) => pyEq(x, y)) === i),
  replace: (v, a, b) => pyStr(v).split(pyStr(a)).join(pyStr(b)), tojson: (v) => JSON.stringify(toJSON(v)), bool: (v) => truthy(v),
  format: (v, ...a) => percentFormat(pyStr(v), Object.assign(a, { tuple: true })), center: (v, w = 80) => { const s = pyStr(v); const p = Math.max(0, w - s.length); return " ".repeat(p >> 1) + s + " ".repeat(p - (p >> 1)); },
  map: (v, ...a) => { const kw = a[a.length - 1]; return iter(v).map((x) => (kw && kw.attribute ? getattr(x, kw.attribute) : FILTERS[a[0]](x))); },
  e: (v) => v, safe: (v) => v, d: (v, d = "", b = false) => FILTERS.default(v, d, b),
};
function toJSON(v) {
  if (v instanceof PyFloat) return v.v;
  if (Array.isArray(v)) return v.map(toJSON);
  if (v instanceof PyDict) return Object.fromEntries([...v.m].map(([k, x]) => [pyStr(k), toJSON(x)]));
  if (isUndef(v)) return null;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJSON(x)]));
  return v;
}
const TESTS = {
  defined: (v) => !isUndef(v), undefined: (v) => isUndef(v), none: (v) => v === null, number: (v) => isNum(v) && typeof v !== "boolean",
  string: (v) => typeof v === "string", mapping: (v) => v instanceof PyDict || (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat)),
  sequence: (v) => typeof v === "string" || Array.isArray(v), iterable: (v) => typeof v === "string" || Array.isArray(v) || v instanceof PyDict,
  odd: (v) => num(v) % 2 === 1, even: (v) => num(v) % 2 === 0, divisibleby: (v, n) => num(v) % num(n) === 0, eq: (v, x) => pyEq(v, x), ne: (v, x) => !pyEq(v, x),
  boolean: (v) => typeof v === "boolean", integer: (v) => typeof v === "number" && Number.isInteger(v), float: (v) => v instanceof PyFloat, true: (v) => v === true, false: (v) => v === false,
  lower: (v) => typeof v === "string" && v === v.toLowerCase(), upper: (v) => typeof v === "string" && v === v.toUpperCase(), in: (v, c) => contains(c, v),
};
function arith(op, a, b) {
  if (op === "~") return pyStr(a) + pyStr(b);
  if (op === "%" && typeof a === "string") return percentFormat(a, b);
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  if (op === "+" && Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (op === "*" && typeof a === "string" && isNum(b)) return a.repeat(Math.max(0, num(b)));
  if (op === "*" && Array.isArray(a) && isNum(b)) { let r = []; for (let i = 0; i < num(b); i++) r = r.concat(a); return r; }
  if (!isNum(a) || !isNum(b)) throw new TemplateError("TypeError: unsupported operand type(s) for " + op + ": '" + typeName(a) + "' and '" + typeName(b) + "'");
  const x = num(+a), y = num(+b), fl = isFloat(a) || isFloat(b);
  switch (op) {
    case "+": return fl ? F(x + y) : x + y;
    case "-": return fl ? F(x - y) : x - y;
    case "*": return fl ? F(x * y) : x * y;
    case "/": if (y === 0) throw new TemplateError("ZeroDivisionError: division by zero"); return F(x / y);
    case "//": if (y === 0) throw new TemplateError("ZeroDivisionError: integer division or modulo by zero"); return fl ? F(Math.floor(x / y)) : Math.floor(x / y);
    case "%": if (y === 0) throw new TemplateError("ZeroDivisionError: integer modulo by zero"); { const r = ((x % y) + y) % y; return fl ? F(r) : r; }
    case "**": return fl || y < 0 ? F(x ** y) : x ** y;
  }
}
function evalNode(n, sc) {
  switch (n.t) {
    case "lit": return n.v;
    case "name": return sc.lookup(n.name);
    case "list": return n.items.map((x) => evalNode(x, sc));
    case "tuple": return Object.assign(n.items.map((x) => evalNode(x, sc)), { tuple: true });
    case "dict": return new PyDict(n.pairs.map(([k, v]) => [evalNode(k, sc), evalNode(v, sc)]));
    case "attr": return getattr(evalNode(n.o, sc), n.name);
    case "item": return getitem(evalNode(n.o, sc), evalNode(n.k, sc));
    case "slice": { const o = evalNode(n.o, sc), a = n.a ? num(evalNode(n.a, sc)) : undefined, b = n.b ? num(evalNode(n.b, sc)) : undefined; return o.slice(a, b); }
    case "cond": return truthy(evalNode(n.c, sc)) ? evalNode(n.a, sc) : evalNode(n.b, sc);
    case "or": { const a = evalNode(n.a, sc); return truthy(a) ? a : evalNode(n.b, sc); }
    case "and": { const a = evalNode(n.a, sc); return truthy(a) ? evalNode(n.b, sc) : a; }
    case "not": return !truthy(evalNode(n.a, sc));
    case "unary": { const a = evalNode(n.a, sc); if (!isNum(a)) throw new TemplateError("TypeError: bad operand type for unary " + n.op + ": '" + typeName(a) + "'"); return n.op === "-" ? (isFloat(a) ? F(-a.v) : -a) : a; }
    case "bin": return arith(n.op, evalNode(n.a, sc), evalNode(n.b, sc));
    case "cmp": {
      let a = evalNode(n.a, sc);
      for (const [op, bn] of n.ops) {
        const b = evalNode(bn, sc);
        let ok;
        switch (op) {
          case "==": ok = pyEq(a, b); break; case "!=": ok = !pyEq(a, b); break;
          case "<": ok = cmp(a, b) < 0; break; case ">": ok = cmp(a, b) > 0; break; case "<=": ok = cmp(a, b) <= 0; break; case ">=": ok = cmp(a, b) >= 0; break;
          case "in": ok = contains(b, a); break; case "notin": ok = !contains(b, a); break;
        }
        if (!ok) return false;
        a = b;
      }
      return true;
    }
    case "call": {
      const args = n.args.map((x) => evalNode(x, sc)), kw = {};
      for (const k in n.kw) kw[k] = evalNode(n.kw[k], sc);
      const f = evalNode(n.f, sc);
      if (typeof f !== "function") throw new TemplateError("'" + (n.f.name || (n.f.t === "attr" ? n.f.name : "object")) + "' is undefined or not callable");
      return Object.keys(kw).length ? f(...args, kw) : f(...args);
    }
    case "filter": {
      const fn = FILTERS[n.name];
      if (!fn) throw new TemplateError("No filter named '" + n.name + "'.");
      const args = n.args.map((x) => evalNode(x, sc)), kw = {};
      for (const k in n.kw) kw[k] = evalNode(n.kw[k], sc);
      if (n.name === "default" || n.name === "d") return fn(evalNode(n.a, sc), args[0] ?? kw.default_value ?? "", args[1] ?? kw.boolean ?? false);
      if (n.name === "round") return fn(evalNode(n.a, sc), args[0] ?? kw.precision ?? 0, args[1] ?? kw.method ?? "common");
      if (n.name === "map" || n.name === "join" && kw.attribute) return n.name === "join" ? fn(evalNode(n.a, sc), args[0] ?? "", kw.attribute) : fn(evalNode(n.a, sc), ...args, kw);
      return fn(evalNode(n.a, sc), ...args);
    }
    case "test": {
      const fn = TESTS[n.name];
      if (!fn) throw new TemplateError("No test named '" + n.name + "'.");
      const r = fn(evalNode(n.a, sc), ...n.args.map((x) => evalNode(x, sc)));
      return n.neg ? !r : r;
    }
  }
  throw new TemplateError("bad node " + n.t);
}
function run(nodes, sc, out) {
  for (const n of nodes) {
    switch (n.t) {
      case "text": out.push(n.v); break;
      case "expr": out.push(pyStr(evalNode(n.e, sc))); break;
      case "if": {
        let done = false;
        for (const b of n.branches) if (truthy(evalNode(b.c, sc))) { run(b.body, sc, out); done = true; break; }
        if (!done) run(n.orelse, sc, out);
        break;
      }
      case "for": {
        let items = iter(evalNode(n.it, sc));
        const inner = new Scope(sc);
        if (n.cond) items = items.filter((it) => { bindTargets(inner, n.targets, it); return truthy(evalNode(n.cond, inner)); });
        items.forEach((it, idx) => {
          const loop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === items.length - 1, length: items.length, revindex: items.length - idx, revindex0: items.length - idx - 1, previtem: idx ? items[idx - 1] : UNDEF, nextitem: idx < items.length - 1 ? items[idx + 1] : UNDEF };
          const s = new Scope(sc, Object.assign(Object.create(null), { loop }));
          bindTargets(s, n.targets, it);
          run(n.body, s, out);
        });
        if (!items.length) run(n.orelse, sc, out);
        break;
      }
      case "set": {
        const v = evalNode(n.value, sc);
        const vals = n.names.length > 1 ? iter(v) : [v];
        n.names.forEach((path, k) => {
          if (path.length === 1) sc.vars[path[0]] = vals[k];
          else {
            let o = sc.lookup(path[0]);
            for (const p of path.slice(1, -1)) o = getattr(o, p);
            if (!(o instanceof Namespace)) throw new TemplateError("cannot assign attribute on non-namespace object");
            o.d[path[path.length - 1]] = vals[k];
          }
        });
        break;
      }
    }
  }
}
function bindTargets(s, targets, it) {
  if (targets.length === 1) s.vars[targets[0]] = it;
  else { const v = iter(it); targets.forEach((t, i) => (s.vars[t] = v[i])); }
}
export const GLOBALS = {
  range: (a, b, step = 1) => { if (b === undefined) { b = a; a = 0; } const r = []; for (let i = num(a); step > 0 ? i < num(b) : i > num(b); i += num(step)) r.push(i); return r; },
  dict: (v, kw) => { const d = v instanceof PyDict || (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat) && !v.__pycallkw) ? PyDict.from(v) : new PyDict(v ? entries(v) : []); if (kw) for (const k in kw) d.set(k, kw[k]); return d; },
  namespace: (kw) => new Namespace(Object.assign({}, kw || {})),
  lipsum: () => "",
};
export function render(tpl, vars) {
  const sc = new Scope(new Scope(null, Object.assign(Object.create(null), GLOBALS)), Object.assign(Object.create(null), vars));
  const out = [];
  run(tpl.tree, sc, out);
  return out.join("");
}
