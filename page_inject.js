// page_inject.js - runs in page context (MAIN world)
(function(){
  try{
    if (window.__pageInjectInstalled) return; window.__pageInjectInstalled = true;
    window.__capturedRequests = window.__capturedRequests || [];
    window.__blobUrlToSrc = window.__blobUrlToSrc || {};

    function pushCapture(url){
      try{
        if (!url) return;
        const entry = { url: String(url), t: Date.now() };
        window.__capturedRequests.push(entry);
        if (window.__capturedRequests.length > 300) window.__capturedRequests.shift();
        window.postMessage({ __CAPTURE_PUSH: entry }, '*');
      }catch(e){}
    }

    // Wrap fetch to capture requested URLs
    try{
      const _fetch = window.fetch;
      window.fetch = function(input, init){
        try{ const reqUrl = (input && input.url) ? input.url : input; pushCapture(reqUrl); }catch(e){}
        const p = _fetch.apply(this, arguments);
        p.then(r => { try{ pushCapture(r && r.url ? r.url : null); }catch(e){} });
        return p;
      };
    }catch(e){}

    // Wrap XHR to capture URLs
    try{
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url){
        try{ this.__reqUrl = url; pushCapture(url); }catch(e){}
        return _open.apply(this, arguments);
      };
      const _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(){
        try{ this.addEventListener('load', function(){ try{ pushCapture(this.responseURL || this.__reqUrl); }catch(e){} }); }catch(e){}
        return _send.apply(this, arguments);
      };
    }catch(e){}

    // Wrap URL.createObjectURL to map blob: -> last recent capture
    try{
      const _create = URL.createObjectURL;
      if (typeof _create !== 'function') throw new Error('URL.createObjectURL unavailable');
      URL.createObjectURL = function(obj){
        const blobUrl = _create.apply(this, arguments);
        try{
          const now = Date.now();
          const recent = (window.__capturedRequests || []).slice(-40).reverse().find(x => x && (now - x.t) < 8000 && x.url);
          if (recent) {
            try{ window.__blobUrlToSrc[blobUrl] = recent.url; }catch(e){}
            try{ window.postMessage({ __BLOB_MAP: (function(){ const m = {}; m[blobUrl] = recent.url; return m; })() }, '*'); }catch(e){}
          }
        }catch(e){}
        return blobUrl;
      };
    }catch(e){}

    // expose a small helper to resolve a blob URL synchronously
    try{ window.__resolveBlob = function(b){ return (window.__blobUrlToSrc && window.__blobUrlToSrc[b]) || null; }; }catch(e){}

    // respond to explicit resolve requests from content script via postMessage
    try{
      window.addEventListener('message', (ev) => {
        try{
          const d = ev && ev.data;
          if (!d) return;
          if (d.__RESOLVE_BLOB) {
            const b = d.__RESOLVE_BLOB;
            const mapped = (window.__blobUrlToSrc && window.__blobUrlToSrc[b]) || null;
            if (mapped) {
              window.postMessage({ __BLOB_MAP: (function(){ const m = {}; m[b] = mapped; return m; })() }, '*');
            } else {
              // try to find a recent captured request as a fallback
              const now = Date.now();
              const recent = (window.__capturedRequests || []).slice(-60).reverse().find(x => x && (now - x.t) < 10000 && x.url);
              if (recent) {
                window.__blobUrlToSrc[b] = recent.url;
                window.postMessage({ __BLOB_MAP: (function(){ const m = {}; m[b] = recent.url; return m; })() }, '*');
              }
            }
          }
        }catch(e){}
      }, false);
    }catch(e){}

    console.log('[page_inject] installed');
  }catch(e){console.warn('[page_inject] error', e);} 
})();
