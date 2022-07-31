import { parse } from '@messageformat/parser';
import type * as AST from '@messageformat/parser';
import {
  Expression,
  isLiteral,
  Literal,
  Message,
  Option,
  VariableRef,
  Variant
} from 'messageformat';

/** @beta */
export type MF1Options = {
  /** See {@link @messageformat/parser#ParseOptions.strict} */
  strict?: boolean;
};

const isAstSelect = (token: AST.Token): token is AST.Select =>
  token.type === 'plural' ||
  token.type === 'select' ||
  token.type === 'selectordinal';

interface SelectArg {
  type: 'plural' | 'select' | 'selectordinal';
  arg: string;
  keys: (string | number)[];
  pluralOffset?: number;
}

const asPluralKey = (key: string) =>
  /^=\d+$/.test(key) ? Number(key.substring(1)) : key;

function asSelectArg(sel: AST.Select) {
  const isPlural = sel.type !== 'select';
  const keys = sel.cases.map(c => (isPlural ? asPluralKey(c.key) : c.key));
  const arg: SelectArg = { type: sel.type, arg: sel.arg, keys };
  if ('pluralOffset' in sel) arg.pluralOffset = sel.pluralOffset;
  return arg;
}

const equalSelectArgs = (a: SelectArg | AST.Select) => (b: SelectArg) =>
  a.arg === b.arg && a.pluralOffset === b.pluralOffset && a.type === b.type;

function findSelectArgs(tokens: AST.Token[]): SelectArg[] {
  const args: SelectArg[] = [];
  const add = (arg: SelectArg) => {
    const prev = args.find(equalSelectArgs(arg));
    if (prev) for (const key of arg.keys) prev.keys.push(key);
    else args.push(arg);
  };
  for (const token of tokens)
    if (isAstSelect(token)) {
      add(asSelectArg(token));
      for (const c of token.cases)
        for (const arg of findSelectArgs(c.tokens)) add(arg);
    }
  return args;
}

function tokenToPart(
  token: AST.Token,
  pluralArg: string | null,
  pluralOffset: number | null
): Literal | VariableRef | Expression {
  switch (token.type) {
    case 'content':
      return { type: 'literal', value: token.value };
    case 'argument':
      return { type: 'variable', name: token.arg };
    case 'function': {
      const fn: Expression = {
        type: 'expression',
        name: token.key,
        operand: { type: 'variable', name: token.arg }
      };
      if (token.param && token.param.length > 0) {
        let value = '';
        for (const pt of token.param) {
          if (pt.type === 'content') value += pt.value;
          else throw new Error(`Unsupported param type: ${pt.type}`);
        }
        fn.options = [{ name: 'param', value: { type: 'literal', value } }];
      }
      return fn;
    }
    case 'octothorpe': {
      if (!pluralArg) return { type: 'literal', value: '#' };
      const fn: Expression = {
        type: 'expression',
        name: 'number',
        operand: { type: 'variable', name: pluralArg }
      };
      if (pluralOffset)
        fn.options = [
          {
            name: 'pluralOffset',
            value: { type: 'literal', value: String(pluralOffset) }
          }
        ];
      return fn;
    }
    /* istanbul ignore next - never happens */
    default:
      throw new Error(`Unsupported token type: ${token.type}`);
  }
}

function argToPart({
  arg,
  pluralOffset,
  type
}: SelectArg): VariableRef | Expression {
  const argVar: VariableRef = { type: 'variable', name: arg };
  if (type === 'select') return argVar;

  const options: Option[] = [];
  if (pluralOffset) {
    options.push({
      name: 'pluralOffset',
      value: { type: 'literal', value: String(pluralOffset) }
    });
  }
  if (type === 'selectordinal') {
    options.push({
      name: 'type',
      value: { type: 'literal', value: 'ordinal' }
    });
  }

  return {
    type: 'expression',
    name: 'number',
    operand: argVar,
    options
  };
}

/**
 * Compile an ICU MessageFormat 1 message into a {@link messageformat#Message} data object.
 *
 * @beta
 * @param src - A Fluent resource, as the string contents of an FTL file.
 * @param options - See {@link MF1Options}
 */
export function mf1ToMessageData(
  src: string,
  { strict }: MF1Options = {}
): Message {
  const ast = parse(src, { strict });
  return astToMessage(ast);
}

/**
 * Converts the `@messageformat/parser` AST representation of a
 * MessageFormat 1 message into the corresponding MessageFormat 2
 * data model.
 *
 * If the source message contains any inner selectors, they will be
 * lifted into a single top-level selector.
 *
 * In addition to `number` and other default MF1 formatters, a
 * `plural` runtime function is expected, accepting these options:
 * ```ts
 * {
 *   pluralOffset?: number
 *   type: 'cardinal' | 'ordinal' = 'cardinal'
 * }
 * ```
 *
 * Only literal values are supported in formatter parameters. Any
 * such value will be passed in as an option `{ param: string }`.
 */
function astToMessage(ast: AST.Token[]): Message {
  const args = findSelectArgs(ast);
  if (args.length === 0)
    return {
      type: 'message',
      declarations: [],
      pattern: { body: ast.map(token => tokenToPart(token, null, null)) }
    };

  // First determine the keys for all cases, with empty values
  let keys: (string | number)[][] = [];
  for (let i = 0; i < args.length; ++i) {
    const kk = Array.from(new Set(args[i].keys));
    kk.sort((a, b) => {
      if (typeof a === 'number' || b === 'other') return -1;
      if (typeof b === 'number' || a === 'other') return 1;
      return 0;
    });
    if (i === 0) keys = kk.map(key => [key]);
    else
      for (let i = keys.length - 1; i >= 0; --i)
        keys.splice(i, 1, ...kk.map(key => [...keys[i], key]));
  }
  const variants: Variant[] = keys.map(key => ({
    keys: key.map(k =>
      k === 'other' ? { type: '*' } : { type: 'nmtoken', value: String(k) }
    ),
    value: { body: [] }
  }));

  /**
   * This reads `args` and modifies `cases`
   *
   * @param pluralArg - Required by # octothorpes
   * @param filter - Selects which cases we're adding to
   */
  function addParts(
    tokens: readonly AST.Token[],
    pluralArg: string | null,
    pluralOffset: number | null,
    filter: readonly { idx: number; value: string | number }[]
  ) {
    for (const token of tokens) {
      if (isAstSelect(token)) {
        const isPlural = token.type !== 'select';
        const pa = isPlural ? token.arg : pluralArg;
        const po = isPlural ? token.pluralOffset || null : pluralOffset;
        const idx = args.findIndex(equalSelectArgs(token));
        for (const c of token.cases) {
          const value = isPlural ? asPluralKey(c.key) : c.key;
          addParts(c.tokens, pa, po, [...filter, { idx, value }]);
        }
      } else {
        for (const v of variants) {
          const vp = v.value.body;
          if (
            filter.every(({ idx, value }) => {
              const vi = v.keys[idx];
              return vi.type === '*'
                ? value === 'other'
                : String(value) === vi.value;
            })
          ) {
            const last = vp[vp.length - 1];
            const part = tokenToPart(token, pluralArg, pluralOffset);
            if (isLiteral(last) && isLiteral(part)) {
              last.value += part.value;
            } else vp.push(part);
          }
        }
      }
    }
  }
  addParts(ast, null, null, []);

  return {
    type: 'select',
    declarations: [],
    selectors: args.map(argToPart),
    variants
  };
}