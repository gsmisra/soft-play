// PATCHED content_script.js
// This version prioritizes text locators and adds uniqueness checks
// to the 'href' strategy to fix the "Reset Password" bug.
// Requires helpers: stability.js, unique_cache.js, shadow_handler.js, anchors.js, verify_api.js

let isSpying = false;
let isAutoSpying = false;
let currentHighlight = null; // This will be the #spy-highlighter div
let currentToast = null;     // This will be the #spy-toast-notification div
let currentHoverHighlight = null; // This will be the #spy-hover-highlighter div
let preferredDataAttrs = ['data-testid', 'data-cy', 'data-qa', 'data-test'];
let autoSpyObserver = null;
let autoSpyDebounceTimer = null;

chrome.storage.sync.get('preferredDataAttrs', (result) => {
    if (result.preferredDataAttrs) {
        preferredDataAttrs = result.preferredDataAttrs.split(',').map(s => s.trim());
    }
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.preferredDataAttrs) {
        preferredDataAttrs = changes.preferredDataAttrs.newValue.split(',').map(s => s.trim());
    }
    if (namespace === 'local' && changes.isSpying) {
        if (isSpying !== changes.isSpying.newValue) toggleManualSpy(changes.isSpying.newValue);
    }
    if (namespace === 'local' && changes.isAutoSpying) {
        if (isAutoSpying !== changes.isAutoSpying.newValue) toggleAutoSpy(changes.isAutoSpying.newValue);
    }
});
chrome.storage.local.get(['isSpying','isAutoSpying'], (res) => {
    isSpying = !!res.isSpying;
    isAutoSpying = !!res.isAutoSpying;
    if (isSpying) toggleManualSpy(true);
    if (isAutoSpying) toggleAutoSpy(true);
    queueMicrotask(() => { if (isAutoSpying) rearmAutoSpy(); });
});

function getOrCreateElement(id, existingEl) {
    if (existingEl && document.body.contains(existingEl)) {
        return existingEl;
    }
    let el = document.getElementById(id);
    if (el) {
        return el;
    }
    el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
}

function isVisible(el){
    try{
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r || r.width < 1 || r.height < 1) return false;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
        return true;
    } catch { return false; }
}

function xpathLiteral(s){
    if (s == null) return "''";
    s = String(s);
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return "concat('" + s.replace(/'/g, "',\"'\",'") + "')";
}

// ---------- Robust storage merge ----------
async function mergeIntoStorage(entries){
    try{
        const res = await chrome.storage.local.get({ recordedLocators: [] });
        const list = Array.isArray(res.recordedLocators) ? res.recordedLocators : [];
        const map = new Map();
        for (const x of list){
            if (!x || typeof x !== 'object') continue;
            const id = x.id || `${x.name || 'Unnamed'}::${x.tag || 'div'}`;
            map.set(id, { ...x, id });
        }
        const safe = Array.isArray(entries) ? entries : [];
        for (const e of safe){
            if (!e || typeof e !== 'object') continue;
            const id = e.id || `${e.name || 'Unnamed'}::${e.tag || 'div'}`;
            map.set(id, { ...e, id });
        }
        await chrome.storage.local.set({ recordedLocators: Array.from(map.values()) });
    } catch (err){
        console.error('mergeIntoStorage failed:', err);
    }
}

