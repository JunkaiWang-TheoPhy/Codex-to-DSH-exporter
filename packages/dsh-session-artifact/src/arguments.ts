/**
 * Recovery of a `custom_tool_call`'s arguments.
 *
 * `function_call` carries `arguments` as a JSON string. `custom_tool_call`
 * carries `input`, which is free-form: `apply_patch` writes a patch script,
 * while newer Codex releases write JavaScript — `tools.exec_command({...})`, a
 * bare object literal, or a parenthesised expression. Passing that text
 * through unchanged would hand a model a call format it cannot parse, because
 * a tool-call block's `arguments` is JSON.
 *
 * The converter recognizes the JavaScript call shapes, extracts the outermost
 * object literal, and translates it with a small recursive-descent reader that
 * never evaluates anything. Anything it does not support falls back to the
 * original input encoded as a JSON string, so a record is preserved rather
 * than guessed at.
 *
 * Ported from `lib/convert/codex.mjs` (`codexCustomToolArguments` and
 * `jsObjectLiteralToJson`), the vendored upstream implementation of this rule.
 *
 * @module
 */

/** JSON argument text, plus whether a JavaScript shape failed to convert. */
export interface CodexToolArguments {
  /** Argument text that parses as JSON. */
  readonly arguments: string;
  /**
   * True when the input was recognized as JavaScript but could not be
   * converted, so the original text was kept as a JSON string instead.
   */
  readonly fallback: boolean;
}

/**
 * Convert a `custom_tool_call` `input` into JSON argument text.
 *
 * A non-string input is JSON-encoded directly. Patch scripts and other
 * free-form text are not JavaScript call shapes, so they are encoded as a JSON
 * string without entering the converter.
 * @param input - the raw `payload.input`.
 * @returns the argument text and whether a JavaScript shape had to be kept raw.
 */
export function codexCustomToolArguments(input: unknown): CodexToolArguments {
  if (typeof input !== 'string') return { arguments: JSON.stringify(input ?? {}), fallback: false };
  const text = input.trim();
  if (text.length === 0 || !codexJsArgsShape(text)) {
    return { arguments: JSON.stringify(input), fallback: false };
  }
  const start = findObjectStart(text);
  if (start === -1) return { arguments: JSON.stringify(input), fallback: true };
  const end = findMatchingBrace(text, start);
  if (end === -1) return { arguments: JSON.stringify(input), fallback: true };
  const json = jsObjectLiteralToJson(text.slice(start, end + 1));
  if (json === null) return { arguments: JSON.stringify(input), fallback: true };
  return { arguments: json, fallback: false };
}

/**
 * Whether a `custom_tool_call` input is written as JavaScript.
 *
 * Matches a bare object literal, a parenthesised expression (IIFE, arrow
 * function, `Promise.all`), a `name(...)` or `tools.name(...)` call, and a
 * call fragment behind an assignment or `return`.
 */
function codexJsArgsShape(text: string): boolean {
  return /^\{/.test(text)
    || /^\(/.test(text)
    || /^(?:return\s+|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(text);
}

/** Locate the first `{` outside a string or template literal. */
function findObjectStart(text: string): number {
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipJsString(text, i);
      continue;
    }
    if (ch === '`') {
      i = skipJsTemplate(text, i);
      continue;
    }
    if (ch === '{') return i;
    i += 1;
  }
  return -1;
}

/** Find the `}` matching the `{` at `start`, ignoring braces inside literals. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length;) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipJsString(text, i);
      continue;
    }
    if (ch === '`') {
      i = skipJsTemplate(text, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Skip a single- or double-quoted string, returning the index past its end. */
function skipJsString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length;) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i += 1;
    if (ch === quote) return i;
  }
  return text.length;
}

/** Skip a template literal, including `${...}` substitutions. */
function skipJsTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length;) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const inner = text[i];
        if (inner === '"' || inner === "'") {
          i = skipJsString(text, i);
          continue;
        }
        if (inner === '`') {
          i = skipJsTemplate(text, i);
          continue;
        }
        if (inner === '{') {
          depth += 1;
          i += 1;
          continue;
        }
        if (inner === '}') {
          depth -= 1;
          i += 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
    if (ch === '`') return i;
  }
  return text.length;
}

