// This worker only handles the curated, installed Horizon game.
// No unrestricted proxying or arbitrary network forwarding.
const CACHE="seuss-horizon-game-v1";
const root=new URL(self.registration.scope);
const play=new URL("play.html",root);
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("message",event=>{if(event.data==="SKIP_WAITING")self.skipWaiting();});
function isolated(response){
 if(!response||response.type==="opaque"||response.type==="opaqueredirect")return response;
 const headers=new Headers(response.headers);
 headers.set("Cross-Origin-Opener-Policy","same-origin");
 headers.set("Cross-Origin-Embedder-Policy","credentialless");
 headers.set("X-Content-Type-Options","nosniff");
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
self.addEventListener("fetch",event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=="GET"||url.origin!==root.origin)return;
 if(url.pathname===play.pathname){
  event.respondWith((async()=>{
   const saved=await(await caches.open(CACHE)).match(play.href);
   if(!saved)return Response.redirect(new URL("index.html",root),302);
   return isolated(saved);
  })());return;
 }
 if(event.request.mode==="navigate"&&url.pathname.startsWith(root.pathname)){
  event.respondWith(fetch(event.request).then(isolated));
 }
});