// ---------- Manual Spy ----------
function toggleManualSpy(enable){
    if (isSpying === enable) return;
    isSpying = enable;
    if (enable) enableManualSpy(); else disableManualSpy();
}
function enableManualSpy(){
    if (!document.body){ setTimeout(enableManualSpy, 100); return; }
    try{
        currentHighlight = getOrCreateElement('spy-highlighter', currentHighlight);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('click', handleElementClick, true);
        document.addEventListener('scroll', handleScroll);
    }catch(e){ console.error('Enable manual spy failed', e); }
}
function disableManualSpy(){
    try{
        if (currentHighlight?.parentElement) currentHighlight.parentElement.removeChild(currentHighlight);
        currentHighlight = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('click', handleElementClick, true);
        document.removeEventListener('scroll', handleScroll);
    }catch(e){}
}
function handleMouseMove(e){
    try{
        if (!isSpying || !currentHighlight) return;
        currentHighlight.style.display='none';
        const t = document.elementFromPoint(e.clientX, e.clientY);
        currentHighlight.style.display='block';
        if (!t || t === document.body || t === currentHighlight || t === currentHoverHighlight || t === currentToast){ 
            currentHighlight.style.width='0px'; currentHighlight.style.height='0px'; return; 
        }
        const r = t.getBoundingClientRect();
        currentHighlight.style.top = `${r.top + scrollY}px`;
        currentHighlight.style.left = `${r.left + scrollX}px`;
        currentHighlight.style.width = `${r.width}px`;
        currentHighlight.style.height = `${r.height}px`;
    }catch(e){}
}
async function handleElementClick(e){
    if (!isSpying) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    if (!el || el === currentHighlight || el === currentToast || el === currentHoverHighlight) return;
    try{
        if (window.clearUniqCache) window.clearUniqCache(); 
        
        const locators = generateAllLocators(el);
        const name = getElementName(el);
        const entry = {
            id: `${name}::${el.tagName.toLowerCase()}`,
            name, tag: el.tagName.toLowerCase(), locators
        };
        if (window.serializeHops) entry.hops = window.serializeHops(el);
        await mergeIntoStorage([entry]);
        showToast("Saved!"); 
    }catch(err){ console.error('capture failed', err); }
}
function handleScroll(){ if (currentHighlight){ currentHighlight.style.width='0px'; currentHighlight.style.height='0px'; }}

// ---------- Auto Spy ----------
async function toggleAutoSpy(enable){
    if (isAutoSpying === enable) return null;
    isAutoSpying = enable;
    if (enable){
        const count = await runAutoSpy();
        if (autoSpyObserver) autoSpyObserver.disconnect();
        autoSpyObserver = new MutationObserver(handleDomChanges);
        autoSpyObserver.observe(document.documentElement, { childList:true, subtree:true });
        return count;
    } else {
        if (autoSpyObserver){ autoSpyObserver.disconnect(); autoSpyObserver=null; }
        if (autoSpyDebounceTimer){ clearTimeout(autoSpyDebounceTimer); autoSpyDebounceTimer=null; }
        return null;
    }
}

function* deepIter(){
    if (window.deepElements){
        yield* window.deepElements(document);
    } else {
        yield* document.querySelectorAll('*');
    }
}

async function runAutoSpy(){
    if (window.clearUniqCache) window.clearUniqCache(); 
    const set = new Set();
    const CAND = 'a,button,input,select,textarea,[role="button"],[role="link"],[id],span,div,p,li,h1,h2,h3,h4,h5,h6';
    try{
        for (const el of deepIter()){
            if (!(el instanceof Element)) continue;
            if (el.matches && el.matches(CAND)) set.add(el);
        }
    }catch(e){ console.error('auto scan fail', e); }

    const found = [];
    for (const el of set){
        if (!isVisible(el)) continue;
        if (el.id && (el.id === 'spy-highlighter' || el.id === 'spy-hover-highlighter' || el.id === 'spy-toast-notification')) continue;
        const name = getElementName(el);
        const isInput = ['input','textarea','select'].includes(el.tagName.toLowerCase());
        if (name === 'Unnamed Element' && !isInput) continue;
        
        const locators = generateAllLocators(el); 
        
        if (locators.length){
            const entry = { id:`${name}::${el.tagName.toLowerCase()}`, name, tag: el.tagName.toLowerCase(), locators };
            if (window.serializeHops) entry.hops = window.serializeHops(el);
            found.push(entry);
        }
    }
    if (!found.length) return 0;
    await mergeIntoStorage(found);
    return found.length;
}

