const part = `    var targetIndex = Number(index);
    if (!Number.isFinite(targetIndex)) targetIndex = 0;
    try {
      if (typeof originalDeleteRule === 'function') {
        originalDeleteRule.call(sheet, targetIndex);
        originalInsertRule.call(sheet, convertedRule, targetIndex);
        return;
      }
    } catch (err) {}
    try {
      originalInsertRule.call(sheet, convertedRule, targetIndex);
    } catch (err) {}
  }
  function _installRuntimeCssStyleSheetPatch() {
    var CssStyleSheetCtor = null;
    try {
      CssStyleSheetCtor = window.CSSStyleSheet || (typeof CSSStyleSheet === 'function' ? CSSStyleSheet : null);
    } catch (err) {}
    if (!CssStyleSheetCtor || !CssStyleSheetCtor.prototype) return;
    var proto = CssStyleSheetCtor.prototype;
    if (proto.__atoolsResourceInsertRulePatched || typeof proto.insertRule !== 'function') return;
    var originalInsertRule = proto.insertRule;
    var originalDeleteRule = proto.deleteRule;
    proto.insertRule = function(rule, index) {
      var sheet = this;
      var rawRule = String(rule || '');
      var insertedIndex = originalInsertRule.apply(sheet, arguments);
      var targetIndex = typeof insertedIndex === 'number'
        ? insertedIndex
        : typeof index === 'number'
          ? index
          : 0;
      _rewriteRuntimeCss(rawRule).then(function(convertedRule) {
        if (!convertedRule || convertedRule === rawRule) return;
        _replaceRuntimeInsertedCssRule(sheet, targetIndex, convertedRule, originalInsertRule, originalDeleteRule);
      }).catch(function(err) {
        console.warn('[atools runtime css insertRule]', err);
      });
      return insertedIndex;
    };
    try {
      Object.defineProperty(proto, '__atoolsResourceInsertRulePatched', { value: true });
    } catch (err) {
      proto.__atoolsResourceInsertRulePatched = true;
    }
  }
  function _preinsertResourceAttrsForElement(element) {
    if (!_isRuntimeElement(element)) return [];
    var tagName = String(element.tagName || '').toLowerCase();
    if (tagName === 'script' && _isRuntimeLocalResourceUrl(element.getAttribute('src') || '')) return ['src'];
    if (tagName === 'link' && _isRuntimeLocalResourceUrl(element.getAttribute('href') || '')) return ['href'];
    return [];
  }
  function _preflightRuntimeElementResources(element) {
    var attrs = _preinsertResourceAttrsForElement(element);
    if (!attrs.length) return Promise.resolve(false);
    return Promise.all(attrs.map(function(attr) {
      var raw = element.getAttribute(attr);
      if (!raw) return Promise.resolve(false);
      return _rewriteRuntimeResourceAttrValue(attr, raw).then(function(converted) {
        if (!converted || converted === raw) return false;
        if (element.getAttribute(attr) === raw) {
          element.setAttribute(attr, converted);
          element.setAttribute(_runtimeResourceMarker(attr), converted);
          return true;
        }
        return false;
      });
    })).then(function(results) {
      return results.some(Boolean);
    });
  }
  function _runtimeInsertionItemsHavePreinsertResources(items) {
    return items.some(function(item) {
      return _preinsertResourceAttrsForElement(item).length > 0;
    });
  }
  function _preflightRuntimeInsertionItems(items) {
    var elements = items.filter(function(item) {
      return _preinsertResourceAttrsForElement(item).length > 0;
    });
    if (!elements.length) return Promise.resolve(false);
    return Promise.all(elements.map(_preflightRuntimeElementResources)).then(function(results) {
      return results.some(Boolean);
    });
  }
  function _installRuntimeVariadicPreinsertResourcePatch(proto, methodName) {
    if (!proto) return;
    var originalMethod = proto[methodName];
    if (typeof originalMethod !== 'function') return;
    var marker = '__atoolsResourcePreinsertPatched_' + methodName;
    if (proto[marker]) return;
    proto[methodName] = function() {
      var target = this;
      var args = Array.prototype.slice.call(arguments);
      if (!_runtimeInsertionItemsHavePreinsertResources(args)) {
        return originalMethod.apply(target, arguments);
      }
      _preflightRuntimeInsertionItems(args).then(function() {
        originalMethod.apply(target, args);
      }).catch(function(err) {
        console.warn('[atools runtime preinsert ' + methodName + ']', err);
        originalMethod.apply(target, args);
      });
      return undefined;
    };
    try {
      Object.defineProperty(proto, marker, { value: true });
    } catch (err) {
      proto[marker] = true;
    }
  }
  function _installRuntimePreinsertResourcePatch() {
    var NodeCtor = null;
    try {
      NodeCtor = window.Node || (typeof Node === 'function' ? Node : null);
    } catch (err) {}
    if (!NodeCtor || !NodeCtor.prototype) return;
    var proto = NodeCtor.prototype;
    if (proto.__atoolsResourcePreinsertPatched) return;
    var originalAppendChild = proto.appendChild;
    var originalInsertBefore = proto.insertBefore;
    if (typeof originalAppendChild === 'function') {
      proto.appendChild = function(child) {
        var parent = this;
        if (!_preinsertResourceAttrsForElement(child).length) {
          return originalAppendChild.call(parent, child);
        }
        _preflightRuntimeElementResources(child).then(function() {
          originalAppendChild.call(parent, child);
        }).catch(function(err) {
          console.warn('[atools runtime preinsert appendChild]', err);
          originalAppendChild.call(parent, child);
        });
        return child;
      };
    }
    if (typeof originalInsertBefore === 'function') {
      proto.insertBefore = function(child, before) {
        var parent = this;
        if (!_preinsertResourceAttrsForElement(child).length) {
          return originalInsertBefore.call(parent, child, before);
        }
        _preflightRuntimeElementResources(child).then(function() {
          originalInsertBefore.call(parent, child, before);
        }).catch(function(err) {
          console.warn('[atools runtime preinsert insertBefore]', err);
          originalInsertBefore.call(parent, child, before);
        });
        return child;
      };
    }
    try {
      Object.defineProperty(proto, '__atoolsResourcePreinsertPatched', { value: true });
    } catch (err) {
      proto.__atoolsResourcePreinsertPatched = true;
    }
    var ElementCtor = null;
    var DocumentCtor = null;
    var FragmentCtor = null;
    try {
      ElementCtor = window.Element || (typeof Element === 'function' ? Element : null);
    } catch (err) {}
    try {
      DocumentCtor = window.Document || (typeof Document === 'function' ? Document : null);
    } catch (err) {}
    try {
      FragmentCtor = window.DocumentFragment || (typeof DocumentFragment === 'function' ? DocumentFragment : null);
    } catch (err) {}
    [ElementCtor, DocumentCtor, FragmentCtor].forEach(function(Ctor) {
      if (!Ctor || !Ctor.prototype) return;
      ['append', 'prepend', 'before', 'after', 'replaceWith'].forEach(function(methodName) {
        _installRuntimeVariadicPreinsertResourcePatch(Ctor.prototype, methodName);
      });
    });
  }
  function _rewriteRuntimeElementResources(element) {
    if (!_isRuntimeElement(element)) return;
    _runtimeResourceAttrsForElement(element).forEach(function(attr) {
      _resolveRuntimeResourceAttr(element, attr);
    });
    _resolveRuntimeStyleElement(element);
  }
  function _scanRuntimeResources(root) {
    var selector = 'img[src],img[srcset],source[src],source[srcset],video[src],video[poster],audio[src],track[src],iframe[src],embed[src],object[data],script[src],link[href],style,[style]';
    if (_isRuntimeElement(root)) _rewriteRuntimeElementResources(root);
    if (!root || typeof root.querySelectorAll !== 'function') return;
    Array.prototype.slice.call(root.querySelectorAll(selector)).forEach(_rewriteRuntimeElementResources);
  }
  function _installRuntimeResourceObserver() {
    _scanRuntimeResources(document);
    if (typeof MutationObserver !== 'function') return;
    var observerRoot = document.documentElement || document.body || document;
    if (!observerRoot) return;
    var observer = new MutationObserver(function(mutations) {
      Array.prototype.slice.call(mutations || []).forEach(function(mutation) {
        if (mutation.type === 'attributes') {
          _rewriteRuntimeElementResources(mutation.target);
          return;
        }
        if (mutation.type === 'characterData') {
          _resolveRuntimeStyleElement(mutation.target && mutation.target.parentNode);
          return;
        }
        Array.prototype.slice.call(mutation.addedNodes || []).forEach(_scanRuntimeResources);
      });
    });
    var observerOptions = {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['src', 'poster', 'srcset', 'href', 'data', 'style']
    };
    try {
      observer.observe(observerRoot, observerOptions);
    } catch (err) {
      var fallbackRoot = document.body && document.body !== observerRoot ? document.body : null;
      if (!fallbackRoot) return;
      try {
        observer.observe(fallbackRoot, observerOptions);
      } catch (fallbackErr) {}
    }
  }
  function _copiedFileName(path) {
`;
export default part;
