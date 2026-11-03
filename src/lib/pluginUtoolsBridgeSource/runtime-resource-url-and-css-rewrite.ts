const part = `    if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.indexOf('//') === 0;
  }
  function _isRuntimeLocalResourceUrl(value) {
    var trimmed = String(value || '').trim();
    if (!trimmed || trimmed.charAt(0) === '#') return false;
    if (trimmed.indexOf('asset(') === 0) return false;
    if (_hasRuntimeUrlProtocol(trimmed)) return false;
    return true;
  }
  function _runtimeResourceBaseDir() {
    try {
      if (!document || typeof document.querySelector !== 'function') return '';
      var base = document.querySelector('base[href]');
      if (!base || typeof base.getAttribute !== 'function') return '';
      var href = base.getAttribute('href') || '';
      if (_isRuntimeLocalResourceUrl(href)) return href;
      var marker = base.getAttribute('data-atools-plugin-base-href') || '';
      return _isRuntimeLocalResourceUrl(marker) ? marker : '';
    } catch (err) {
      return '';
    }
  }
  function _resolvePluginResource(url, baseDir) {
    var raw = String(url || '').trim();
    if (!_isRuntimeLocalResourceUrl(raw)) return Promise.resolve(url);
    var resolvedBaseDir = baseDir || _runtimeResourceBaseDir();
    return new Promise(function(resolve, reject) {
      var id = ++_resourceReqId;
      _resourcePending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        __atools_resource_resolve__: true,
        reqId: id,
        url: raw,
        baseDir: resolvedBaseDir || ''
      }, '*');
    });
  }
  window.__atools_resolve_plugin_resource__ = _resolvePluginResource;
  function _runtimeResourceMarker(attr) {
    return 'data-atools-resource-resolved-' + String(attr || '').toLowerCase();
  }
  function _isRuntimeElement(node) {
    return node
      && node.nodeType === 1
      && typeof node.getAttribute === 'function'
      && typeof node.setAttribute === 'function';
  }
  function _runtimeResourceAttrsForElement(element) {
    var tagName = String(element.tagName || '').toLowerCase();
    var attrs = [];
    if (tagName === 'link') attrs.push('href');
    if (tagName === 'object') attrs.push('data');
    if (typeof element.getAttribute === 'function' && element.getAttribute('style') != null) attrs.push('style');
    if (tagName === 'img' || tagName === 'source') attrs.push('srcset');
    if (tagName === 'img' || tagName === 'source' || tagName === 'video' || tagName === 'audio' || tagName === 'track' || tagName === 'iframe' || tagName === 'embed' || tagName === 'script') attrs.push('src');
    if (tagName === 'img' || tagName === 'video') attrs.push('poster');
    return attrs;
  }
  function _splitRuntimeSrcset(value) {
    var candidates = [];
    var current = '';
    for (var index = 0; index < value.length; index += 1) {
      var char = value.charAt(index);
      if (char === ',' && _isRuntimeSrcsetSeparator(current)) {
        candidates.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    if (current || candidates.length === 0) candidates.push(current);
    return candidates;
  }
  function _isRuntimeSrcsetSeparator(current) {
    var trimmed = current.trim();
    if (!trimmed) return true;
    return trimmed.toLowerCase().indexOf('data:') !== 0 || _firstRuntimeWhitespaceIndex(trimmed) >= 0;
  }
  function _firstRuntimeWhitespaceIndex(value) {
    for (var index = 0; index < value.length; index += 1) {
      if (_isRuntimeWhitespaceCode(value.charCodeAt(index))) return index;
    }
    return -1;
  }
  function _isRuntimeWhitespaceCode(code) {
    return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
  }
  function _skipRuntimeWhitespace(value, index) {
    var cursor = index;
    while (cursor < value.length && _isRuntimeWhitespaceCode(value.charCodeAt(cursor))) {
      cursor += 1;
    }
    return cursor;
  }
  function _findRuntimeCssQuoteEnd(value, index, quote) {
    for (var cursor = index; cursor < value.length; cursor += 1) {
      if (value.charAt(cursor) === quote) return cursor;
    }
    return -1;
  }
  function _findRuntimeCssClosingParen(value, index) {
    var quote = '';
    for (var cursor = index; cursor < value.length; cursor += 1) {
      var char = value.charAt(cursor);
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ')') return cursor;
    }
    return -1;
  }
  function _runtimeCssUrlToken(value, index) {
    if (value.slice(index, index + 4).toLowerCase() !== 'url(') return null;
    var contentStart = _skipRuntimeWhitespace(value, index + 4);
    if (contentStart >= value.length) return null;
    var first = value.charAt(contentStart);
    var contentEnd;
    var closeParen;
    if (first === '"' || first === "'") {
      contentEnd = _findRuntimeCssQuoteEnd(value, contentStart + 1, first);
      if (contentEnd < 0) return null;
      closeParen = _skipRuntimeWhitespace(value, contentEnd + 1);
      if (value.charAt(closeParen) !== ')') return null;
      return {
        start: index,
        end: closeParen + 1,
        url: value.slice(contentStart + 1, contentEnd),
        kind: 'url'
      };
    }
    closeParen = _findRuntimeCssClosingParen(value, contentStart);
    if (closeParen < 0) return null;
    return {
      start: index,
      end: closeParen + 1,
      url: value.slice(contentStart, closeParen).trim(),
      kind: 'url'
    };
  }
  function _collectRuntimeCssUrlTokens(value) {
    var tokens = [];
    var index = 0;
    while (index < value.length) {
      var token = _runtimeCssUrlToken(value, index);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
      index += 1;
    }
    return tokens;
  }
  function _runtimeCssImportToken(value, index) {
    if (value.slice(index, index + 7).toLowerCase() !== '@import') return null;
    var cursor = _skipRuntimeWhitespace(value, index + 7);
    var quote = value.charAt(cursor);
    if (quote !== '"' && quote !== "'") return null;
    var endQuote = _findRuntimeCssQuoteEnd(value, cursor + 1, quote);
    if (endQuote < 0) return null;
    return {
      start: cursor,
      end: endQuote + 1,
      url: value.slice(cursor + 1, endQuote),
      kind: 'import'
    };
  }
  function _collectRuntimeCssImportTokens(value) {
    var tokens = [];
    var index = 0;
    while (index < value.length) {
      var token = _runtimeCssImportToken(value, index);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
      index += 1;
    }
    return tokens;
  }
  function _runtimeCssTokens(value) {
    var tokens = _collectRuntimeCssImportTokens(value).concat(_collectRuntimeCssUrlTokens(value));
    tokens.sort(function(a, b) {
      return a.start - b.start;
    });
    var filtered = [];
    var lastEnd = -1;
    tokens.forEach(function(token) {
      if (token.start < lastEnd) return;
      filtered.push(token);
      lastEnd = token.end;
    });
    return filtered;
  }
  function _escapeRuntimeCssUrl(value) {
    return String(value || '').replace(/"/g, '%22');
  }
  function _runtimeCssReplacement(token, converted) {
    var safe = _escapeRuntimeCssUrl(converted);
    if (token.kind === 'import') return '"' + safe + '"';
    return 'url("' + safe + '")';
  }
  function _rewriteRuntimeCss(value, mode) {
    var css = String(value || '');
    try {
      if (_atoolsNativeAppRegionCss && typeof _atoolsNativeAppRegionCss === 'function') {
        css = _atoolsNativeAppRegionCss(css, mode === 'declarations' ? 'declarations' : 'stylesheet');
      }
    } catch (err) {
      console.warn('[atools native app-region css]', err);
    }
    var tokens = _runtimeCssTokens(css);
    if (!tokens.length) return Promise.resolve(css);
    return Promise.all(tokens.map(function(token) {
      return _resolvePluginResource(token.url);
    })).then(function(convertedValues) {
      var output = '';
      var lastIndex = 0;
      tokens.forEach(function(token, index) {
        var converted = convertedValues[index];
        output += css.slice(lastIndex, token.start);
        output += converted === token.url
          ? css.slice(token.start, token.end)
          : _runtimeCssReplacement(token, converted);
        lastIndex = token.end;
      });
      return output + css.slice(lastIndex);
    });
  }
  function _rewriteRuntimeResourceAttrValue(attr, raw) {
    return attr === 'srcset'
      ? _rewriteRuntimeSrcset(raw)
      : attr === 'style'
        ? _rewriteRuntimeCss(raw, 'declarations')
        : _resolvePluginResource(raw);
  }
  function _rewriteRuntimeSrcsetCandidate(candidate) {
    var trimmed = String(candidate || '').trim();
    if (!trimmed) return Promise.resolve(trimmed);
    var descriptorIndex = _firstRuntimeWhitespaceIndex(trimmed);
    var url = descriptorIndex >= 0 ? trimmed.slice(0, descriptorIndex) : trimmed;
    var descriptor = descriptorIndex >= 0 ? trimmed.slice(descriptorIndex) : '';
    return _resolvePluginResource(url).then(function(converted) {
      return String(converted) + descriptor;
    });
  }
  function _rewriteRuntimeSrcset(value) {
    return Promise.all(_splitRuntimeSrcset(String(value || '')).map(_rewriteRuntimeSrcsetCandidate))
      .then(function(candidates) {
        return candidates.join(', ');
      });
  }
  function _resolveRuntimeResourceAttr(element, attr) {
    var raw = element.getAttribute(attr);
    if (!raw) return;
    var marker = _runtimeResourceMarker(attr);
    if (element.getAttribute(marker) === raw) return;
    element.setAttribute(marker, raw);
    var task = _rewriteRuntimeResourceAttrValue(attr, raw);
    task.then(function(converted) {
      if (!converted || converted === raw) return;
      if (element.getAttribute(attr) === raw) {
        element.setAttribute(attr, converted);
        element.setAttribute(marker, converted);
      }
    }).catch(function(err) {
      console.warn('[atools runtime resource]', err);
    });
  }
  function _resolveRuntimeStyleElement(element) {
    if (!_isRuntimeElement(element)) return;
    if (String(element.tagName || '').toLowerCase() !== 'style') return;
    var raw = typeof element.textContent === 'string' ? element.textContent : '';
    if (!raw) return;
    var marker = 'data-atools-resource-resolved-css';
    if (element.getAttribute(marker) === raw) return;
    element.setAttribute(marker, raw);
    _rewriteRuntimeCss(raw, 'stylesheet').then(function(converted) {
      if (!converted || converted === raw) return;
      if (element.textContent === raw) {
        element.textContent = converted;
        element.setAttribute(marker, converted);
      }
    }).catch(function(err) {
      console.warn('[atools runtime css resource]', err);
    });
  }
  function _replaceRuntimeInsertedCssRule(sheet, index, convertedRule, originalInsertRule, originalDeleteRule) {
`;
export default part;