function handleDomChanges(mutations){
    if (!isAutoSpying) return;
    if (autoSpyDebounceTimer) clearTimeout(autoSpyDebounceTimer); 
    autoSpyDebounceTimer = setTimeout(async () => {
        if (window.clearUniqCache) window.clearUniqCache(); 
        const CAND = 'a,button,input,select,textarea,[role="button"],[role="link"],[id],span,div,p,li,h1,h2,h3,h4,h5,h6';
        const added = new Set();
        for (const m of mutations){
            if (m.type === 'childList' && m.addedNodes.length){
                m.addedNodes.forEach(n => {
                    if (n.nodeType === Node.ELEMENT_NODE){
                        const el = n;
                        if (el.matches && el.matches(CAND)) added.add(el);
                        try{
                            el.querySelectorAll(CAND).forEach(child => added.add(child));
                            if (el.shadowRoot) el.shadowRoot.querySelectorAll(CAND).forEach(child => added.add(child));
                        }catch{}
                    }
                });
            }
        }
        if (!added.size) return;

        const found = [];
        for (const el of added){
            if (!isVisible(el)) continue;
            const name = getElementName(el);
            const isInput = ['input','textarea','select'].includes(el.tagName.toLowerCase());
            if (name === 'Unnamed Element' && !isInput) continue;

            const locators = generateAllLocators(el); 

            if (locators.length){
                const entry = { id:`${name}::${el.tagName.toLowerCase()}`, name, tag: el.tagName.toLowerCase(), locators };
                if (window.serializeHops) entry.hops = window.serializeHops(el);
                found.push(entry);
            }
        }
        if (found.length){
            await mergeIntoStorage(found);
        }
        autoSpyDebounceTimer = null;
    }, 500);
}

