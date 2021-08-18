import {
  Function,
  isFunction,
  isLiteral,
  isSelect,
  isTerm,
  isVariable,
  LiteralValue,
  Message,
  Meta,
  Options,
  Part,
  Pattern,
  RuntimeType,
  Select,
  Term,
  Variable
} from './data-model';
import { FormattedSelectMeta, getFormattedSelectMeta } from './detect-grammar';
import { Context, extendContext } from './format-context';

export type FormattedMeta = Record<string, string | number | boolean | null>;

export abstract class Formatted<T> {
  abstract type: 'dynamic' | 'fallback' | 'literal' | 'message';
  abstract valueOf(): T | string;

  #locales: string[];
  value: T;
  declare meta?: FormattedMeta;

  constructor(
    locales: string[],
    value: T | Formatted<T> | FormattedMessage<unknown>,
    meta?: Meta
  ) {
    this.#locales = locales;
    if (value instanceof Formatted) {
      this.value = value.valueOf() as T; // T is always string for FormattedMessage value
      if (value.meta) addMeta(this, value.meta);
    } else this.value = value;
    if (meta) addMeta(this, meta);
  }

  toString() {
    // TS doesn't believe toLocaleString is defined for ~everything
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = this.value;
    return v != null && typeof v.toLocaleString === 'function'
      ? v.toLocaleString(this.#locales)
      : String(v);
  }
}

export class FormattedDynamic<T = string> extends Formatted<T> {
  type = 'dynamic' as const;
  valueOf() {
    return this.value;
  }
}
export class FormattedFallback extends Formatted<string> {
  type = 'fallback' as const;
  toString() {
    return `{${this.value}}`;
  }
  valueOf() {
    return this.toString();
  }
}
export class FormattedLiteral<
  T extends LiteralValue = LiteralValue
> extends Formatted<T> {
  type = 'literal' as const;
  valueOf() {
    return this.value;
  }
}
export class FormattedMessage<T = unknown> extends Formatted<
  FormattedPart<T>[]
> {
  type = 'message' as const;
  toString() {
    let res = '';
    for (const fp of this.value) res += fp.toString();
    return res;
  }
  valueOf() {
    return this.toString();
  }
}

export type FormattedPart<T = unknown> =
  | FormattedDynamic<T>
  | FormattedFallback
  | FormattedMessage<T>
  // should be FormattedLiteral<T>, but TS can't cope with it
  | (T extends LiteralValue ? FormattedLiteral : never);

function addMeta(fmt: Formatted<unknown>, meta: Meta) {
  if (!fmt.meta) fmt.meta = {};
  for (let [key, value] of Object.entries(meta)) {
    if (key in fmt.meta) continue;
    if (typeof value === 'object') {
      if (!value) {
        fmt.meta[key] = null;
        continue;
      } else if (typeof value.valueOf === 'function') {
        // handle e.g. instances of Boolean, Number & String
        value = value.valueOf();
      }
    }
    switch (typeof value) {
      case 'boolean':
      case 'number':
      case 'string':
        fmt.meta[key] = value;
    }
  }
}

export function formatToString<R, S>(ctx: Context<R, S>, msg: Message) {
  let res = '';
  for (const fp of formatToParts(ctx, msg)) res += fp.toString();
  return res;
}

export function formatToParts<R, S>(
  ctx: Context<R, S>,
  { meta, value }: Message
): FormattedPart<R | S | LiteralValue>[] {
  let fsm: FormattedSelectMeta | null = null;
  const pattern = isSelect(value)
    ? resolveSelect(ctx, value, _fsm => (fsm = _fsm))
    : value;
  const res = pattern.map(part => resolvePart(ctx, part));
  if (meta || fsm) {
    const fm = new FormattedMessage<R | S | LiteralValue>(
      ctx.locales,
      res,
      meta
    );
    if (fsm) addMeta(fm, fsm);
    return [fm];
  } else return res;
}

function resolvePart<R, S>(
  ctx: Context<R, S>,
  part: Part
):
  | FormattedDynamic<R | S>
  | FormattedFallback
  | FormattedLiteral
  | FormattedMessage<R | S | LiteralValue> {
  if (isLiteral(part))
    return new FormattedLiteral(ctx.locales, part.value, part.meta);
  if (isVariable(part)) return resolveVariable(ctx, part);
  if (isFunction(part)) return resolveFormatFunction(ctx, part);
  if (isTerm(part)) return resolveTerm(ctx, part);
  /* istanbul ignore next - never happens */
  throw new Error(`Unsupported part: ${part}`);
}

function resolveArgument<R, S>(
  ctx: Context<R, S>,
  part: Part
): S | string | number {
  if (isLiteral(part)) return part.value;
  if (isVariable(part)) return resolveVariable(ctx, part).valueOf();
  throw new Error(`Unsupported function argument: ${part}`);
}

function resolveOptions<R, S>(
  ctx: Context<R, S>,
  options: Options | undefined,
  expected: RuntimeType | Record<string, RuntimeType> | undefined
) {
  const opt: Record<string, string | number | boolean | S> = {};
  const getExpected =
    !expected || typeof expected === 'string' || Array.isArray(expected)
      ? () => expected
      : (key: string) => expected[key];
  if (options && expected)
    for (const [key, value] of Object.entries(options)) {
      const exp = getExpected(key);
      if (!exp || exp === 'never') continue; // TODO: report error
      const res = isVariable(value)
        ? resolveArgument(ctx, value)
        : exp === 'boolean'
        ? value === 'true'
          ? true
          : value === 'false'
          ? false
          : value
        : exp === 'number'
        ? Number(value)
        : value;

      if (
        exp === 'any' ||
        exp === typeof res ||
        (Array.isArray(exp) && typeof res === 'string' && exp.includes(res))
      )
        opt[key] = res;
      // TODO: else report error
    }
  return opt;
}

function resolveFormatFunction<R, S>(
  ctx: Context<R, S>,
  fn: Function
):
  | FormattedDynamic<R>
  | FormattedFallback
  | FormattedMessage<R | S | LiteralValue> {
  const { args, func, options } = fn;
  const rf = ctx.runtime.format[func];
  const fnArgs = args.map(arg => resolveArgument(ctx, arg));
  const fnOpt = resolveOptions(ctx, options, rf?.options);
  try {
    const value = rf.call(ctx.locales, fnOpt, ...fnArgs);
    if (value instanceof Formatted && !(value instanceof FormattedLiteral)) {
      if (fn.meta) addMeta(value, fn.meta);
      return value as
        | FormattedDynamic<R>
        | FormattedFallback
        | FormattedMessage<R | S | LiteralValue>;
    }
    return new FormattedDynamic(ctx.locales, value as R, fn.meta);
  } catch (error) {
    const fb = resolveFallback(ctx, fn);
    addMeta(fb, {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack
    });
    return fb;
  }
}

function resolveTerm<R, S>(
  ctx: Context<R, S>,
  term: Term
): FormattedMessage<R | S | LiteralValue> | FormattedFallback {
  const { msg_path, res_id, scope } = term;
  const strPath = msg_path.map(part => String(resolvePart(ctx, part)));
  const msg = ctx.getMessage(res_id, strPath);
  if (!msg) return resolveFallback(ctx, term);
  if (res_id || scope) {
    const opt = scope ? resolveOptions(ctx, scope, 'any') : null;
    const msgScope = Object.assign({}, ctx.scope, opt);
    // Let's not check typings of Term scope overrides
    ctx = extendContext(ctx, res_id, msgScope) as Context<R, S>;
  }
  return new FormattedMessage(ctx.locales, formatToParts(ctx, msg), term.meta);
}

export type ResolvedSelector = {
  value: LiteralValue | LiteralValue[];
  default: LiteralValue;
};

function resolveSelect<R, S>(
  ctx: Context<R, S>,
  select: Select,
  onMeta?: (meta: FormattedSelectMeta) => void
): Pattern {
  const res: ResolvedSelector[] = select.select.map(s => {
    const r = isFunction(s.value)
      ? resolveSelectFunction(ctx, s.value)
      : resolvePart(ctx, s.value);
    const v = r instanceof Formatted ? r.valueOf() : r;
    let value: LiteralValue | LiteralValue[];
    if (typeof v === 'number') {
      const { plural } = ctx.runtime.select;
      if (typeof plural === 'object' && typeof plural.call === 'function') {
        try {
          const r = plural.call(ctx.locales, undefined, v);
          value = r instanceof Formatted ? r.valueOf() : r;
        } catch (_) {
          value = v;
        }
      } else value = v;
    } else value = typeof v === 'string' || Array.isArray(v) ? v : String(v);
    return { value, default: s.default || 'other' };
  });

  for (const { key, value } of select.cases) {
    if (
      key.every((k, i) => {
        const r = res[i];
        return (
          k === r.default ||
          k === r.value ||
          (Array.isArray(r.value) && r.value.includes(k))
        );
      })
    ) {
      if (onMeta) {
        const meta = getFormattedSelectMeta(select, res, key);
        if (meta) onMeta(meta);
      }
      return value;
    }
  }
  return [];
}

function resolveSelectFunction<R, S>(
  ctx: Context<R, S>,
  { args, func, options }: Function
) {
  const fn = ctx.runtime.select[func];
  const fnArgs = args.map(arg => resolveArgument(ctx, arg));
  const fnOpt = resolveOptions(ctx, options, fn?.options);
  try {
    return fn.call(ctx.locales, fnOpt, ...fnArgs);
  } catch (_) {
    return isLiteral(fnArgs[0]) ? fnArgs[0] : String(fnArgs[0]);
  }
}

function resolveVariable<R, S>(
  ctx: Context<R, S>,
  part: Variable
): FormattedDynamic<S> | FormattedFallback {
  const { var_path } = part;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let val: any = var_path.length > 0 ? ctx.scope : undefined;
  for (const p of var_path) {
    if (!val || typeof val !== 'object') {
      val = undefined;
      break;
    }
    val = val[resolveArgument(ctx, p)];
  }
  return val === undefined
    ? resolveFallback(ctx, part)
    : new FormattedDynamic(ctx.locales, val, part.meta);
}

function resolveFallback(ctx: Context<unknown, unknown>, part: Part) {
  return new FormattedFallback(
    ctx.locales,
    fallbackValue(ctx, part),
    part.meta
  );
}

function fallbackValue(ctx: Context<unknown, unknown>, part: Part): string {
  const resolve = (p: Part) => resolvePart(ctx, p).valueOf();
  if (isLiteral(part)) return String(part.value);
  if (isVariable(part)) {
    const path = part.var_path.map(resolve);
    return '$' + path.join('.');
  }
  if (isFunction(part)) {
    const args = part.args.map(resolve);
    if (part.options)
      for (const [key, value] of Object.entries(part.options))
        args.push(`${key}: ${value}`);
    return `${part.func}(${args.join(', ')})`;
  }
  if (isTerm(part)) {
    let name = part.msg_path.map(resolve).join('.');
    if (part.res_id) name = part.res_id + '::' + name;
    if (!part.scope) return '-' + name;
    const scope = Object.entries(part.scope).map(([key, value]) => {
      const vs = Array.isArray(value)
        ? `[${value.join(', ')}]`
        : typeof value === 'object'
        ? resolve(value)
        : String(value);
      return `${key}: ${vs}`;
    });
    return `-${name}(${scope.join(', ')})`;
  }
  return String(part);
}
