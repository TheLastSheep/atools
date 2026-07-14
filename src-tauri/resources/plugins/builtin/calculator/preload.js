/**
 * Calculator plugin - evaluate math expressions
 *
 * Feature code: calculator
 * Triggers: typing "计算器" or "calc"
 */

utools.onPluginEnter(({ code, type, payload }) => {
  if (type === 'regex' && payload) {
    // Direct calculation from regex match
    try {
      const result = safeEval(payload);
      utools.outPlugin({
        items: [{
          title: `${payload} = ${result}`,
          description: '点击复制结果',
          data: result.toString()
        }]
      });
    } catch (e) {
      utools.outPlugin({
        items: [{
          title: '计算错误',
          description: e.message
        }]
      });
    }
  } else {
    utools.setSubInput({
      placeholder: '输入数学表达式，如: 2 + 3 * 4',
      focus: true
    });
  }
});

utools.onSubInput(({ text }) => {
  if (!text.trim()) {
    utools.outPlugin({ items: [] });
    return;
  }

  try {
    const result = safeEval(text);
    utools.outPlugin({
      items: [{
        title: `${text} = ${result}`,
        description: '点击复制结果',
        data: result.toString()
      }]
    });
  } catch (e) {
    utools.outPlugin({
      items: [{
        title: '计算错误',
        description: e.message
      }]
    });
  }
});

// Safe expression evaluator - no eval() used
function safeEval(expr) {
  const tokens = tokenize(expr);
  const ast = parse(tokens);
  return evaluate(ast);
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Number
    if (/\d/.test(ch) || ch === '.') {
      let num = '';
      while (i < expr.length && (/\d/.test(expr[i]) || expr[i] === '.')) {
        num += expr[i++];
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // Identifier (variable or function name)
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        id += expr[i++];
      }
      tokens.push({ type: 'identifier', value: id });
      continue;
    }

    // Operator or parenthesis
    if ('+-*/^%(),'.includes(ch)) {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }

    throw new Error(`不支持的字符: ${ch}`);
  }

  return tokens;
}

function parse(tokens) {
  let pos = 0;

  function parseExpression() {
    let left = parseTerm();

    while (pos < tokens.length && tokens[pos].type === 'operator') {
      const op = tokens[pos].value;
      if (op === '+' || op === '-') {
        pos++;
        const right = parseTerm();
        left = { type: 'binary', op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  function parseTerm() {
    let left = parsePower();

    while (pos < tokens.length && tokens[pos].type === 'operator') {
      const op = tokens[pos].value;
      if (op === '*' || op === '/' || op === '%') {
        pos++;
        const right = parsePower();
        left = { type: 'binary', op, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  function parsePower() {
    const base = parseUnary();

    if (pos < tokens.length && tokens[pos].type === 'operator' && tokens[pos].value === '^') {
      pos++;
      const exp = parsePower(); // Right-associative
      return { type: 'binary', op: '^', left: base, right: exp };
    }

    return base;
  }

  function parseUnary() {
    if (pos < tokens.length && tokens[pos].type === 'operator') {
      const op = tokens[pos].value;
      if (op === '-' || op === '+') {
        pos++;
        const expr = parseUnary();
        return { type: 'unary', op, expr };
      }
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = tokens[pos];

    if (!token) {
      throw new Error('表达式不完整');
    }

    // Number
    if (token.type === 'number') {
      pos++;
      return { type: 'literal', value: token.value };
    }

    // Identifier (constant or function call)
    if (token.type === 'identifier') {
      const name = token.value;
      pos++;

      // Check for function call
      if (pos < tokens.length && tokens[pos].type === 'operator' && tokens[pos].value === '(') {
        pos++; // consume '('
        const args = [];

        if (pos < tokens.length && !(tokens[pos].type === 'operator' && tokens[pos].value === ')')) {
          args.push(parseExpression());
          while (pos < tokens.length && tokens[pos].type === 'operator' && tokens[pos].value === ',') {
            pos++; // consume ','
            args.push(parseExpression());
          }
        }

        if (pos >= tokens.length || tokens[pos].value !== ')') {
          throw new Error('函数调用缺少右括号');
        }
        pos++; // consume ')'

        return { type: 'call', name, args };
      }

      // Constant
      return { type: 'identifier', name };
    }

    // Parenthesized expression
    if (token.type === 'operator' && token.value === '(') {
      pos++;
      const expr = parseExpression();
      if (pos >= tokens.length || tokens[pos].value !== ')') {
        throw new Error('缺少右括号');
      }
      pos++;
      return expr;
    }

    throw new Error(`意外的标记: ${token.value}`);
  }

  const ast = parseExpression();

  if (pos < tokens.length) {
    throw new Error('表达式不完整');
  }

  return ast;
}

function evaluate(node) {
  switch (node.type) {
    case 'literal':
      return node.value;

    case 'identifier':
      return getConstant(node.name);

    case 'unary':
      const val = evaluate(node.expr);
      return node.op === '-' ? -val : val;

    case 'binary': {
      const left = evaluate(node.left);
      const right = evaluate(node.right);

      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/':
          if (right === 0) throw new Error('除数不能为零');
          return left / right;
        case '%': return left % right;
        case '^': return Math.pow(left, right);
        default: throw new Error(`不支持的运算符: ${node.op}`);
      }
    }

    case 'call':
      return callFunction(node.name, node.args.map(evaluate));

    default:
      throw new Error(`未知的节点类型: ${node.type}`);
  }
}

function getConstant(name) {
  const constants = {
    'PI': Math.PI,
    'pi': Math.PI,
    'E': Math.E,
    'e': Math.E
  };

  if (name in constants) {
    return constants[name];
  }

  throw new Error(`未知常量: ${name}`);
}

function callFunction(name, args) {
  const functions = {
    'sin': (x) => Math.sin(x),
    'cos': (x) => Math.cos(x),
    'tan': (x) => Math.tan(x),
    'asin': (x) => Math.asin(x),
    'acos': (x) => Math.acos(x),
    'atan': (x) => Math.atan(x),
    'log': (x) => Math.log10(x),
    'ln': (x) => Math.log(x),
    'log2': (x) => Math.log2(x),
    'sqrt': (x) => Math.sqrt(x),
    'abs': (x) => Math.abs(x),
    'ceil': (x) => Math.ceil(x),
    'floor': (x) => Math.floor(x),
    'round': (x) => Math.round(x),
    'pow': (base, exp) => Math.pow(base, exp),
    'max': (...vals) => Math.max(...vals),
    'min': (...vals) => Math.min(...vals)
  };

  if (name in functions) {
    return functions[name](...args);
  }

  throw new Error(`未知函数: ${name}`);
}