// ---------- Locator Generation (FIXED) ----------
function generateAllLocators(el){
    const locs = [];
    const tag = el.tagName.toLowerCase();
    const cssEsc = CSS && CSS.escape ? CSS.escape : (s)=>s;

    // 1. Preferred data attrs
    for (const a of preferredDataAttrs){
        const v = el.getAttribute(a);
        if (v){
            pushLoc(locs, 'css', `[${a}="${cssEsc(v)}"]`);
            pushLoc(locs, 'xpath', `//*[@${a}=${xpathLiteral(v)}]`);
        }
    }

    // 2. Stable attribute helper (id, stable class, etc.)
    if (window.pickStableAttr){
        const stable = window.pickStableAttr(el, preferredDataAttrs);
        if (stable){
            if (stable.attr === 'class'){
                const css = `${tag}.${cssEsc(stable.value)}`;
                const xp = `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(' ' + stable.value + ' ')} )]`;
                if (isUniqueCss(css)) pushLoc(locs, 'css', css);
                if (isUniqueXp(xp)) pushLoc(locs, 'xpath', xp);
            } else if (stable.attr === 'id'){
                pushLoc(locs, 'id', stable.value);
                const css = `#${cssEsc(stable.value)}`;
                const xp = `//*[@id=${xpathLiteral(stable.value)}]`;
                if (isUniqueCss(css)) pushLoc(locs, 'css', css);
                if (isUniqueXp(xp)) pushLoc(locs, 'xpath', xp);
            } else {
                const css = `${tag}[${stable.attr}="${cssEsc(stable.value)}"]`;
                const xp = `//${tag}[@${stable.attr}=${xpathLiteral(stable.value)}]`;
                if (isUniqueCss(css)) pushLoc(locs, 'css', css);
                if (isUniqueXp(xp)) pushLoc(locs, 'xpath', xp);
            }
        }
    }

    // 3. name attribute
    const nameAttr = el.getAttribute('name');
    if (nameAttr){
        const css = `[name="${cssEsc(nameAttr)}"]`;
        const xp = `//*[@name=${xpathLiteral(nameAttr)}]`;
        if (isUniqueCss(css)) pushLoc(locs, 'css', css);
        if (isUniqueXp(xp)) pushLoc(locs, 'xpath', xp);
    }

    // 4. Text-based (This is now prioritized)
    const text = getElementText(el);
    if (text){
        // Try exact match first
        const xp2 = `//${tag}[normalize-space(.)=${xpathLiteral(text)}]`;
        if (isUniqueXp(xp2)) pushLoc(locs, 'xpath', xp2);

        // Try contains match if exact fails or isn't unique
        const xp4 = `//${tag}[contains(normalize-space(.), ${xpathLiteral(text)})]`;
        if (isUniqueXp(xp4)) pushLoc(locs, 'xpath', xp4);
    }

    // 5. Anchored chain (Parent-Child)
    if (el.parentElement && window.findStableAncestor && window.buildChainedCss && window.buildChainedXpath){
        const anc = window.findStableAncestor(el, preferredDataAttrs);
        if (anc){
            // Build CSS and check it
            const css = window.buildChainedCss(anc.node, anc.css, el); 
            if (isUniqueCss(css)) {
                pushLoc(locs, 'css', css);
            }

            // Build XPath and check it
            const xp = window.buildChainedXpath(anc.node, anc.xpath, el);
            if (isUniqueXp(xp)) {
                 pushLoc(locs, 'xpath', xp);
            } else if (text) {
                // If text is available, try to refine the XPath
                const refinedXp = `${xp}[normalize-space(.)=${xpathLiteral(text)}]`;
                if (isUniqueXp(refinedXp)) {
                    pushLoc(locs, 'xpath', refinedXp);
                }
            }
        }
    }
    
    // 6. Simpler Parent Anchor (if anchors.js fails)
    const p = getParentAnchorLocator(el);
    if (p){
        if (p.xpath) pushLoc(locs, 'xpath', p.xpath);
        if (p.css && isUniqueCss(p.css)) pushLoc(locs, 'css', p.css);
    }

    // 7. Full class chain
    const className = (typeof el.className === 'string') ? el.className : '';
    if (className){
        const clean = className.trim().split(/\s+/).filter(c => !/[0-9]{5,}/.test(c));
        if (clean.length){
            const css = `${tag}.${clean.map(cssEsc).join('.')}`;
            if (isUniqueCss(css)) pushLoc(locs, 'css', css);
        }
    }

    // 8. href for anchors (**THIS IS THE FIX**)
    // Only add href locators if they are unique
    if (tag === 'a' && el.getAttribute('href')){
        const href = el.getAttribute('href');
        const css = `a[href="${cssEsc(href)}"]`;
        const xp = `//a[@href=${xpathLiteral(href)}]`;
        
        if (isUniqueCss(css)) {
            pushLoc(locs, 'css', css);
        }
        if (isUniqueXp(xp)) {
            pushLoc(locs, 'xpath', xp);
        }
    }
    // ** END OF FIX **

    // 9. Following-Sibling
    const sib = getFollowingSiblingXPath(el);
    if (sib) pushLoc(locs, 'xpath', sib);

    // 10. Absolute XPath (intentionally removed)


    // De-duplicate
    const out = []; const seen = new Set();
    for (const l of locs){
        if (!l || !l.value) continue;
        const k = l.type + '|' + l.value;
        if (!seen.has(k)){ out.push(l); seen.add(k); }
    }
    return out;
}

function pushLoc(arr, type, value){
    if (!value) return;
    const item = { type, value };
    if (window.scoreLocator) item.stability = window.scoreLocator(type, value);
    arr.push(item);
}

function getElementText(el){
    const direct = Array.from(el.childNodes).find(n => n.nodeType===Node.TEXT_NODE && n.textContent.trim().length>0);
    let text = null;
    if (direct) text = direct.textContent.trim();
    else if (el.textContent && el.children.length===0) text = el.textContent.trim();
    else if (el.textContent && el.textContent.trim().length < 50) text = el.textContent.trim().split('\n')[0].trim();
    if (text && text.length < 50 && !text.includes('\n')) return text;
    return null;
}

