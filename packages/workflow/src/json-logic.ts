import type { JsonLogicRule } from "./types.js";

/** JSONLogic 子集（公开文档须自称子集，勿照搬官方全部语义）：
 *  - `==`/`!=` 是 JSON 深比较（对象 key 序敏感）
 *  - `if` 仅严格三元 [cond, then, else]（无 else-if 链、无二参形式）
 *  - `not`/`!!` 接受数组或裸对象两种形式
 *  - `var` 支持 "a.b" 路径与 ["a.b", default]
 */
export const OPS: Record<string, true> = {
  var: true,
  "==": true,
  "!=": true,
  ">": true,
  ">=": true,
  "<": true,
  "<=": true,
  in: true,
  and: true,
  or: true,
  not: true,
  if: true,
  "!!": true,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return deepEqual(a, b) ? 0 : -1;
}

function pathGet(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Evaluate a JSONLogic-subset rule against `data`. */
export function evalJsonLogic(rule: JsonLogicRule | undefined, data: unknown): unknown {
  if (rule === undefined || rule === null) return null;
  if (Array.isArray(rule)) return rule.map((r) => evalJsonLogic(r, data));
  if (!isObject(rule)) return rule;
  const entries = Object.entries(rule);
  if (entries.length === 1) {
    const [op, rawArgs] = entries[0]!;
    if (OPS[op] === true) {
      const args = Array.isArray(rawArgs)
        ? (rawArgs as JsonLogicRule[])
        : [rawArgs as JsonLogicRule];
      switch (op) {
        case "var": {
          if (typeof rawArgs === "string") return pathGet(data, rawArgs) ?? null;
          if (Array.isArray(rawArgs)) {
            const [path, dflt] = rawArgs as unknown[];
            const v = typeof path === "string" ? pathGet(data, path) : undefined;
            if (v !== undefined) return v;
            if (dflt === undefined) return null;
            return evalJsonLogic(dflt as JsonLogicRule, data);
          }
          return null;
        }
        case "==": {
          return deepEqual(evalJsonLogic(args[0], data), evalJsonLogic(args[1], data));
        }
        case "!=": {
          return !deepEqual(evalJsonLogic(args[0], data), evalJsonLogic(args[1], data));
        }
        case ">":
        case ">=":
        case "<":
        case "<=": {
          const c = compare(evalJsonLogic(args[0], data), evalJsonLogic(args[1], data));
          if (op === ">") return c > 0;
          if (op === ">=") return c >= 0;
          if (op === "<") return c < 0;
          return c <= 0;
        }
        case "in": {
          const av = evalJsonLogic(args[0], data);
          const bv = evalJsonLogic(args[1], data);
          if (typeof bv === "string") return typeof av === "string" && bv.includes(av);
          if (Array.isArray(bv)) return bv.some((x) => deepEqual(x, av));
          return false;
        }
        case "and": {
          let acc: unknown = true;
          for (const r of args) {
            acc = evalJsonLogic(r, data);
            if (!truthy(acc)) return acc;
          }
          return acc;
        }
        case "or": {
          let acc: unknown = false;
          for (const r of args) {
            acc = evalJsonLogic(r, data);
            if (truthy(acc)) return acc;
          }
          return acc;
        }
        case "not": {
          return !truthy(evalJsonLogic(args[0], data));
        }
        case "!!": {
          return truthy(evalJsonLogic(args[0], data));
        }
        case "if": {
          return truthy(evalJsonLogic(args[0], data))
            ? evalJsonLogic(args[1], data)
            : evalJsonLogic(args[2], data);
        }
      }
    }
  }
  // Plain object = data — evaluate each value.
  return Object.fromEntries(entries.map(([k, v]) => [k, evalJsonLogic(v as JsonLogicRule, data)]));
}
