const fail = code => Object.assign(new Error(code), { code });
const maxTokens = 1_000_000;
const idStart = char => /[A-Za-z_$]/u.test(char || '');
const idPart = char => /[A-Za-z0-9_$]/u.test(char || '');
const regexPrefixWords = new Set(['await','case','delete','do','else','in','instanceof','new','of','return','throw','typeof','void','yield']);
const regexPrefixPunctuation = new Set(['!','!=','!==','%','%=','&','&&','&&=','&=','(','*','**','**=','*=','+','+=',',','-','-=','->','.','/','/=',':',';','<','<<','<<=','<=','=','==','===','>','>=','>>','>>=','?','??','??=','?.','[','^','^=','{','|','|=','||','||=','~']);

function regexMayStart(tokens) {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (previous.type === 'identifier') return regexPrefixWords.has(previous.value);
  if (previous.type === 'punctuation') {
    if (previous.value === ')') {
      let depth = 0;
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index].type === 'punctuation' && tokens[index].value === ')') depth += 1;
        else if (tokens[index].type === 'punctuation' && tokens[index].value === '(' && --depth === 0) {
          return ['catch','for','if','switch','while','with'].includes(tokens[index - 1]?.value);
        }
      }
      return false;
    }
    return regexPrefixPunctuation.has(previous.value);
  }
  return false;
}

function readString(source, start) {
  const quote = source[start];
  let index = start + 1;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { escaped = true; index += 2; continue; }
    if (char === quote) return { token: { type: 'string', value: source.slice(start + 1, index), escaped }, next: index + 1 };
    if (char === '\n' || char === '\r') throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
    index += 1;
  }
  throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
}

function readRegex(source, start) {
  let index = start + 1;
  let escaped = false;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\n' || char === '\r') throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
    if (escaped) { escaped = false; index += 1; continue; }
    if (char === '\\') { escaped = true; index += 1; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index += 1;
      while (idPart(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
}

function readTemplate(source, start) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { index += 2; continue; }
    if (char === '`') return index + 1;
    if (char === '$' && source[index + 1] === '{') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    index += 1;
  }
  throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
}

function tokenize(source) {
  const tokens = [];
  const push = token => { tokens.push(token); if (tokens.length > maxTokens) throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_LIMIT'); };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const parsed = readString(source, index);
      push(parsed.token); index = parsed.next; continue;
    }
    if (char === '`') {
      push({ type: 'template', value: null }); index = readTemplate(source, index); continue;
    }
    if (char === '/' && tokens[tokens.length - 1]?.type === 'punctuation' && tokens[tokens.length - 1].value === '}') {
      throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
    }
    if (char === '/' && regexMayStart(tokens)) {
      push({ type: 'regex', value: null }); index = readRegex(source, index); continue;
    }
    if (char === '\\' || char.charCodeAt(0) > 127) throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
    if (idStart(char)) {
      const start = index++;
      while (idPart(source[index])) index += 1;
      push({ type: 'identifier', value: source.slice(start, index) }); continue;
    }
    if (/[0-9]/u.test(char)) {
      index += 1;
      while (/[A-Za-z0-9_.]/u.test(source[index] || '')) index += 1;
      push({ type: 'number', value: null }); continue;
    }
    const operator = ['===','!==','>>>','**=','&&=','||=','??=','=>','?.','++','--','==','!=','<=','>=','&&','||','??','<<','>>','+=','-=','*=','/=','%=','&=','|=','^=','**'].find(value => source.startsWith(value, index));
    const value = operator || char;
    push({ type: 'punctuation', value }); index += value.length;
  }
  return tokens;
}

export function scanCommonJsRequests(source) {
  if (typeof source !== 'string') throw fail('BUILTIN_STAGE_CLOSURE_LEXICAL_UNKNOWN');
  const tokens = tokenize(source);
  const requests = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier') continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (['__dirname','__filename'].includes(token.value)) throw fail('BUILTIN_STAGE_CLOSURE_ASSET_ACCESS');
    if (token.value === 'process' && (next?.value === '.' || next?.value === '[')) throw fail('BUILTIN_STAGE_CLOSURE_ASSET_ACCESS');
    if (token.value === 'import' && next?.value === '.' && tokens[index + 2]?.value === 'meta') {
      throw fail('BUILTIN_STAGE_CLOSURE_ASSET_ACCESS');
    }
    if (token.value === 'import' || token.value === 'export') {
      if (previous?.value !== '.' && previous?.value !== '?.') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    }
    if (token.value === 'runtimeRequire') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    if (['createRequire','eval','Function'].includes(token.value) && next?.value === '(') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    if (token.value === 'module' && ((next?.value === '.' && tokens[index + 2]?.value === 'require' && tokens[index + 3]?.value === '(')
      || (next?.value === '[' && tokens[index + 2]?.type === 'string' && tokens[index + 2].value === 'require' && tokens[index + 3]?.value === ']'))) {
      throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    }
    if (token.value !== 'require') continue;
    if (previous?.value === '.' || previous?.value === '?.') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    if (next?.value !== '(') throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    const argument = tokens[index + 2];
    if (argument?.type !== 'string' || argument.escaped || tokens[index + 3]?.value !== ')') {
      throw fail('BUILTIN_STAGE_CLOSURE_DYNAMIC_LOAD');
    }
    requests.push(argument.value);
  }
  return requests;
}
