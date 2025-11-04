// anchors.js (globals, depends on stability.js + unique_cache.js)
// This file has been FIXED to remove the faulty uniqueness check.
(function(){
    function buildCssFromAttr(tag, attr, value){
        if (attr === 'id') return `#${CSS.escape(value)}`;
        if (attr === 'class') return `${tag}.${CSS.escape(value)}`;
        return `${tag}[${attr}="${CSS.escape(value)}"]`;
    }

    function xpathLiteral(s){
        if (s == null) return "''";
        s = String(s);
        if (!s.includes("'")) return `'${s}'`;
        if (!s.includes('"')) return `"${s}"`;
        return "concat('" + s.replace(/'/g, "',\"'\",'") + "')";
    }

    function buildXpathFromAttr(tag, attr, value){
        if (attr === 'id') return `//${tag}[@id=${xpathLiteral(value)}]`;
        if (attr === 'class'){
            const lit = xpathLiteral(' ' + value + ' ');
            return `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${lit})]`;
        }
        return `//${tag}[@${attr}=${xpathLiteral(value)}]`;
    }

    // --- THIS IS THE FIX ---
    // The loop is limited to `i < 2` (parent and grandparent)
    // The faulty `if (window.cachedIsUniqueCss(ancestor.css))` has been REMOVED.
    function findStableAncestor(el, attrPriority){
        let node = el.parentElement;
        // Check max 2 levels up (parent, grandparent)
        for (let i = 0; i < 2 && node; i++) { 
            if (node === document.body || node === document.documentElement) break;
            const tag = node.localName;
            const stable = window.pickStableAttr ? window.pickStableAttr(node, attrPriority) : null;
            
            // We just find the FIRST stable attribute, we don't check for uniqueness here.
            if (stable){
                return { 
                    node, 
                    css: buildCssFromAttr(tag, stable.attr, stable.value), 
                    xpath: buildXpathFromAttr(tag, stable.attr, stable.value) 
                };
            }
            node = node.parentElement;
        }
        return null; // No stable ancestor found within 2 levels
    }
    // --- END OF FIX ---


    function buildChainedCss(ancestorNode, ancestorCss, el){
        const chain = []; 
        let n = el;
        // Loop until we hit the ancestor node
        while (n && n.nodeType === 1 && n !== ancestorNode){
            if (n === document.body) break; // Safety break
            const tag = n.localName;
            const id = n.id && !window.isLikelyDynamic?.(n.id) ? `#${CSS.escape(n.id)}` : null;
            if (id){ 
                chain.unshift(id); 
                break; // An ID is a strong anchor
            }
            const cls = (n.getAttribute('class') || '').split(/\s+/).filter(c => c && !/\d{5,}/.test(c));
            if (cls.length){ 
                chain.unshift(`${tag}.${CSS.escape(cls[0])}`); 
            }
            else {
                const sibs = n.parentElement ? Array.from(n.parentElement.children).filter(x => x.localName===tag) : [];
                if (sibs.length>1){
                    const idx = sibs.indexOf(n)+1; 
                    chain.unshift(`${tag}:nth-of-type(${idx})`);
                } else {
                    chain.unshift(tag);
                }
            }
            n = n.parentElement;
        }
        return `${ancestorCss} ${chain.join(' > ')}`;
    }

    function buildChainedXpath(ancestorNode, ancestorXpath, el){
        let segs = []; 
        let n = el;
        // Loop until we hit the ancestor node
        while (n && n.nodeType === 1 && n !== ancestorNode){
            if (n === document.body) break; // Safety break
            const tag = n.localName;
            let seg = tag;
            const id = n.id && !window.isLikelyDynamic?.(n.id) ? n.id : null;
            if (id) {
                seg = `*[@id=${xpathLiteral(id)}]`;
                segs.unshift(seg);
                break; // An ID is a strong anchor
            }

            const cls = (n.getAttribute('class') || '').split(/\s+/).filter(c => c && !/\d{5,}/.test(c));
            if (cls.length) {
                seg = `${tag}[contains(@class, ${xpathLiteral(cls[0])})]`;
            } else {
                const sibs = n.parentElement ? Array.from(n.parentElement.children).filter(x => x.localName===tag) : [];
                if (sibs.length>1){ 
                    const idx = sibs.indexOf(n)+1; 
                    seg = `${tag}[${idx}]`; 
                }
            }
            segs.unshift(seg); 
            n = n.parentElement;
        }
        return `${ancestorXpath}//${segs.join('/')}`;
    }

    function uniqueOrRefine(doc, css, xpath, el){
        if (css && window.cachedIsUniqueCss?.(css, doc)) return { type:'css', value:css };
        if (xpath && window.cachedIsUniqueXpath?.(xpath, doc)) return { type:'xpath', value:xpath };
        
        // Refine XPath with text if possible
        const text = el.textContent ? el.textContent.trim() : null;
        if (xpath && text && text.length < 50 && !text.includes('\n')) {
            const refined = `${xpath}[normalize-space(.)=${xpathLiteral(text)}]`;
            if (window.cachedIsUniqueXpath?.(refined, doc)) {
                return { type:'xpath', value:refined };
            }
        }
        // Return the best guess
        return css ? { type:'css', value:css } : { type:'xpath', value:xpath };
    }

    // expose globals
    window.findStableAncestor = findStableAncestor;
    window.buildChainedCss = buildChainedCss;
    window.buildChainedXpath = buildChainedXpath;
    window.uniqueOrRefine = uniqueOrRefine;
})();