function getParentAnchorLocator(el){
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return null;
    const pt = parent.tagName.toLowerCase();
    const et = el.tagName.toLowerCase();
    const txt = getElementText(el);
    const cssEsc = CSS && CSS.escape ? CSS.escape : (s)=>s;
    let baseXp=null, baseCss=null;
    
    if (window.pickStableAttr) {
        const stable = window.pickStableAttr(parent, preferredDataAttrs);
        if (stable) {
            baseXp = buildXpathFromAttr(pt, stable.attr, stable.value);
            baseCss = buildCssFromAttr(pt, stable.attr, stable.value);
        }
    }

    if (baseXp && baseCss){
        let finalXp=null;
        if (txt){
            const withText = `${baseXp}//${et}[normalize-space(.)=${xpathLiteral(txt)}]`;
            if (isUniqueXp(withText)) finalXp = withText;
        }
        if (!finalXp){
            const tagOnly = `${baseXp}//${et}`;
            if (isUniqueXp(tagOnly)) finalXp = tagOnly;
        }
        return { xpath: finalXp, css: `${baseCss} > ${et}` };
    }
    return null;
}

function isUniqueCss(sel){
    if (window.cachedIsUniqueCss) return window.cachedIsUniqueCss(sel, document);
    try{ return document.querySelectorAll(sel).length === 1; }catch{ return false; }
}
function isUniqueXp(xp){
    if (window.cachedIsUniqueXpath) return window.cachedIsUniqueXpath(xp, document);
    try{
        const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return r.snapshotLength === 1;
    }catch{ return false; }
}
function buildXpathFromAttr(tag, attr, value){
    if (attr === 'id') return `//${tag}[@id=${xpathLiteral(value)}]`;
    if (attr === 'class'){
        const lit = xpathLiteral(' ' + value + ' ');
        return `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${lit})]`;
    }
    return `//${tag}[@${attr}=${xpathLiteral(value)}]`;
}
function buildCssFromAttr(tag, attr, value){
    if (attr === 'id') return `#${CSS.escape(value)}`;
    if (attr === 'class') return `${tag}.${CSS.escape(value)}`;
    return `${tag}[${attr}="${CSS.escape(value)}"]`;
}


function getFollowingSiblingXPath(el){
    let prev = el.previousElementSibling; 
    if (!prev) return null; 

    let count = 1;
    let anchorXp = null;

    while (prev) {
        const stable = window.pickStableAttr ? window.pickStableAttr(prev, preferredDataAttrs) : null;
        if (stable) {
            anchorXp = `${buildXpathFromAttr(prev.localName, stable.attr, stable.value)}/following-sibling::${el.tagName.toLowerCase()}[${count}]`;
            if (isUniqueXp(anchorXp)) return anchorXp;
        }
        
        const text = getElementText(prev);
        if (text){
            const tx = `//${prev.tagName.toLowerCase()}[normalize-space(.)=${xpathLiteral(text)}]/following-sibling::${el.tagName.toLowerCase()}[${count}]`;
            if (isUniqueXp(tx)) return tx;
        }

        if (prev.tagName === el.tagName) count++;
        prev = prev.previousElementSibling;
    }
    return null; 
}

function getAbsoluteXPath(el){
    let path = '';
    while (el && el.nodeType === Node.ELEMENT_NODE){
        let index=0, sib=el.previousSibling;
        while (sib){ if (sib.nodeType===Node.ELEMENT_NODE && sib.nodeName===el.nodeName) index++; sib=sib.previousSibling; }
        const tag = el.nodeName.toLowerCase();
        if (tag === 'html'){ path = '/html' + path; break; }
        const idx = (index>0) ? `[${index+1}]` : '';
        path = `/${tag}${idx}` + path;
        el = el.parentNode;
    }
    return path;
}

function getElementName(el){
    const tag = el.tagName.toLowerCase();
    if (['input','textarea','select'].includes(tag)){
        if (el.name) return el.name;
        if (el.id && !/[0-copy]{5,}/.test(el.id)) return el.id;
        if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    }
    let t = getElementText(el);
    if (t) return t;
    const full = (el.textContent||'').trim().split('\n')[0].trim();
    if (full.length>0 && full.length<30) return full;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.id && !/[0-9]{5,}/.test(el.id)) return el.id;
    if (el.name) return el.name;
    return 'Unnamed Element';
}

