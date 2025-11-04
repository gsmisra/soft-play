// unique_cache.js (globals)
(function(){
  const _uniqCache = new Map();
  window.cachedIsUniqueCss = function(selector, scope=document){
    const key = `css:${selector}`;
    if (_uniqCache.has(key)) return _uniqCache.get(key);
    let ok=false;
    try{ ok = scope.querySelectorAll(selector).length === 1; }catch(_){ ok=false; }
    _uniqCache.set(key, ok); return ok;
  };
  window.cachedIsUniqueXpath = function(xpath, scope=document){
    const key = `xp:${xpath}`;
    if (_uniqCache.has(key)) return _uniqCache.get(key);
    let ok=false;
    try{
      const res = document.evaluate(xpath, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      ok = res.snapshotLength === 1;
    }catch(_){ ok=false; }
    _uniqCache.set(key, ok); return ok;
  };
  window.clearUniqCache = function(){ _uniqCache.clear(); };
})();