/**
 * Translate a JavaScript object literal into JSON text.
 *
 * Supports string keys and values (single or double quoted, with the common
 * escapes), unquoted identifier keys, numbers, `true`/`false`/`null`, arrays,
 * and nested objects. Function calls, variable references, comments, trailing
 * commas, template-string values, and hexadecimal numbers are unsupported and
 * return `null`, which the caller answers by keeping the original text.
 * @param src - the object literal, including its braces.
 * @returns JSON text, or `null` when the literal uses an unsupported shape.
 */
export function jsObjectLiteralToJson(src: string): string | null {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`unsupported JS object literal at ${i}`);
  };
  const skipWs = (): void => {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i += 1;
  };
  const parseString = (): string => {
    const quote = src[i];
    i += 1;
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === quote) {
        i += 1;
        return out;
      }
      if (ch !== '\\') {
        out += ch;
        i += 1;
        continue;
      }
      i += 1;
      const escaped = src[i];
      switch (escaped) {
        case 'n': out += '\n'; i += 1; break;
        case 't': out += '\t'; i += 1; break;
        case 'r': out += '\r'; i += 1; break;
        case 'b': out += '\b'; i += 1; break;
        case 'f': out += '\f'; i += 1; break;
        case 'v': out += '\v'; i += 1; break;
        case '0': out += '\0'; i += 1; break;
        case 'u': {
          i += 1;
          if (src[i] === '{') {
            // `\u{...}`: one to six hexadecimal code units.
            let hex = '';
            i += 1;
            while (i < src.length && /[0-9a-fA-F]/.test(src[i])) {
              hex += src[i];
              i += 1;
            }
            if (src[i] !== '}' || hex.length === 0 || hex.length > 6) fail();
            const codePoint = parseInt(hex, 16);
            if (codePoint > 0x10ffff) fail();
            out += String.fromCodePoint(codePoint);
            i += 1;
          } else {
            const hex = src.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          }
          break;
        }
        case 'x': {
          i += 1;
          const hex = src.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
          break;
        }
        default:
          // Identity escapes (`\\`, `\'`, `\"`) and unknown escapes take the
          // character as written, matching JavaScript's own behaviour.
          out += escaped;
          i += 1;
      }
    }
    return fail(); // unterminated string
  };
  const parseIdentifier = (): string => {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (match === null) return fail();
    i += match[0].length;
    return match[0];
  };
  const parseNumber = (): number => {
    const match = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (match === null) return fail();
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return fail();
    i += match[0].length;
    return value;
  };
  const parseValue = (): unknown => {
    skipWs();
    if (i >= src.length) fail();
    const ch = src[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (src.startsWith('true', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4;
      return true;
    }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_$]/.test(src[i + 5] ?? '')) {
      i += 5;
      return false;
    }
    if (src.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4;
      return null;
    }
    return fail();
  };
  const parseArray = (): unknown[] => {
    i += 1; // '['
    const array: unknown[] = [];
    skipWs();
    if (src[i] === ']') {
      i += 1;
      return array;
    }
    for (;;) {
      array.push(parseValue());
      skipWs();
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      if (src[i] === ']') {
        i += 1;
        return array;
      }
      fail();
    }
  };
  const parseObject = (): Record<string, unknown> => {
    i += 1; // '{'
    const object: Record<string, unknown> = {};
    skipWs();
    if (src[i] === '}') {
      i += 1;
      return object;
    }
    for (;;) {
      skipWs();
      const key = src[i] === '"' || src[i] === "'" ? parseString() : parseIdentifier();
      skipWs();
      if (src[i] !== ':') fail();
      i += 1;
      object[key] = parseValue();
      skipWs();
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      if (src[i] === '}') {
        i += 1;
        return object;
      }
      fail();
    }
  };
  const parseTop = (): string => {
    skipWs();
    const value = parseValue();
    skipWs();
    if (i !== src.length) fail();
    return JSON.stringify(value);
  };
  try {
    return parseTop();
  } catch {
    // Unsupported shapes (calls, expressions, comments, trailing commas,
    // template-string values) return null so the caller keeps the input.
    return null;
  }
}