// ---------- Highlight API for sidepanel ----------
function highlightElement(locatorValue, locatorType){
    clearHoverHighlight();
    let el = null;
    try{
        if (locatorType === 'xpath' || locatorType === 'xpath-abs'){ 
            el = document.evaluate(locatorValue, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } else {
            const sel = (locatorType === 'id') ? `#${CSS.escape(locatorValue)}` : locatorValue;
            el = document.querySelector(sel);
        }
        if (el){
            currentHoverHighlight = getOrCreateElement('spy-hover-highlighter', currentHoverHighlight);

            // --- FIX: Create the arrow and append it ---
            let arrow = document.getElementById('spy-arrow');
            if (!arrow) {
                arrow = document.createElement('div');
                arrow.id = 'spy-arrow';
                // Append the arrow INSIDE the highlighter
                currentHoverHighlight.appendChild(arrow);
            }
            // --- END FIX ---

            const r = el.getBoundingClientRect();
            currentHoverHighlight.style.top = `${r.top + scrollY}px`;
            currentHoverHighlight.style.left = `${r.left + scrollX}px`;
            currentHoverHighlight.style.width = `${r.width}px`;
            currentHoverHighlight.style.height = `${r.height}px`;
            currentHoverHighlight.style.display = 'block'; 
            el.scrollIntoView({ behavior:'smooth', block:'center' });
        }
    }catch(e){ console.error('Error highlighting:', e); }
}
function clearHoverHighlight(){
    if (currentHoverHighlight) {
        currentHoverHighlight.style.display = 'none'; 
    }
}
function showToast(message){
    try{
        currentToast = getOrCreateElement('spy-toast-notification', currentToast);
        currentToast.textContent = message;
        currentToast.style.opacity = '1'; 
        setTimeout(()=>{ 
            if (currentToast) {
                currentToast.style.opacity = '0';
            }
        }, 1500); 
    }catch(e){ console.error('Error showing toast:', e); }
}

// ---------- Navigation Awareness (full loads + SPA) ----------
function rearmAutoSpy(){
    if (!isAutoSpying) return;
    try {
        if (autoSpyObserver){ autoSpyObserver.disconnect(); autoSpyObserver = null; }
    } catch {}
    runAutoSpy().catch(()=>{});
    autoSpyObserver = new MutationObserver(handleDomChanges);
    try { autoSpyObserver.observe(document.documentElement, { childList:true, subtree:true }); } catch {}
}
(function(history){
    if (!history || history.__xpathSpyWrapped) return;
    const wrap = (type) => {
        const orig = history[type];
        return function(){
            const rv = orig.apply(this, arguments);
            try { window.dispatchEvent(new Event('locationchange')); } catch {}
            return rv;
        };
    };
    history.pushState = wrap('pushState');
    history.replaceState = wrap('replaceState');
    history.__xpathSpyWrapped = true;
})(window.history);
window.addEventListener('locationchange', () => { rearmAutoSpy(); });
window.addEventListener('popstate', () => { rearmAutoSpy(); });
window.addEventListener('hashchange', () => { rearmAutoSpy(); });
window.addEventListener('pageshow', () => { rearmAutoSpy(); });
document.addEventListener('DOMContentLoaded', () => { rearmAutoSpy(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearmAutoSpy(); });

// ---------- Message Listener (verify handled by verify_api.js ONLY) ----------
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    (async ()=>{
        try{
            if (req.action === 'ping') {
                sendResponse({ status: 'pong' });
            } else if (req.action === 'toggle-spy'){
                await toggleManualSpy(req.isSpying); 
                sendResponse({ status:'success', isSpying });
            } else if (req.action === 'toggle-auto-spy'){
                const c = await toggleAutoSpy(req.isAutoSpying); 
                sendResponse({ status:'success', isAutoSpying, count:c });
            } else if (req.action === 'highlight-element-in-tab'){
                if (req.locator) highlightElement(req.locator.value, req.locator.type);
                sendResponse({ status:'highlighted' });
            } else if (req.action === 'clear-highlight'){
                clearHoverHighlight(); 
                sendResponse({ status:'cleared' });
            } else {
                // Allow other listeners (like verify_api.js) to handle this
            }
        }catch(e){ 
            console.error("Error in content_script listener:", e);
            sendResponse({ status:'error', message:e.message }); 
        }
    })();
    return true; // Return true to indicate async response
});

