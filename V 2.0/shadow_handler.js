// shadow_handler.js (globals)
(function(){
  window.deepElements = function*(root=document){
    const start = root instanceof Document ? root.documentElement : root;
    if (!start) return;
    const q = [start];
    while (q.length){
      const node = q.shift();
      if (!node) continue;
      if (node.nodeType === 11){ // ShadowRoot
        if (node.firstElementChild) q.push(node.firstElementChild);
        continue;
      }
      if (node.nodeType === 1){
        yield node;
        if (node.shadowRoot) q.push(node.shadowRoot);
        if (node.firstElementChild) q.push(node.firstElementChild);
        if (node.nextElementSibling) q.push(node.nextElementSibling);
      }
    }
  };
  function cssSegment(el){
    if (!el || !el.localName) return '*';
    if (el.id) return `${el.localName}#${CSS.escape(el.id)}`;
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (cls.length) return `${el.localName}.${cls.map(CSS.escape).join('.')}`;
    return el.localName;
  }
  window.serializeHops = function(el){
    const hops = []; let node = el;
    while (node && node.parentNode){
      const root = node.getRootNode && node.getRootNode();
      if (root && root instanceof ShadowRoot){
        const host = root.host;
        hops.unshift({ type:'shadow', host: cssSegment(host) });
        node = host; continue;
      }
      node = node.parentNode;
    }
    hops.push({ type:'leaf', selector: cssSegment(el) });
    return hops;
  };
  window.queryByHops = function(hops, doc=document){
    let ctx = doc;
    for (const hop of hops){
      if (hop.type === 'shadow'){
        const host = ctx.querySelector(hop.host);
        if (!host || !host.shadowRoot) return null;
        ctx = host.shadowRoot;
      } else if (hop.type === 'leaf'){
        return ctx.querySelector(hop.selector);
      }
    }
    return null;
  };
})();