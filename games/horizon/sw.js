// Only the locally hosted Horizon pages receive isolation headers.
// No general HTTP proxy or arbitrary URL rewriting.
const root=new URL(self.registration.scope);
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=="GET"||event.request.mode!=="navigate"||url.origin!==root.origin)return;
 if(url.pathname!==root.pathname+"index.html"&&url.pathname!==root.pathname+"play.html")return;
 event.respondWith(fetch(event.request).then(response=>{
   if(!response||!response.ok||response.type==="opaque")return response;
   const headers=new Headers(response.headers);
   headers.set("Cross-Origin-Opener-Policy","same-origin");
   headers.set("Cross-Origin-Embedder-Policy","credentialless");
   headers.set("X-Content-Type-Options","nosniff");
   return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }));
});