// stability.js (globals)
(function(){
  window.DEFAULT_ATTR_PRIORITY = [
    'data-testid','data-test','data-qa','data-cy','aria-label','aria-labelledby','role',
    'name','placeholder','alt','title','type','id','class'
  ];
  window.normalizeAttrPriority = function(preferredDataAttrs){
    if (Array.isArray(preferredDataAttrs)){
      const set = new Set(preferredDataAttrs.map(a=>a.trim()));
      window.DEFAULT_ATTR_PRIORITY.forEach(a => set.add(a));
      return Array.from(set);
    }
    return window.DEFAULT_ATTR_PRIORITY;
  };
  window.isLikelyDynamic = function(s){
    if (!s) return false;
    return /[0-9]{5,}/.test(s) ||
           /\b(uuid|guid|token|session)\b/i.test(s) ||
           /\b[a-f0-9]{6,}\b/.test(s) ||
           /^(ext-gen|j_id|ui-id|yui_|ember|react-|__|mx_)/.test(s);
  };
  window.pickStableAttr = function(el, attrPriority){
    const pr = Array.isArray(attrPriority) && attrPriority.length ? attrPriority : window.DEFAULT_ATTR_PRIORITY;
    for (const a of pr){
      const v = el.getAttribute?.(a);
      if (v && v.trim()){
        if (a === 'id' && window.isLikelyDynamic(v)) continue;
        return { attr:a, value:v.trim() };
      }
    }
    const id = el.getAttribute?.('id');
    if (id && !window.isLikelyDynamic(id)) return { attr:'id', value:id };
    const cls = (el.getAttribute?.('class') || '').split(/\s+/).filter(Boolean);
    const token = cls.find(t => !window.isLikelyDynamic(t) && t.length <= 40);
    if (token) return { attr:'class', value:token };
    return null;
  };
  window.getAccessibleName = function(el){
    const aria = el.getAttribute?.('aria-label'); if (aria) return aria.trim();
    const labelledby = el.getAttribute?.('aria-labelledby');
    if (labelledby){
      const lbl = el.ownerDocument.getElementById(labelledby);
      if (lbl) return lbl.textContent.trim();
    }
    if (el.tagName === 'INPUT'){
      const id = el.getAttribute('id');
      if (id){
        const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) return lab.textContent.trim();
      }
    }
    const title = el.getAttribute?.('title'); if (title) return title.trim();
    const alt = el.getAttribute?.('alt'); if (alt) return alt.trim();
    const txt = (el.textContent || '').trim(); return txt || null;
  };
  window.scoreLocator = function(type, value){
    let s = 50;
    if (!value) return 10;
    const lower = (type||'').toLowerCase();
    if (lower === 'id') s = 80;
    if (lower === 'css') s = 60;
    if (lower === 'xpath') s = 60;
    if (lower === 'xpath-abs') s = 10;
    if (/data-(test|qa|cy|testid)/i.test(value) || /aria-/.test(value)) s += 25;
    if (/\[name=/.test(value) || /@name=/.test(value)) s += 10;
    if (/\[placeholder=/.test(value)) s += 5;
    if (/contains\(/i.test(value)) s -= 10;
    if (/normalize-space\(/i.test(value)) s -= 5;
    if (/:nth-of-type|following-sibling::/.test(value)) s -= 15;
    if (/\bclass='[^']+\s[^']+'/.test(value)) s -= 5;
    if (window.isLikelyDynamic(value)) s -= 25;
    return Math.max(0, Math.min(100, s));
  };
})();